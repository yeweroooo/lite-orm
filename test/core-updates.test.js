const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { Database, defineModel, field, errors } = require('../lib');

function tmp(name = 'updates.sqlite') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liteorm-updates-'));
  return { dir, file: path.join(dir, name) };
}

function makeParanoid() {
  const { file } = tmp();
  const db = new Database(file, { statementCache: 8, busyTimeout: 1000 });
  db.schema.createTable('users', t => {
    t.increments('id');
    t.text('name').notNull();
    t.text('email').notNull().unique();
    t.text('role').default('user');
    t.text('meta').default('{}');
    t.text('removed_at');
    t.text('secret');
    t.integer('tenant_id').default(1);
    t.timestamps();
  });
  const User = defineModel(db, 'users', {
    paranoid: true,
    deletedAt: 'removed_at',
    timestamps: true,
    strict: true,
    fields: {
      id: field.integer().primary().autoIncrement(),
      name: field.text().required().min(2),
      email: field.text().required().email(),
      role: field.text().default('user'),
      meta: field.json().default({}),
      removed_at: field.text().nullable(),
      secret: field.text().encrypted(),
      tenant_id: field.integer().default(1)
    },
    json: ['meta'],
    policies: {
      read: ({ actor, q }) => actor && actor.role !== 'admin' ? q.where('tenant_id', '=', actor.tenant_id) : true,
      create: ({ actor }) => actor?.role === 'admin',
      update: ({ actor }) => actor?.role === 'admin',
      delete: ({ actor }) => actor?.role === 'admin',
      fields: { secret: { read: ({ actor }) => actor?.role === 'admin', update: false } }
    }
  });
  return { db, User };
}

test('paranoid alias, custom deletedAt, aliases, restore, force delete and lifecycle abort hooks', () => {
  const { db, User } = makeParanoid();
  const events = [];
  User.hook('beforeCreate', (row, ctx) => { events.push(`beforeCreate:${row.email}`); assert.equal(ctx.op, 'create'); });
  User.hook('afterCreate', (row, ctx) => { events.push(`afterCreate:${row.id}`); assert.equal(ctx.table, 'users'); });
  User.hook('beforeUpdate', row => { events.push(`beforeUpdate:${row.name || ''}`); });
  User.hook('afterUpdate', (row, ctx) => { events.push(`afterUpdate:${ctx.changes}`); });
  User.hook('beforeDestroy', (row, ctx) => {
    events.push(`beforeDestroy:${row.email}`);
    if (row.email === 'stop@test.local') ctx.abort('blocked destroy');
  });
  User.hook('afterDestroy', row => events.push(`afterDestroy:${row.email}`));
  User.hook('beforeRestore', row => events.push(`beforeRestore:${row.email}`));
  User.hook('afterRestore', row => events.push(`afterRestore:${row.email}`));

  const admin = { id: 1, role: 'admin', tenant_id: 1 };
  const ada = db.as(admin, () => User.create({ name: 'Ada', email: 'ada@test.local', tenant_id: 1, meta: { tags: ['admin', 'pro'] } }));
  db.as(admin, () => User.create({ name: 'Stop', email: 'stop@test.local', tenant_id: 1 }));

  assert.equal(User.find(ada.id).email, 'ada@test.local');
  assert.equal(User.query().count(), 2);
  assert.equal(db.as(admin, () => User.query().where('id', '=', ada.id).update({ name: 'Ada Lovelace' })), 1);
  assert.equal(db.as(admin, () => User.delete(ada.id)), 1);
  assert.equal(User.find(ada.id), null);
  assert.equal(User.query().withTrashed().where('id', '=', ada.id).first().name, 'Ada Lovelace');
  assert.equal(User.query().onlyTrashed().count(), 1);
  assert.equal(db.as(admin, () => User.query().onlyTrashed().where('id', '=', ada.id).restore()), 1);
  assert.equal(User.find(ada.id).removed_at, null);
  assert.throws(() => db.as(admin, () => User.delete(2)), errors.HookAbortError);
  assert.equal(User.find(2).email, 'stop@test.local');
  assert.equal(db.as(admin, () => User.forceDelete(2)), 1);
  assert.equal(User.query().withTrashed().where('id', '=', 2).first(), null);
  assert.ok(events.includes('beforeCreate:ada@test.local'));
  assert.ok(events.includes('afterCreate:1'));
  assert.ok(events.includes('beforeDestroy:ada@test.local'));
  assert.ok(events.includes('afterDestroy:ada@test.local'));
  assert.ok(events.includes('beforeRestore:ada@test.local'));
  assert.ok(events.includes('afterRestore:ada@test.local'));
});

test('validation API returns structured issues and strict models reject unknown fields', () => {
  const { User } = makeParanoid();
  const res = User.validate({ name: 'A', email: 'broken', extra: true }, { mode: 'create' });
  assert.equal(res.valid, false);
  assert.ok(res.issues.some(i => i.field === 'name' && i.code === 'min'));
  assert.ok(res.issues.some(i => i.field === 'email' && i.code === 'email'));
  assert.ok(res.issues.some(i => i.field === 'extra' && i.code === 'unknown'));
  assert.throws(() => User.assertValid({ name: 'A', email: 'broken', extra: true }, { mode: 'create' }), err => {
    assert.ok(err instanceof errors.ValidationError);
    assert.ok(Array.isArray(err.issues));
    return /Validation failed/.test(err.message);
  });
});

test('JSON helpers filter, order and update nested documents atomically', () => {
  const { db, User } = makeParanoid();
  db.as({ role: 'admin', tenant_id: 1 }, () => {
    User.create({ name: 'Ada', email: 'ada@test.local', meta: { tier: 'pro', tags: ['math', 'code'], stats: { score: 7 } } });
    User.create({ name: 'Bob', email: 'bob@test.local', meta: { tier: 'free', tags: ['ops'], stats: { score: 3 } } });
  });

  assert.equal(User.query().whereJsonExists('meta.stats.score').count(), 2);
  assert.equal(User.query().whereJsonContains('meta.tags', 'code').first().email, 'ada@test.local');
  assert.equal(User.query().whereJsonLength('meta.tags', '>=', 2).count(), 1);
  assert.deepEqual(User.query().orderByJson('meta.stats.score', 'desc').get().map(r => r.email), ['ada@test.local', 'bob@test.local']);
  assert.equal(User.query().where('email', '=', 'bob@test.local').jsonSet('meta.stats.score', 9), 1);
  assert.equal(User.query().whereJson('meta.stats.score', '=', 9).first().email, 'bob@test.local');
  assert.equal(User.query().where('email', '=', 'bob@test.local').jsonPatch('meta', { tier: 'pro', active: true }), 1);
  assert.equal(User.query().whereJson('meta.active', '=', 1).first().email, 'bob@test.local');
  assert.equal(User.query().where('email', '=', 'bob@test.local').jsonRemove('meta.active'), 1);
  assert.equal(User.query().whereJsonExists('meta.active').count(), 0);
  assert.ok(db.explain(User.query().whereJson('meta.tier', '=', 'pro')).length > 0);
});

test('query profiling, native statement cache, UDF and custom collation are exposed', () => {
  const { db, User } = makeParanoid();
  const seen = [];
  db.profile(ev => seen.push(ev), { thresholdMs: 0 });
  db.createFunction('slugify', value => String(value).toLowerCase().replace(/\s+/g, '-'), { deterministic: true });
  db.createCollation('REVERSE', (a, b) => String(b).localeCompare(String(a)));
  db.as({ role: 'admin', tenant_id: 1 }, () => User.create({ name: 'Ada Lovelace', email: 'ada@test.local' }));
  assert.equal(db.query('SELECT slugify(name) AS slug FROM users')[0].slug, 'ada-lovelace');
  db.exec("INSERT INTO users(name,email,role,meta,tenant_id) VALUES('Zulu','z@test.local','user','{}',1)");
  assert.deepEqual(db.query('SELECT name FROM users ORDER BY name COLLATE REVERSE').map(r => r.name), ['Zulu', 'Ada Lovelace']);

  const stmt = db.prepare('SELECT email FROM users WHERE name = ?');
  assert.equal(stmt.get(['Ada Lovelace']).email, 'ada@test.local');
  assert.equal(stmt.readonly(), true);
  stmt.finalize();
  assert.throws(() => stmt.get(['Ada Lovelace']), /finalized/i);

  db.query('SELECT email FROM users WHERE name = ?', ['Ada Lovelace']);
  db.query('SELECT email FROM users WHERE name = ?', ['Ada Lovelace']);
  const stats = db.statementCacheStats();
  assert.ok(stats.hits >= 1, JSON.stringify(stats));
  assert.ok(seen.some(ev => ev.sql.includes('SELECT') && typeof ev.durationMs === 'number'));
});

test('nested transactions use savepoints and retry options do not break callbacks', () => {
  const { db, User } = makeParanoid();
  const admin = { role: 'admin', tenant_id: 1 };
  assert.equal(db.inTransaction(), false);
  assert.throws(() => db.transaction(() => {
    assert.equal(db.inTransaction(), true);
    db.as(admin, () => User.create({ name: 'Outer', email: 'outer@test.local' }));
    assert.throws(() => db.transaction(() => {
      db.as(admin, () => User.create({ name: 'Inner', email: 'inner@test.local' }));
      throw new Error('inner fail');
    }), /inner fail/);
    assert.equal(User.query().where('email', '=', 'inner@test.local').count(), 0);
    throw new Error('outer fail');
  }, { retries: 2, retryDelay: 1 }), /outer fail/);
  assert.equal(User.query().where('email', '=', 'outer@test.local').count(), 0);
});

test('CDC, sync helpers, RBAC and encryption key rotation compose with models', () => {
  const { db, User } = makeParanoid();
  db.cdc.enable({ source: 'local' });
  const live = [];
  const unsubscribe = db.cdc.subscribe(ch => live.push(ch));
  const admin = { id: 1, role: 'admin', tenant_id: 1 };
  const tenantUser = { id: 2, role: 'user', tenant_id: 2 };
  const u1 = db.as(admin, () => User.create({ name: 'One', email: 'one@test.local', tenant_id: 1, secret: 's1' }));
  db.as(admin, () => User.create({ name: 'Two', email: 'two@test.local', tenant_id: 2, secret: 's2' }));
  assert.throws(() => db.as(tenantUser, () => User.create({ name: 'No', email: 'no@test.local' })), errors.AuthorizationError);
  assert.deepEqual(db.as(tenantUser, () => User.query().get().map(u => u.email)), ['two@test.local']);
  assert.equal(db.as(tenantUser, () => User.query().where('email', '=', 'two@test.local').first().toJSON().secret), undefined);
  assert.equal(db.as(admin, () => User.find(u1.id).toJSON().secret), 's1');
  assert.throws(() => db.as(admin, () => User.query().where('id', '=', u1.id).update({ secret: 'blocked' })), errors.AuthorizationError);
  db.as(admin, () => User.find(u1.id).delete());
  db.as(admin, () => User.restore(u1.id));
  unsubscribe();
  const changes = db.cdc.changes();
  assert.ok(changes.length >= 4);
  assert.ok(live.length >= 4);
  const checkpoint = db.cdc.checkpoint();
  const pushed = db.sync.push({ send: batch => batch.length }, { since: 0 });
  assert.equal(pushed.sent, changes.length);
  assert.equal(checkpoint, changes.at(-1).seq);

  const rawBefore = db.query('SELECT secret FROM users WHERE id=?', [u1.id])[0].secret;
  db.rotateEncryptionKey([User], crypto.createHash('sha256').update('rotated').digest());
  const rawAfter = db.query('SELECT secret FROM users WHERE id=?', [u1.id])[0].secret;
  assert.notEqual(rawBefore, rawAfter);
  assert.equal(db.as(admin, () => User.find(u1.id).secret), 's1');
});

test('FTS helpers support ranking, snippets, highlights and model search respects paranoid rows', () => {
  const { db, User } = makeParanoid();
  db.as({ role: 'admin', tenant_id: 1 }, () => {
    User.create({ name: 'SQLite Guide', email: 'guide@test.local' });
    User.create({ name: 'Node ORM', email: 'node@test.local' });
  });
  db.fts.create('user_search', { columns: ['name', 'email'], tokenize: 'unicode61', prefix: [2, 3] });
  db.fts.sync('user_search', 'users', { columns: ['name', 'email'], triggers: true });
  db.exec("UPDATE users SET name='SQLite Native Guide' WHERE email='guide@test.local'");
  let rows = db.fts.search('user_search', 'SQLite', { rank: true, highlight: { column: 'name', before: '[', after: ']' }, snippet: { column: 'name' } });
  assert.equal(rows[0].email, 'guide@test.local');
  assert.match(rows[0].highlight, /\[SQLite\]/);
  assert.equal(typeof rows[0].rank, 'number');
  db.fts.optimize('user_search');
  db.fts.rebuild('user_search');
  rows = db.fts.search('user_search', 'Node', { limit: 1 });
  assert.equal(rows.length, 1);
});


test('security regression coverage for native statement lifetime and SQL option validation', () => {
  const { dir, file } = tmp();
  const db = new Database(file, { wal: false });
  db.exec('CREATE TABLE docs(id INTEGER PRIMARY KEY, meta TEXT); CREATE TABLE victim(id INTEGER);');
  const stmt = db.prepare('SELECT 1 AS n');
  db.close();
  assert.doesNotThrow(() => stmt.finalize());

  const db2 = new Database(path.join(dir, 'safe.sqlite'), { wal: false });
  assert.throws(() => db2.createFunction('bad', () => 1, { arity: -2 }), /arity/i);
  assert.throws(() => db2.transaction(() => {}, { mode: 'IMMEDIATE; DROP TABLE victim; --' }), /Invalid transaction mode/);

  db2.schema.createTable('docs', t => {
    t.increments('id');
    t.text('meta');
    t.indexJson("meta.x')) ; DROP TABLE docs; --", 'idx_docs_meta_safe');
  });
  assert.ok(db2.inspect.tables().includes('docs'));

  const M = defineModel(db2, 'docs', { fields: { id: field.integer().primary().autoIncrement(), meta: field.json().default({}) }, json: ['meta'] });
  assert.throws(() => M.query().whereJsonLength('meta.tags', '>= 0); DROP TABLE docs; --', 1).count(), /Invalid SQL operator/);
  assert.throws(() => db2.fts.create('badfts', { columns: ['meta'], prefix: [2, 'x'] }), /Invalid FTS prefix/);
});

test('CDC apply propagates force delete changes to a target database', () => {
  const a = new Database(':memory:', { wal: false });
  const b = new Database(':memory:', { wal: false });
  for (const db of [a, b]) db.schema.createTable('items', t => { t.increments('id'); t.text('name'); });
  const Source = defineModel(a, 'items', { fields: { id: field.integer().primary().autoIncrement(), name: field.text() } });
  defineModel(b, 'items', { fields: { id: field.integer().primary().autoIncrement(), name: field.text() } });
  a.cdc.enable();
  const row = Source.create({ name: 'gone' });
  Source.forceDelete(row.id);
  b.cdc.apply(a.cdc.changes());
  assert.deepEqual(b.query('SELECT * FROM items'), []);
});
