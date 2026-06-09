const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Database, defineModel, sql } = require('../lib');

function tmpdb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoorm-'));
  return path.join(dir, name || 'test.sqlite');
}

function makeDb() {
  const db = new Database(tmpdb(), { cache: { ttl: 1000, max: 100 } });
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      meta TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      deleted_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);
  const User = defineModel(db, 'users', {
    softDelete: true,
    timestamps: true,
    json: ['meta'],
    validate: {
      name: v => typeof v === 'string' && v.length >= 2 || 'name minimal 2 karakter',
      email: v => /@/.test(v) || 'email tidak valid'
    },
    relations: {
      posts: { type: 'hasMany', model: 'posts', foreignKey: 'user_id', localKey: 'id' }
    }
  });
  const Post = defineModel(db, 'posts', {
    softDelete: true,
    relations: {
      user: { type: 'belongsTo', model: 'users', foreignKey: 'user_id', ownerKey: 'id' }
    }
  });
  return { db, User, Post };
}

test('query builder creates, filters, orders, limits, updates and soft deletes rows', () => {
  const { User } = makeDb();
  const ada = User.create({ name: 'Ada', email: 'ada@test.local', meta: { role: 'admin' } });
  User.create({ name: 'Bob', email: 'bob@test.local', meta: { role: 'user' } });

  assert.equal(ada.id, 1);
  assert.deepEqual(ada.meta, { role: 'admin' });

  const admins = User.query()
    .where('name', '=', 'Ada')
    .whereJson('meta.role', '=', 'admin')
    .orderBy('id', 'desc')
    .limit(1)
    .get();
  assert.equal(admins.length, 1);
  assert.equal(admins[0].email, 'ada@test.local');
  assert.deepEqual(admins[0].meta, { role: 'admin' });

  const changed = User.query().where('email', '=', 'ada@test.local').update({ name: 'Ada Lovelace' });
  assert.equal(changed, 1);
  assert.equal(User.find(1).name, 'Ada Lovelace');

  assert.equal(User.delete(1), 1);
  assert.equal(User.find(1), null);
  assert.equal(User.query().withDeleted().where('id', '=', 1).first().name, 'Ada Lovelace');
});

test('relationships eager load hasMany and belongsTo', () => {
  const { User, Post } = makeDb();
  const user = User.create({ name: 'Adit', email: 'adit@test.local' });
  Post.create({ user_id: user.id, title: 'Pertama', body: 'Halo' });
  Post.create({ user_id: user.id, title: 'Kedua', body: 'Dunia' });

  const loaded = User.query().with('posts').where('id', '=', user.id).first();
  assert.equal(loaded.posts.length, 2);
  assert.deepEqual(loaded.posts.map(p => p.title), ['Pertama', 'Kedua']);

  const post = Post.query().with('user').where('title', '=', 'Pertama').first();
  assert.equal(post.user.email, 'adit@test.local');
});

test('migrations apply once and rollback in reverse order', () => {
  const db = new Database(tmpdb());
  let upRuns = 0;
  let downRuns = 0;
  db.migrate([
    { id: '001_create_items', up: d => { upRuns++; d.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)'); }, down: d => { downRuns++; d.exec('DROP TABLE items'); } },
    { id: '002_add_price', up: d => { upRuns++; d.exec('ALTER TABLE items ADD COLUMN price INTEGER DEFAULT 0'); }, down: d => { downRuns++; d.exec('CREATE TABLE items_new(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items_new(id,name) SELECT id,name FROM items; DROP TABLE items; ALTER TABLE items_new RENAME TO items;'); } }
  ]);
  db.migrate([
    { id: '001_create_items', up: () => { upRuns++; } },
    { id: '002_add_price', up: () => { upRuns++; } }
  ]);
  assert.equal(upRuns, 2);
  assert.deepEqual(db.query("PRAGMA table_info(items)").map(r => r.name), ['id', 'name', 'price']);
  db.rollbackMigrations(1);
  assert.equal(downRuns, 1);
  assert.deepEqual(db.query("PRAGMA table_info(items)").map(r => r.name), ['id', 'name']);
});

test('validation, transactions, hooks and raw sql helper work together', () => {
  const { db, User } = makeDb();
  const events = [];
  User.hook('beforeCreate', row => { events.push(`before:${row.email}`); row.name = row.name.trim(); });
  User.hook('afterCreate', row => events.push(`after:${row.id}`));

  assert.throws(() => User.create({ name: 'A', email: 'broken' }), /Validation failed/);

  db.transaction(tx => {
    User.using(tx).create({ name: '  Cici  ', email: 'cici@test.local' });
    User.using(tx).create({ name: 'Dodo', email: 'dodo@test.local' });
  });
  assert.deepEqual(events, ['before:cici@test.local', 'after:1', 'before:dodo@test.local', 'after:2']);
  assert.equal(User.query().count(), 2);
  assert.equal(User.find(1).name, 'Cici');

  assert.throws(() => db.transaction(() => {
    User.create({ name: 'Eka', email: 'eka@test.local' });
    throw new Error('boom');
  }), /boom/);
  assert.equal(User.query().where('email', '=', 'eka@test.local').count(), 0);

  const rows = db.query(sql`SELECT name FROM users WHERE email = ${'cici@test.local'}`);
  assert.equal(rows[0].name, 'Cici');
});

test('cache returns repeated select from memory until invalidated by writes', () => {
  const { db, User } = makeDb();
  User.create({ name: 'Cache', email: 'cache@test.local' });
  const first = User.query().where('email', '=', 'cache@test.local').cache(5000).first();
  db.exec("UPDATE users SET name='Direct Native Update' WHERE email='cache@test.local'");
  const cached = User.query().where('email', '=', 'cache@test.local').cache(5000).first();
  assert.equal(cached.name, 'Cache');
  db.clearCache();
  const fresh = User.query().where('email', '=', 'cache@test.local').cache(5000).first();
  assert.equal(fresh.name, 'Direct Native Update');
});
