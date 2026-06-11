#!/usr/bin/env node
'use strict';
const { Database, defineModel, field } = require('../../lib');

const db = new Database(process.env.LITEORM_DB || ':memory:', { statementCache: 32, wal: false });
db.schema.createTable('users', t => {
  t.increments('id');
  t.text('name').notNull();
  t.text('email').notNull().unique();
  t.text('deleted_at');
  t.text('meta').default('{}');
  t.timestamps();
});
const User = defineModel(db, 'users', {
  paranoid: true,
  timestamps: true,
  json: ['meta'],
  fields: {
    id: field.integer().primary().autoIncrement(),
    name: field.text().required().min(2),
    email: field.text().required().email(),
    meta: field.json().default({}),
    deleted_at: field.text().nullable()
  }
});
User.hook('beforeCreate', row => { row.name = String(row.name).trim(); });
db.cdc.enable({ source: 'playground' });
db.profile(ev => { if (process.env.LITEORM_PROFILE) console.error(`${ev.kind} ${ev.durationMs.toFixed(3)}ms ${ev.sql}`); });

const ada = User.create({ name: ' Ada ', email: 'ada@test.local', meta: { role: 'admin', tags: ['demo'] } });
User.create({ name: 'Budi', email: 'budi@test.local', meta: { role: 'user', tags: ['demo', 'local'] } });
User.delete(ada.id);
const out = {
  visible: User.query().get().map(u => u.email),
  deleted: User.query().onlyTrashed().get().map(u => u.email),
  cdc: db.cdc.changes().map(c => `${c.op}:${c.rowId}`),
  cache: db.statementCacheStats()
};
console.log(JSON.stringify(out, null, 2));
