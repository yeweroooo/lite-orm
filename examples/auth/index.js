'use strict';

const crypto = require('node:crypto');
const { defineModel, field } = require('../_shared/liteorm');
const { openExampleDb, printSummary } = require('../_shared/db');

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const db = openExampleDb('auth');
for (const table of ['login_attempts', 'sessions', 'role_user', 'roles', 'users', 'audit_logs']) {
  try { db.schema.dropTable(table); } catch (_) {}
}

db.audit.enable({ actor: () => 'auth-example' });

db.schema.createTable('users', t => {
  t.increments('id');
  t.text('email').notNull().unique();
  t.text('password_hash').notNull();
  t.text('token_secret');
  t.integer('version').default(0);
  t.timestamps();
});
db.schema.createTable('roles', t => { t.increments('id'); t.text('name').notNull().unique(); });
db.schema.createTable('role_user', t => { t.integer('user_id').notNull().references('users', 'id'); t.integer('role_id').notNull().references('roles', 'id'); t.unique(['user_id', 'role_id']); });
db.schema.createTable('sessions', t => { t.increments('id'); t.integer('user_id').notNull().references('users', 'id'); t.text('token').notNull(); t.timestamps(); });
db.schema.createTable('login_attempts', t => { t.increments('id'); t.text('email').notNull(); t.integer('success').default(0); t.timestamps(); });

const User = defineModel(db, 'users', {
  timestamps: true,
  optimisticLock: true,
  fields: {
    email: field.text().required().email(),
    password_hash: field.text().hidden(),
    token_secret: field.text().encrypted(),
    version: field.integer().default(0)
  },
  hidden: ['password_hash', 'token_secret'],
  relations: { roles: { type: 'belongsToMany', model: 'roles', pivot: 'role_user', foreignPivotKey: 'user_id', relatedPivotKey: 'role_id' } }
});
const Role = defineModel(db, 'roles', { relations: { users: { type: 'belongsToMany', model: 'users', pivot: 'role_user', foreignPivotKey: 'role_id', relatedPivotKey: 'user_id' } } });
const Session = defineModel(db, 'sessions', { timestamps: true });
const Attempt = defineModel(db, 'login_attempts', { timestamps: true });

const passwordHash = hashPassword('correct horse battery staple', Buffer.from('0123456789abcdef'));
const user = User.create({ email: 'admin@test.local', password_hash: passwordHash, token_secret: 'session-secret' });
const role = Role.create({ name: 'admin' });
db.exec('INSERT INTO role_user(user_id, role_id) VALUES(?, ?)', [user.id, role.id]);

const loginOk = verifyPassword('correct horse battery staple', User.find(user.id, true).password_hash);
Attempt.create({ email: user.email, success: loginOk ? 1 : 0 });
const session = loginOk ? Session.create({ user_id: user.id, token: crypto.createHash('sha256').update(`${user.email}:demo`).digest('hex') }) : null;

const loaded = User.query().with('roles').where('id', '=', user.id).first();

printSummary({
  signup: user.id ? 'ok' : 'failed',
  login: loginOk ? 'ok' : 'failed',
  hasAdminRole: loaded.roles.some(r => r.name === 'admin'),
  sessionValid: Boolean(session && session.token.length === 64),
  auditRows: db.query('SELECT COUNT(*) AS n FROM audit_logs')[0].n
});

db.close();
