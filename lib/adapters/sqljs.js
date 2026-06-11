'use strict';

function normalizeValue(v) {
  if (v instanceof Uint8Array && typeof Buffer !== 'undefined') return Buffer.from(v);
  return v;
}

function createSqlJsAdapter(SQL, filename = ':memory:') {
  const db = filename && filename !== ':memory:' && typeof require === 'function'
    ? new SQL.Database(require('node:fs').existsSync(filename) ? require('node:fs').readFileSync(filename) : undefined)
    : new SQL.Database();
  return {
    filename,
    exec(sql, params = []) {
      const stmt = db.prepare(String(sql));
      try {
        stmt.bind(params);
        while (stmt.step()) {}
        return { changes: db.getRowsModified(), lastInsertRowid: 0 };
      } finally {
        stmt.free();
      }
    },
    query(sql, params = []) {
      const stmt = db.prepare(String(sql));
      const rows = [];
      try {
        stmt.bind(params);
        while (stmt.step()) {
          const row = stmt.getAsObject();
          for (const k of Object.keys(row)) row[k] = normalizeValue(row[k]);
          rows.push(row);
        }
        return rows;
      } finally {
        stmt.free();
      }
    },
    export() { return db.export(); },
    close() { db.close(); }
  };
}

module.exports = { createSqlJsAdapter };
