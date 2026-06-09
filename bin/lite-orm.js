#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Database } = require('../lib');

function usage() {
  console.log(`lite-orm commands:\n  inspect <dbfile>\n  studio <dbfile> --exec <sql>\n  export:json <dbfile> <table> <file>\n  make:migration <name> [--dir <dir>]\n  init [dir]`);
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
    const db = new Database(file);
    for (const table of db.inspect.tables()) {
      console.log(table);
      for (const c of db.inspect.columns(table)) console.log(`  ${c.name}|${c.type}|notnull=${c.notnull}|pk=${c.pk}`);
    }
    db.close();
  } else if (cmd === 'studio') {
    const file = args[0];
    const execIdx = args.indexOf('--exec');
    if (!file || execIdx < 0) throw new Error('usage: studio <dbfile> --exec <sql>');
    const db = new Database(file);
    const rows = db.query(args.slice(execIdx + 1).join(' '));
    console.log(JSON.stringify(rows));
    db.close();
  } else if (cmd === 'export:json') {
    const [file, table, out] = args;
    if (!file || !table || !out) throw new Error('usage: export:json <dbfile> <table> <file>');
    const db = new Database(file);
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
  } else {
    usage();
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
