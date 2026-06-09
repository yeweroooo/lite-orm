const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const { Database, defineModel, field, errors } = require('../lib');

function tmp(name = 'pro.sqlite') { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoorm-pro-')); return { dir, file: path.join(dir, name) }; }
function setup() {
  const { dir, file } = tmp();
  const key = crypto.createHash('sha256').update('test-key').digest();
  const db = new Database(file, { encryptionKey: key, retry: { attempts: 2, delay: 1 } });
  db.tune({ journalMode: 'WAL', synchronous: 'NORMAL', busyTimeout: 2500, tempStore: 'MEMORY' });
  db.schema.createTable('users', t => { t.increments('id'); t.text('name').notNull(); t.text('email').notNull().unique(); t.text('token'); t.integer('version').default(0); t.timestamps(); t.softDeletes(); });
  db.schema.createTable('roles', t => { t.increments('id'); t.text('name').notNull().unique(); });
  db.schema.createTable('role_user', t => { t.integer('user_id').notNull().references('users'); t.integer('role_id').notNull().references('roles'); t.unique(['user_id', 'role_id']); });
  db.schema.createTable('posts', t => { t.increments('id'); t.integer('user_id').notNull().references('users'); t.text('title'); });
  db.audit.enable({ actor: () => 'tester' });
  const User = defineModel(db, 'users', {
    fields: { id: field.integer().primary().autoIncrement(), name: field.text().required().min(2), email: field.text().required().email(), token: field.text().encrypted(), version: field.integer().default(0) },
    timestamps: true, softDelete: true, optimisticLock: true,
    relations: { roles: { type: 'belongsToMany', model: 'roles', pivot: 'role_user', foreignPivotKey: 'user_id', relatedPivotKey: 'role_id' }, posts: { type: 'hasMany', model: 'posts', foreignKey: 'user_id' } }
  });
  const Role = defineModel(db, 'roles', { relations: { users: { type: 'belongsToMany', model: 'users', pivot: 'role_user', foreignPivotKey: 'role_id', relatedPivotKey: 'user_id' } } });
  const Post = defineModel(db, 'posts', { relations: { user: { type: 'belongsTo', model: 'users', foreignKey: 'user_id' } } });
  return { db, dir, file, User, Role, Post };
}

test('tuning, validation error classes, encryption casts, model instance dirty tracking and optimistic locking', () => {
  const { db, User } = setup();
  assert.equal(db.query('PRAGMA busy_timeout')[0].timeout, 2500);
  assert.throws(() => User.create({ name: 'A', email: 'bad' }), errors.ValidationError);
  const user = User.create({ name: 'Adit', email: 'adit@test.local', token: 'secret-token' });
  const raw = db.query('SELECT token FROM users WHERE id=?', [user.id])[0].token;
  assert.notEqual(raw, 'secret-token');
  assert.equal(User.find(user.id).token, 'secret-token');
  user.name = 'Adit Baru';
  assert.deepEqual(user.getChanges(), { name: 'Adit Baru' });
  user.save();
  assert.equal(User.find(user.id).name, 'Adit Baru');
  assert.equal(User.find(user.id).version, 1);
  user.name = 'Conflict';
  db.exec('UPDATE users SET version=99 WHERE id=?', [user.id]);
  assert.throws(() => user.save(), errors.ConflictError);
});

test('belongsToMany, withCount, constrained eager loading, cursor pagination and audit log', () => {
  const { db, User, Role, Post } = setup();
  const u1 = User.create({ name: 'Adit', email: 'adit@test.local' });
  const u2 = User.create({ name: 'Budi', email: 'budi@test.local' });
  const admin = Role.create({ name: 'admin' });
  const mod = Role.create({ name: 'mod' });
  db.exec('INSERT INTO role_user(user_id, role_id) VALUES(?, ?), (?, ?)', [u1.id, admin.id, u1.id, mod.id]);
  Post.insertMany([{ user_id: u1.id, title: 'A' }, { user_id: u1.id, title: 'B' }, { user_id: u2.id, title: 'C' }]);
  const loaded = User.query().with('roles').withCount('posts').where('id', '=', u1.id).first();
  assert.deepEqual(loaded.roles.map(r => r.name).sort(), ['admin', 'mod']);
  assert.equal(loaded.posts_count, 2);
  const constrained = User.query().with('posts', q => q.where('title', '=', 'A')).where('id', '=', u1.id).first();
  assert.deepEqual(constrained.posts.map(p => p.title), ['A']);
  const page = User.query().orderBy('id', 'asc').cursorPaginate({ limit: 1 });
  assert.equal(page.data.length, 1);
  assert.equal(page.hasMore, true);
  const auditRows = db.query('SELECT action, actor_id FROM audit_logs ORDER BY id');
  assert.ok(auditRows.some(r => r.action === 'create' && r.actor_id === 'tester'));
});

test('schema diff/generate migration, factory/seeder, export/import and repository helper', () => {
  const { db, dir, User } = setup();
  const diff = db.schema.diff('users', { phone: field.text().nullable(), email: field.text().required().unique() });
  assert.ok(diff.some(s => s.includes('ADD COLUMN')));
  const mig = db.schema.generateMigration('add_phone', diff, dir);
  assert.ok(fs.existsSync(mig));
  db.factory(User, i => ({ name: `User ${i}`, email: `u${i}@test.local` })).createMany(3);
  db.seed([() => User.create({ name: 'Seed', email: 'seed@test.local' })]);
  assert.equal(User.query().count(), 4);
  const json = path.join(dir, 'users.json');
  const csv = path.join(dir, 'users.csv');
  db.export.json('users', json); db.export.csv('users', csv);
  assert.ok(fs.readFileSync(json, 'utf8').includes('seed@test.local'));
  db.schema.createTable('users_copy', t => { t.increments('id'); t.text('name'); t.text('email'); t.text('token'); t.integer('version'); t.text('created_at'); t.text('updated_at'); t.text('deleted_at'); });
  db.import.json('users_copy', json);
  assert.equal(db.query('SELECT COUNT(*) AS n FROM users_copy')[0].n, 4);
  class UserRepo { constructor(model) { this.model = model; } findByEmail(email) { return this.model.query().where('email', '=', email).first(); } }
  assert.equal(db.repo(User, UserRepo).findByEmail('seed@test.local').name, 'Seed');
});

test('CLI studio executes non-interactive SQL and exports table', () => {
  const { file, User, dir } = setup();
  User.create({ name: 'Adit', email: 'adit@test.local' });
  const cli = path.join(__dirname, '..', 'bin', 'lite-orm.js');
  const out = execFileSync(process.execPath, [cli, 'studio', file, '--exec', 'SELECT COUNT(*) AS n FROM users'], { encoding: 'utf8' });
  assert.match(out, /"n":1/);
  const outFile = path.join(dir, 'cli-users.json');
  execFileSync(process.execPath, [cli, 'export:json', file, 'users', outFile], { encoding: 'utf8' });
  assert.ok(fs.existsSync(outFile));
});
