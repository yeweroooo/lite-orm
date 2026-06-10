const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'bin', 'lite-orm.js');
const pkg = require('../package.json');

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('CLI usage lists doctor command', () => {
  const res = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /lite-orm commands:/);
  assert.match(res.stdout, /\bdoctor\b/);
});

test('CLI doctor reports environment and native SQLite features', () => {
  const res = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8' });

  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.equal(res.stderr, '');
  assert.match(res.stdout, /^lite-orm doctor/m);
  assert.match(res.stdout, /OK\s+node\s+v\d+\.\d+\.\d+ \(requires >=18\)/);
  assert.match(res.stdout, new RegExp(`OK\\s+package\\s+${escapeRegExp(pkg.name)}@${escapeRegExp(pkg.version)}`));
  assert.match(res.stdout, new RegExp(`OK\\s+platform\\s+${escapeRegExp(process.platform)} ${escapeRegExp(process.arch)}`));
  assert.match(res.stdout, /OK\s+native addon\s+loaded/);
  assert.match(res.stdout, /OK\s+sqlite\s+\d+\.\d+\.\d+/);
  assert.match(res.stdout, /OK\s+json1\s+available/);
  assert.match(res.stdout, /OK\s+fts5\s+available/);
  assert.match(res.stdout, new RegExp(`OK\\s+temp dir\\s+writable \\(${escapeRegExp(os.tmpdir())}\\)`));
  assert.match(res.stdout, /All checks passed/);
});

test('CLI doctor reports native addon load failure without crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-orm-doctor-broken-'));
  const binDir = path.join(dir, 'bin');
  const libDir = path.join(dir, 'lib');

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.copyFileSync(cli, path.join(binDir, 'lite-orm.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: pkg.name,
    version: '0.0.0-test',
    engines: { node: '>=18' },
    os: [process.platform],
    cpu: [process.arch]
  }, null, 2));
  fs.writeFileSync(path.join(libDir, 'index.js'), "throw new Error('simulated native load failure');\n");

  const res = spawnSync(process.execPath, [path.join(binDir, 'lite-orm.js'), 'doctor'], { encoding: 'utf8' });

  assert.equal(res.status, 1);
  assert.match(res.stdout, /^lite-orm doctor/m);
  assert.match(res.stdout, /OK\s+node\s+/);
  assert.match(res.stdout, /OK\s+package\s+@ghuts\/liteorm@0\.0\.0-test/);
  assert.match(res.stdout, /OK\s+platform\s+/);
  assert.match(res.stdout, /FAIL\s+native addon\s+simulated native load failure/);
  assert.match(res.stdout, /SKIP\s+sqlite\s+native addon unavailable/);
  assert.match(res.stdout, /SKIP\s+json1\s+native addon unavailable/);
  assert.match(res.stdout, /SKIP\s+fts5\s+native addon unavailable/);
  assert.match(res.stdout, /Doctor found 1 issue\(s\)/);
});

test('CLI doctor fails when temp directory is not writable or missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-orm-doctor-tmp-'));
  const missingTmp = path.join(dir, 'missing', 'tmp');
  const env = { ...process.env, TMPDIR: missingTmp, TMP: missingTmp, TEMP: missingTmp };
  const res = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8', env });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^lite-orm doctor/m);
  assert.match(res.stdout, /FAIL\s+temp dir\s+/);
  assert.match(res.stdout, /Doctor found 1 issue\(s\)/);
});
