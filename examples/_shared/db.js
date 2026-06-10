'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Database } = require('./liteorm');

function openExampleDb(name) {
  const filename = process.env.LITEORM_DB || ':memory:';
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }
  const db = new Database(filename);
  db.tune({ journalMode: filename === ':memory:' ? 'MEMORY' : 'WAL', synchronous: 'NORMAL', busyTimeout: 5000 });
  return db;
}

function printSummary(summary) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

module.exports = { openExampleDb, printSummary };
