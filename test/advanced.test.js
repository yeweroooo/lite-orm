const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { Database, defineModel, field, sql } = require('../lib');

function tmp(name = 'test.sqlite') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoorm-adv-'));
  return { dir, file: path.join(dir, name) };
}

function makeBlog() {
  const { file, dir } = tmp();
  const db = new Database(file);
  db.schema.createTable('users', t => {
    t.increments('id');
    t.text('name').notNull();
    t.text('email').notNull().unique();
    t.text('role').default('user');
    t.integer('age').default(0);
    t.text('password').nullable();
    t.json('meta');
    t.timestamps();
    t.softDeletes();
  });
  db.schema.createTable('profiles', t => {
    t.increments('id');
    t.integer('user_id').notNull().references('users', 'id');
    t.text('avatar');
  });
  db.schema.createTable('posts', t => {
    t.increments('id');
    t.integer('user_id').notNull().references('users', 'id');
    t.text('title').notNull();
    t.text('body');
    t.timestamps();
    t.softDeletes();
  });

  const User = defineModel(db, 'users', {
    fields: {
      id: field.integer().primary().autoIncrement(),
      name: field.text().required(),
      email: field.text().required().unique(),
      role: field.text().default('user'),
      age: field.integer().default(0),
      password: field.text().hidden(),
      meta: field.json().default({})
    },
    hidden: ['password'],
    computed: { label: u => `${u.name}<${u.email}>` },
    softDelete: true,
    timestamps: true,
    json: ['meta'],
    validate: { email: v => String(v).includes('@') || 'email invalid' },
    scopes: {
      admins: q => q.where('role', '=', 'admin'),
      adults: q => q.where('age', '>=', 18)
    },
    relations: {
      posts: { type: 'hasMany', model: 'posts', foreignKey: 'user_id' },
      profile: { type: 'hasOne', model: 'profiles', foreignKey: 'user_id' }
    }
  });
  const Post = defineModel(db, 'posts', {
    softDelete: true,
    relations: { user: { type: 'belongsTo', model: 'users', foreignKey: 'user_id' } }
  });
  defineModel(db, 'profiles', { relations: { user: { type: 'belongsTo', model: 'users', foreignKey: 'user_id' } } });
  return { db, dir, file, User, Post };
}

test('schema builder, field definitions, advanced query builder, joins and serialization', () => {
  const { db, User } = makeBlog();
  User.insertMany([
    { name: 'Adit', email: 'adit@test.local', role: 'admin', age: 24, password: 'secret', meta: { tier: 'pro' } },
    { name: 'Budi', email: 'budi@test.local', role: 'user', age: 17, password: 'hide', meta: { tier: 'free' } },
    { name: 'Cici', email: 'cici@test.local', role: 'admin', age: 31, password: 'hide', meta: { tier: 'pro' } }
  ]);
  db.exec('INSERT INTO profiles(user_id, avatar) VALUES(?, ?)', [1, 'a.png']);

  const rows = User.query()
    .select(['users.id', 'users.name', 'profiles.avatar'])
    .leftJoin('profiles', 'profiles.user_id', '=', 'users.id')
    .where(q => q.where('users.role', '=', 'admin').orWhere('users.age', '<', 18))
    .whereBetween('users.age', 16, 40)
    .whereJson('users.meta.tier', '=', 'pro')
    .orderBy('users.id', 'desc')
    .get();

  assert.deepEqual(rows.map(r => r.name), ['Cici', 'Adit']);
  assert.equal(rows[1].avatar, 'a.png');
  assert.match(User.query().whereNot('role', '=', 'user').toSQL().text, /NOT/);
  assert.equal(User.query().scope('admins').scope('adults').count(), 2);

  const json = User.find(1).toJSON();
  assert.equal(json.password, undefined);
  assert.equal(json.label, 'Adit<adit@test.local>');
  assert.deepEqual(json.meta, { tier: 'pro' });
});

test('bulk insert, upsert conflict, prepared statements, async wrappers, soft restore and relation hasOne', async () => {
  const { db, User, Post } = makeBlog();
  const inserted = User.insertMany([
    { name: 'Adit', email: 'adit@test.local', role: 'admin', age: 24 },
    { name: 'Budi', email: 'budi@test.local', role: 'user', age: 18 }
  ]);
  assert.equal(inserted.length, 2);

  User.upsert({ name: 'Adit Baru', email: 'adit@test.local', role: 'admin', age: 25 }, ['email'], ['name', 'age']);
  assert.equal(User.query().where('email', '=', 'adit@test.local').first().name, 'Adit Baru');

  const stmt = db.prepare('SELECT name FROM users WHERE email = ?');
  assert.equal(stmt.get(['adit@test.local']).name, 'Adit Baru');
  assert.equal(stmt.all(['budi@test.local']).length, 1);
  stmt.finalize();

  db.exec('INSERT INTO profiles(user_id, avatar) VALUES(?, ?)', [1, 'avatar.png']);
  Post.create({ user_id: 1, title: 'Hello', body: 'World' });
  const loaded = User.query().with('profile').with('posts').where('id', '=', 1).first();
  assert.equal(loaded.profile.avatar, 'avatar.png');
  assert.equal(loaded.posts[0].title, 'Hello');

  User.delete(1);
  assert.equal(User.find(1), null);
  assert.equal(User.query().onlyDeleted().count(), 1);
  assert.equal(User.restore(1), 1);
  assert.equal(User.find(1).name, 'Adit Baru');

  const asyncRows = await db.async.query('SELECT COUNT(*) AS n FROM users');
  assert.equal(asyncRows[0].n, 2);
});

test('introspection, explain, FTS5 helper, backup/restore and plugin registration', () => {
  const { db, dir, User } = makeBlog();
  User.create({ name: 'Adit', email: 'adit@test.local', role: 'admin', age: 24 });
  const tables = db.inspect.tables();
  assert.ok(tables.includes('users'));
  assert.ok(db.inspect.columns('users').some(c => c.name === 'email'));
  assert.ok(db.inspect.indexes('users').some(i => i.unique));
  assert.ok(db.explain(User.query().where('email', '=', 'adit@test.local')).length >= 1);

  db.fts.create('posts_search', { columns: ['title', 'body'] });
  db.fts.insert('posts_search', { title: 'SQLite ORM Native', body: 'fast local first database' });
  assert.equal(db.fts.search('posts_search', 'native')[0].title, 'SQLite ORM Native');

  let used = false;
  db.use(database => { database.magic = () => 'plugin-ok'; used = true; });
  assert.equal(used, true);
  assert.equal(db.magic(), 'plugin-ok');

  const backupFile = path.join(dir, 'backup.sqlite');
  db.backup(backupFile);
  const restored = new Database(path.join(dir, 'restored.sqlite'));
  restored.restore(backupFile);
  assert.equal(restored.query('SELECT COUNT(*) AS n FROM users')[0].n, 1);
});

test('CLI can inspect and generate migration file', () => {
  const { file, dir } = makeBlog();
  const cli = path.join(__dirname, '..', 'bin', 'lite-orm.js');
  const out = execFileSync(process.execPath, [cli, 'inspect', file], { encoding: 'utf8' });
  assert.match(out, /users/);
  const migOut = execFileSync(process.execPath, [cli, 'make:migration', 'create_logs_table', '--dir', dir], { encoding: 'utf8' });
  const migrationFile = migOut.trim();
  assert.ok(fs.existsSync(migrationFile));
  assert.match(fs.readFileSync(migrationFile, 'utf8'), /create_logs_table/);
});
