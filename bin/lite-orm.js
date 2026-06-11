#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function usage() {
  console.log(`lite-orm commands:\n  inspect <dbfile>\n  studio <dbfile> --exec <sql>\n  export:json <dbfile> <table> <file>\n  make:migration <name> [--dir <dir>]\n  generate model <Name> --fields name:string,email:string\n  generate migration <name> [--dir <dir>]\n  migrate <dbfile> [--dir <dir>]\n  migrate:status <dbfile> [--dir <dir>]\n  migrate:rollback <dbfile> [--dir <dir>] [--steps n]\n  migrate:preview <dbfile> [--dir <dir>]\n  migrate:seed <dbfile> [--dir <dir>]\n  init [dir]\n  doctor`);
}
function loadOrm() { return require('../lib'); }
function openDatabase(file) { const { Database } = loadOrm(); return new Database(file); }
function readPackage() { try { return require('../package.json'); } catch (err) { return { _error: err }; } }
function oneLineError(err) { return String((err && err.message) || err).split(/\r?\n/)[0]; }
function parseVersion(v) { return String(v).replace(/^v/, '').split('.').map(n => Number(n) || 0); }
function satisfiesMinimumNode(range, current = process.versions.node) { const match = String(range || '').match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/); if (!match) return true; const min = [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)]; const cur = parseVersion(current); for (let i = 0; i < 3; i++) if ((cur[i] || 0) !== min[i]) return (cur[i] || 0) > min[i]; return true; }
function listAllows(list, value) { if (!Array.isArray(list) || list.length === 0) return true; if (list.includes(`!${value}`)) return false; const positive = list.filter(v => !String(v).startsWith('!')); return positive.length === 0 || positive.includes(value); }

function runDoctor() {
  const checks = []; const record = (status, name, detail) => checks.push({ status, name, detail }); const pkg = readPackage(); const nodeRange = pkg.engines?.node || '>=18';
  record(satisfiesMinimumNode(nodeRange) ? 'OK' : 'FAIL', 'node', `v${process.versions.node} (requires ${nodeRange})`);
  if (pkg._error) record('FAIL', 'package', oneLineError(pkg._error)); else record(pkg.name && pkg.version ? 'OK' : 'FAIL', 'package', `${pkg.name || 'unknown'}@${pkg.version || 'unknown'}`);
  const platformOk = listAllows(pkg.os, process.platform) && listAllows(pkg.cpu, process.arch);
  record(platformOk ? 'OK' : 'FAIL', 'platform', `${process.platform} ${process.arch} (supported os: ${Array.isArray(pkg.os) && pkg.os.length ? pkg.os.join(',') : 'any'}; cpu: ${Array.isArray(pkg.cpu) && pkg.cpu.length ? pkg.cpu.join(',') : 'any'})`);
  let orm = null; try { orm = loadOrm(); if (!orm || typeof orm.Database !== 'function') throw new Error('Database export unavailable'); record('OK', 'native addon', 'loaded'); } catch (err) { record('FAIL', 'native addon', oneLineError(err)); }
  let db = null;
  if (orm && typeof orm.Database === 'function') {
    try { db = new orm.Database(':memory:'); const sqliteVersion = orm.sqliteVersion || db.query('SELECT sqlite_version() AS version')[0]?.version; record(sqliteVersion ? 'OK' : 'FAIL', 'sqlite', sqliteVersion || 'version unavailable'); } catch (err) { record('FAIL', 'sqlite', oneLineError(err)); }
    if (db) {
      try { const row = db.query('SELECT json_valid(\'{"lite":true}\') AS ok')[0]; record(Number(row.ok) === 1 ? 'OK' : 'FAIL', 'json1', Number(row.ok) === 1 ? 'available' : `json_valid returned ${row.ok}`); } catch (err) { record('FAIL', 'json1', oneLineError(err)); }
      try { db.exec('CREATE VIRTUAL TABLE __lite_orm_doctor_fts USING fts5(content)'); db.exec('DROP TABLE __lite_orm_doctor_fts'); record('OK', 'fts5', 'available'); } catch (err) { record('FAIL', 'fts5', oneLineError(err)); }
    } else { record('SKIP', 'json1', 'database unavailable'); record('SKIP', 'fts5', 'database unavailable'); }
  } else { record('SKIP', 'sqlite', 'native addon unavailable'); record('SKIP', 'json1', 'native addon unavailable'); record('SKIP', 'fts5', 'native addon unavailable'); }
  try { if (db) db.close(); } catch (_) {}
  let tempDir = null; try { const base = os.tmpdir(); tempDir = fs.mkdtempSync(path.join(base, 'lite-orm-doctor-')); fs.writeFileSync(path.join(tempDir, 'write-test.txt'), 'ok'); record('OK', 'temp dir', `writable (${base})`); } catch (err) { record('FAIL', 'temp dir', oneLineError(err)); } finally { if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {} } }
  console.log('lite-orm doctor'); for (const check of checks) console.log(`${check.status.padEnd(4)} ${check.name.padEnd(13)} ${check.detail}`); const failures = checks.filter(c => c.status === 'FAIL').length; if (failures) { console.log(`Doctor found ${failures} issue(s)`); process.exitCode = 1; } else console.log('All checks passed');
}

function stamp() { const d = new Date(); const pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }
function flag(args, name, fallback = null) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; }
function safeName(s) { return String(s).replace(/[^A-Za-z0-9_]+/g, '_'); }
function plural(name) { const s = safeName(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(); return s.endsWith('s') ? s : s + 's'; }
function parseFields(spec) { if (!spec) return []; return String(spec).split(',').filter(Boolean).map(p => { const [name, type = 'text'] = p.split(':'); return { name: safeName(name), type: type === 'string' ? 'text' : type }; }); }
function fieldLine(f) { if (f.name === 'id') return "    t.increments('id');"; const m = { integer: 'integer', int: 'integer', number: 'integer', text: 'text', string: 'text', real: 'real', float: 'real', json: 'json', boolean: 'boolean', bool: 'boolean' }; return `    t.${m[f.type] || 'text'}('${f.name}');`; }
function modelFieldLine(f) { const m = { integer: 'integer', int: 'integer', number: 'integer', text: 'text', string: 'text', real: 'real', float: 'real', json: 'json', boolean: 'boolean', bool: 'boolean' }; return `    ${f.name}: field.${m[f.type] || 'text'}()`; }
function loadMigrations(dir) { if (!fs.existsSync(dir)) return []; return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort().map(file => { const m = require(path.resolve(dir, file)); return { id: m.id || path.basename(file, '.js'), ...m }; }); }
function ensureMigrationTable(db) { db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'); }
function migrationStatus(db, migrations) { ensureMigrationTable(db); const applied = new Set(db.query('SELECT id FROM _migrations').map(r => r.id)); return migrations.map(m => ({ id: m.id, status: applied.has(m.id) ? 'APPLIED' : 'PENDING' })); }

function generateModel(args) {
  const name = args[0]; if (!name) throw new Error('model name required'); const fields = parseFields(flag(args, '--fields', ''));
  const table = plural(name); const modelDir = path.join(process.cwd(), 'models'); const migDir = path.join(process.cwd(), 'migrations'); fs.mkdirSync(modelDir, { recursive: true }); fs.mkdirSync(migDir, { recursive: true });
  const modelFile = path.join(modelDir, `${name}.js`); const allFields = [{ name: 'id', type: 'integer' }, ...fields];
  fs.writeFileSync(modelFile, `'use strict';\nconst { defineModel, field } = require('@ghuts/liteorm');\n\nmodule.exports = db => defineModel(db, '${table}', {\n  fields: {\n${allFields.map(modelFieldLine).join(',\n')}\n  }\n});\n`);
  const mig = path.join(migDir, `${stamp()}_create_${table}.js`);
  fs.writeFileSync(mig, `'use strict';\nmodule.exports = {\n  id: 'create_${table}',\n  up(db) {\n    db.schema.createTable('${table}', t => {\n      t.increments('id');\n${fields.map(fieldLine).join('\n')}\n      t.timestamps();\n    });\n  },\n  down(db) { db.schema.dropTable('${table}'); }\n};\n`);
  console.log(modelFile); console.log(mig);
}

function previewMigrations(migrations) {
  const statements = [];
  const fake = { exec(sql, params) { statements.push(params && params.length ? `${sql} -- ${JSON.stringify(params)}` : sql); return { changes: 0, lastInsertRowid: 0 }; } };
  fake.schema = { createTable(name, fn) { const cols = []; const t = new Proxy({}, { get(_, prop) { if (prop === 'timestamps') return () => { cols.push('created_at TEXT', 'updated_at TEXT'); return t; }; return (col) => { cols.push(`${col} ${String(prop).toUpperCase()}`); return { notNull(){return this}, unique(){return this}, default(){return this}, nullable(){return this}, references(){return this} }; }; } }); fn(t); statements.push(`CREATE TABLE ${name} (${cols.join(', ')})`); }, dropTable(name) { statements.push(`DROP TABLE ${name}`); } };
  for (const m of migrations) if (m.up) m.up(fake);
  return statements;
}

const [,, cmd, ...args] = process.argv;
try {
  if (cmd === 'inspect') {
    const file = args[0]; if (!file) throw new Error('dbfile required'); const db = openDatabase(file); for (const table of db.inspect.tables()) { console.log(table); for (const c of db.inspect.columns(table)) console.log(`  ${c.name}|${c.type}|notnull=${c.notnull}|pk=${c.pk}`); } db.close();
  } else if (cmd === 'studio') {
    const file = args[0]; const execIdx = args.indexOf('--exec'); if (!file || execIdx < 0) throw new Error('usage: studio <dbfile> --exec <sql>'); const db = openDatabase(file); const rows = db.query(args.slice(execIdx + 1).join(' ')); console.log(JSON.stringify(rows)); db.close();
  } else if (cmd === 'export:json') {
    const [file, table, out] = args; if (!file || !table || !out) throw new Error('usage: export:json <dbfile> <table> <file>'); const db = openDatabase(file); db.export.json(table, out); db.close(); console.log(out);
  } else if (cmd === 'make:migration' || (cmd === 'generate' && args[0] === 'migration')) {
    const name = cmd === 'generate' ? args[1] : args[0]; if (!name) throw new Error('migration name required'); const dir = flag(args, '--dir', path.join(process.cwd(), 'migrations')); fs.mkdirSync(dir, { recursive: true }); const safe = safeName(name); const file = path.join(dir, `${stamp()}_${safe}.js`); fs.writeFileSync(file, `'use strict';\n\nmodule.exports = {\n  id: '${safe}',\n  up(db) {\n    // db.schema.createTable('table_name', t => { t.increments('id'); });\n  },\n  down(db) {\n    // db.schema.dropTable('table_name');\n  }\n};\n`); console.log(file);
  } else if (cmd === 'generate' && args[0] === 'model') {
    generateModel(args.slice(1));
  } else if (cmd === 'migrate' || cmd === 'migrate:status' || cmd === 'migrate:rollback' || cmd === 'migrate:preview') {
    const file = args[0]; if (!file) throw new Error('dbfile required'); const dir = flag(args, '--dir', path.join(process.cwd(), 'migrations')); const migrations = loadMigrations(dir);
    if (cmd === 'migrate:preview') { for (const s of previewMigrations(migrations)) console.log(s); }
    else { const db = openDatabase(file); db.migrations = migrations; if (cmd === 'migrate:status') { for (const s of migrationStatus(db, migrations)) console.log(`${s.status} ${s.id}`); } else if (cmd === 'migrate:rollback') { ensureMigrationTable(db); const steps = Number(flag(args, '--steps', '1')); const rolled = db.rollbackMigrations(steps); for (const id of rolled) console.log(`ROLLED_BACK ${id}`); } else { const ran = db.migrate(migrations); for (const id of ran) console.log(`APPLIED ${id}`); } db.close(); }
  } else if (cmd === 'migrate:seed') {
    const file = args[0]; if (!file) throw new Error('dbfile required'); const dir = flag(args, '--dir', path.join(process.cwd(), 'seeders')); const db = openDatabase(file); const seeds = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort() : []; for (const fileName of seeds) { const fn = require(path.resolve(dir, fileName)); if (typeof fn === 'function') fn(db); else if (fn.run) fn.run(db); console.log(`SEEDED ${path.basename(fileName, '.js')}`); } db.close();
  } else if (cmd === 'init') {
    const dir = args[0] || process.cwd(); fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true }); fs.mkdirSync(path.join(dir, 'models'), { recursive: true }); const cfg = path.join(dir, 'orm.config.js'); if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, `module.exports = { database: 'app.sqlite', migrations: './migrations', seeders: './seeders' };\n`); console.log(cfg);
  } else if (cmd === 'doctor') runDoctor(); else { usage(); process.exit(cmd ? 1 : 0); }
} catch (err) { console.error(err.message); process.exit(1); }
