const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'bin', 'lite-orm.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'liteorm-cli-updates-'));
}

function run(args, opts = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...opts });
}

test('CLI scaffolds models, migrations and previews migration SQL', () => {
  const dir = tmp();
  let res = run(['generate', 'model', 'User', '--fields', 'name:string,email:string,age:integer,json:json'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.equal(fs.existsSync(path.join(dir, 'models', 'User.js')), true);
  assert.match(fs.readFileSync(path.join(dir, 'models', 'User.js'), 'utf8'), /defineModel\(db, 'users'/);
  const migrations = fs.readdirSync(path.join(dir, 'migrations')).filter(f => f.endsWith('_create_users.js'));
  assert.equal(migrations.length, 1);

  const dbfile = path.join(dir, 'app.sqlite');
  res = run(['migrate:preview', dbfile, '--dir', path.join(dir, 'migrations')], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /CREATE TABLE/);
  assert.match(res.stdout, /users/);
});

test('CLI migration status, seed and rollback operate on project files', () => {
  const dir = tmp();
  const migDir = path.join(dir, 'migrations');
  const seedDir = path.join(dir, 'seeders');
  fs.mkdirSync(migDir, { recursive: true });
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(path.join(migDir, '001_create_items.js'), `module.exports = { id: '001_create_items', up(db) { db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)'); }, down(db) { db.exec('DROP TABLE items'); } };\n`);
  fs.writeFileSync(path.join(seedDir, '001_items.js'), `module.exports = db => { db.exec("INSERT INTO items(name) VALUES('seeded')"); };\n`);
  const dbfile = path.join(dir, 'app.sqlite');

  let res = run(['migrate:status', dbfile, '--dir', migDir], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /PENDING\s+001_create_items/);

  res = run(['migrate', dbfile, '--dir', migDir], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /APPLIED\s+001_create_items/);

  res = run(['migrate:seed', dbfile, '--dir', seedDir], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /SEEDED\s+001_items/);

  res = run(['studio', dbfile, '--exec', 'SELECT name FROM items'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.deepEqual(JSON.parse(res.stdout), [{ name: 'seeded' }]);

  res = run(['migrate:status', dbfile, '--dir', migDir], { cwd: dir });
  assert.match(res.stdout, /APPLIED\s+001_create_items/);

  res = run(['migrate:rollback', dbfile, '--dir', migDir, '--steps', '1'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /ROLLED_BACK\s+001_create_items/);

  res = run(['migrate:status', dbfile, '--dir', migDir], { cwd: dir });
  assert.match(res.stdout, /PENDING\s+001_create_items/);
});
