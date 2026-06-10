const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function runNode(file) {
  return spawnSync(process.execPath, [path.join(root, file)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, LITEORM_DB: ':memory:' }
  });
}

test('v1.1 professional release files exist and package includes docs/examples', () => {
  const required = [
    '.github/workflows/ci.yml',
    '.github/workflows/publish.yml',
    'docs/v1.1.md',
    'docs/examples.md',
    'docs/package-readiness.md',
    'examples/README.md',
    'examples/todo/index.js',
    'examples/blog/index.js',
    'examples/auth/index.js'
  ];
  for (const file of required) assert.equal(fs.existsSync(path.join(root, file)), true, `${file} missing`);

  const pkg = require('../package.json');
  assert.equal(pkg.version, '1.1.0');
  assert.ok(pkg.files.includes('examples/'));
  assert.ok(pkg.files.includes('docs/'));
  assert.ok(pkg.files.includes('deps/sqlite/'));
  assert.equal(pkg.scripts['test:examples'], 'node examples/todo/index.js && node examples/blog/index.js && node examples/auth/index.js');
});

test('GitHub workflows contain CI matrix, smoke install and npm provenance publish', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /node:\s*\[18, 20, 22, 24\]/);
  assert.match(ci, /os:\s*\[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(ci, /Smoke install packed package/);
  assert.match(ci, /@ghuts\/liteorm/);

  const publish = fs.readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8');
  assert.match(publish, /id-token:\s*write/);
  assert.match(publish, /npm publish --provenance --access public/);
  assert.match(publish, /NPM_TOKEN/);
});

test('examples run successfully and print deterministic JSON summaries', () => {
  const cases = [
    ['examples/todo/index.js', ['project', 'openTasks', 'doneTasks', 'highPriority', 'softDeletedHidden']],
    ['examples/blog/index.js', ['author', 'publishedPosts', 'firstPostTags', 'searchResults', 'commentsCount']],
    ['examples/auth/index.js', ['signup', 'login', 'hasAdminRole', 'sessionValid', 'auditRows']]
  ];
  for (const [file, keys] of cases) {
    const res = runNode(file);
    assert.equal(res.status, 0, `${file}\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`);
    const json = JSON.parse(res.stdout.trim());
    for (const key of keys) assert.ok(Object.hasOwn(json, key), `${file} missing ${key}`);
  }
});
