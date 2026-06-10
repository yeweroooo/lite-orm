#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function usage() {
  console.log(`lite-orm commands:\n  inspect <dbfile>\n  studio <dbfile> --exec <sql>\n  export:json <dbfile> <table> <file>\n  make:migration <name> [--dir <dir>]\n  init [dir]\n  doctor`);
}

function loadOrm() {
  return require('../lib');
}

function openDatabase(file) {
  const { Database } = loadOrm();
  return new Database(file);
}

function readPackage() {
  try {
    return require('../package.json');
  } catch (err) {
    return { _error: err };
  }
}

function oneLineError(err) {
  return String((err && err.message) || err).split(/\r?\n/)[0];
}

function parseVersion(v) {
  return String(v).replace(/^v/, '').split('.').map(n => Number(n) || 0);
}

function satisfiesMinimumNode(range, current = process.versions.node) {
  const match = String(range || '').match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return true;
  const min = [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
  const cur = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((cur[i] || 0) !== min[i]) return (cur[i] || 0) > min[i];
  }
  return true;
}

function listAllows(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (list.includes(`!${value}`)) return false;
  const positive = list.filter(v => !String(v).startsWith('!'));
  return positive.length === 0 || positive.includes(value);
}

function runDoctor() {
  const checks = [];
  const record = (status, name, detail) => checks.push({ status, name, detail });
  const pkg = readPackage();

  const nodeRange = pkg.engines?.node || '>=18';
  record(
    satisfiesMinimumNode(nodeRange) ? 'OK' : 'FAIL',
    'node',
    `v${process.versions.node} (requires ${nodeRange})`
  );

  if (pkg._error) {
    record('FAIL', 'package', oneLineError(pkg._error));
  } else {
    const name = pkg.name || 'unknown';
    const version = pkg.version || 'unknown';
    record(pkg.name && pkg.version ? 'OK' : 'FAIL', 'package', `${name}@${version}`);
  }

  const platformOk = listAllows(pkg.os, process.platform) && listAllows(pkg.cpu, process.arch);
  const supportedOs = Array.isArray(pkg.os) && pkg.os.length ? pkg.os.join(',') : 'any';
  const supportedCpu = Array.isArray(pkg.cpu) && pkg.cpu.length ? pkg.cpu.join(',') : 'any';
  record(
    platformOk ? 'OK' : 'FAIL',
    'platform',
    `${process.platform} ${process.arch} (supported os: ${supportedOs}; cpu: ${supportedCpu})`
  );

  let orm = null;
  try {
    orm = loadOrm();
    if (!orm || typeof orm.Database !== 'function') throw new Error('Database export unavailable');
    record('OK', 'native addon', 'loaded');
  } catch (err) {
    record('FAIL', 'native addon', oneLineError(err));
  }

  let db = null;
  if (orm && typeof orm.Database === 'function') {
    try {
      db = new orm.Database(':memory:');
      const sqliteVersion = orm.sqliteVersion || db.query('SELECT sqlite_version() AS version')[0]?.version;
      record(sqliteVersion ? 'OK' : 'FAIL', 'sqlite', sqliteVersion || 'version unavailable');
    } catch (err) {
      record('FAIL', 'sqlite', oneLineError(err));
    }

    if (db) {
      try {
        const row = db.query('SELECT json_valid(\'{"lite":true}\') AS ok')[0];
        record(Number(row.ok) === 1 ? 'OK' : 'FAIL', 'json1', Number(row.ok) === 1 ? 'available' : `json_valid returned ${row.ok}`);
      } catch (err) {
        record('FAIL', 'json1', oneLineError(err));
      }

      try {
        db.exec('CREATE VIRTUAL TABLE __lite_orm_doctor_fts USING fts5(content)');
        db.exec('DROP TABLE __lite_orm_doctor_fts');
        record('OK', 'fts5', 'available');
      } catch (err) {
        record('FAIL', 'fts5', oneLineError(err));
      }
    } else {
      record('SKIP', 'json1', 'database unavailable');
      record('SKIP', 'fts5', 'database unavailable');
    }
  } else {
    record('SKIP', 'sqlite', 'native addon unavailable');
    record('SKIP', 'json1', 'native addon unavailable');
    record('SKIP', 'fts5', 'native addon unavailable');
  }

  try { if (db) db.close(); } catch (_) {}

  let tempDir = null;
  try {
    const base = os.tmpdir();
    tempDir = fs.mkdtempSync(path.join(base, 'lite-orm-doctor-'));
    const file = path.join(tempDir, 'write-test.txt');
    fs.writeFileSync(file, 'ok');
    record('OK', 'temp dir', `writable (${base})`);
  } catch (err) {
    record('FAIL', 'temp dir', oneLineError(err));
  } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  console.log('lite-orm doctor');
  for (const check of checks) {
    console.log(`${check.status.padEnd(4)} ${check.name.padEnd(13)} ${check.detail}`);
  }

  const failures = checks.filter(c => c.status === 'FAIL').length;
  if (failures) {
    console.log(`Doctor found ${failures} issue(s)`);
    process.exitCode = 1;
  } else {
    console.log('All checks passed');
  }
}

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const [,, cmd, ...args] = process.argv;
try {
  if (cmd === 'inspect') {
    const file = args[0];
    if (!file) throw new Error('dbfile required');
    const db = openDatabase(file);
    for (const table of db.inspect.tables()) {
      console.log(table);
      for (const c of db.inspect.columns(table)) console.log(`  ${c.name}|${c.type}|notnull=${c.notnull}|pk=${c.pk}`);
    }
    db.close();
  } else if (cmd === 'studio') {
    const file = args[0];
    const execIdx = args.indexOf('--exec');
    if (!file || execIdx < 0) throw new Error('usage: studio <dbfile> --exec <sql>');
    const db = openDatabase(file);
    const rows = db.query(args.slice(execIdx + 1).join(' '));
    console.log(JSON.stringify(rows));
    db.close();
  } else if (cmd === 'export:json') {
    const [file, table, out] = args;
    if (!file || !table || !out) throw new Error('usage: export:json <dbfile> <table> <file>');
    const db = openDatabase(file);
    db.export.json(table, out);
    db.close();
    console.log(out);
  } else if (cmd === 'make:migration') {
    const name = args[0];
    if (!name) throw new Error('migration name required');
    const dirFlag = args.indexOf('--dir');
    const dir = dirFlag >= 0 ? args[dirFlag + 1] : path.join(process.cwd(), 'migrations');
    fs.mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[^A-Za-z0-9_]+/g, '_');
    const file = path.join(dir, `${stamp()}_${safe}.js`);
    fs.writeFileSync(file, `'use strict';\n\n// ${safe}\nmodule.exports = {\n  id: '${safe}',\n  up(db) {\n    // db.schema.createTable('table_name', t => {\n    //   t.increments('id');\n    // });\n  },\n  down(db) {\n    // db.schema.dropTable('table_name');\n  }\n};\n`);
    console.log(file);
  } else if (cmd === 'init') {
    const dir = args[0] || process.cwd();
    fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
    const cfg = path.join(dir, 'orm.config.js');
    if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, `module.exports = { database: 'app.sqlite', migrations: './migrations' };\n`);
    console.log(cfg);
  } else if (cmd === 'doctor') {
    runDoctor();
  } else {
    usage();
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
