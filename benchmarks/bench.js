#!/usr/bin/env node
'use strict';
const { Database, defineModel, field } = require('../lib');

const rows = Number(process.env.LITEORM_BENCH_ROWS || 1000);
const db = new Database(':memory:', { statementCache: 128, wal: false });
db.schema.createTable('items', t => {
  t.increments('id');
  t.text('name').notNull();
  t.integer('score').default(0);
  t.json('meta');
});
const Item = defineModel(db, 'items', {
  fields: {
    id: field.integer().primary().autoIncrement(),
    name: field.text().required(),
    score: field.integer().default(0),
    meta: field.json().default({})
  },
  json: ['meta']
});

function measure(name, fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { name, ms: Number(ms.toFixed(3)), result };
}

const results = [];
results.push(measure('insertMany', () => Item.insertMany(Array.from({ length: rows }, (_, i) => ({ name: `item-${i}`, score: i % 100, meta: { bucket: i % 10 } }))).length));
results.push(measure('query cached prepared', () => {
  for (let i = 0; i < rows; i++) db.query('SELECT * FROM items WHERE score = ?', [i % 100]);
  return db.statementCacheStats();
}));
results.push(measure('json filter', () => Item.query().whereJson('meta.bucket', '=', 5).count()));
console.log(JSON.stringify({ rows, sqlite: require('../lib').sqliteVersion, results }, null, 2));
