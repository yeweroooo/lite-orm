# Lite ORM

Zero-dependency native SQLite ORM for Node.js.

Lite ORM is a lightweight SQLite-first ORM built around a C++ N-API addon and a small JavaScript ORM layer. It gives you a query builder, schema builder, migrations, typed models, relationships, validation, transactions, caching, hooks, soft deletes, JSON fields, FTS5, encryption casts, audit logs, CLI utilities, and TypeScript declarations without adding runtime npm dependencies.

Current version: 1.0.0

Package name: `lite-orm`

## Highlights

- Native SQLite bridge using C++ N-API.
- Zero runtime npm dependencies.
- SQLite-first design: WAL, foreign keys, JSON1, FTS5, PRAGMA tuning, backup via `VACUUM INTO`.
- Query Builder: filters, grouped conditions, joins, ordering, grouping, pagination, update/delete.
- Schema Builder: create/drop/rename tables, columns, indexes, unique indexes.
- Models: field definitions, validators, defaults, JSON casts, encrypted casts, hidden/computed fields.
- Relationships: `hasOne`, `hasMany`, `belongsTo`, `belongsToMany`.
- Migrations: run once, rollback, generate migration from schema diff.
- TypeScript declarations included.
- Transactions, caching, hooks, soft delete, restore, model instances, dirty tracking.
- FTS5 search helper.
- Introspection and explain query plan.
- Audit log helper.
- Factory, seeder, export/import JSON/CSV, repository helper.
- CLI: init, inspect, migration generator, SQL studio exec, JSON export.

## Requirements

- Node.js >= 18
- npm
- C++ compiler
- Python available to node-gyp
- SQLite development library available to the system linker
- node-gyp available through npm lifecycle

On Debian/Ubuntu-like systems:

```bash
sudo apt-get install -y build-essential python3 libsqlite3-dev
```

## Installation

From npm after publish:

```bash
npm install lite-orm
```

From local tarball:

```bash
npm install /home/adt/Documents/orm/lite-orm-1.0.0.tgz
```

From local project folder:

```bash
cd /home/adt/Documents/orm
npm install
npm run build
npm test
```

The package runs `node-gyp rebuild` during npm install.

## Quick start

```js
const { Database, defineModel, field } = require('lite-orm');

const db = new Database('app.sqlite');

db.schema.createTable('users', t => {
  t.increments('id');
  t.text('name').notNull();
  t.text('email').notNull().unique();
  t.text('role').default('user');
  t.json('meta');
  t.timestamps();
  t.softDeletes();
});

const User = defineModel(db, 'users', {
  fields: {
    id: field.integer().primary().autoIncrement(),
    name: field.text().required().min(2),
    email: field.text().required().email(),
    role: field.text().default('user'),
    password: field.text().hidden(),
    meta: field.json().default({})
  },
  softDelete: true,
  timestamps: true,
  json: ['meta'],
  hidden: ['password'],
  scopes: {
    admins: q => q.where('role', '=', 'admin')
  },
  computed: {
    label: user => `${user.name}<${user.email}>`
  }
});

User.create({
  name: 'Adit',
  email: 'adit@test.local',
  role: 'admin',
  password: 'hidden-value',
  meta: { tier: 'pro' }
});

const rows = User.query()
  .where('role', '=', 'admin')
  .whereJson('meta.tier', '=', 'pro')
  .orderBy('id', 'desc')
  .get();

console.log(rows.map(row => row.toJSON()));
```

## Imports

CommonJS:

```js
const {
  Database,
  defineModel,
  Model,
  QueryBuilder,
  field,
  sql,
  errors,
  sqliteVersion
} = require('lite-orm');
```

TypeScript:

```ts
import { Database, defineModel, field, errors } from 'lite-orm';
```

## Database API

### Create/open database

```js
const db = new Database('app.sqlite');
const memory = new Database(':memory:');
```

With options:

```js
const db = new Database('app.sqlite', {
  cache: { ttl: 1000, max: 500 },
  busyTimeout: 5000,
  retry: { attempts: 3, delay: 10 },
  encryptionKey: Buffer.from('01234567890123456789012345678901')
});
```

### Raw query and exec

```js
db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT)');
db.exec('INSERT INTO users(email) VALUES(?)', ['a@test.local']);

const rows = db.query('SELECT * FROM users WHERE email = ?', ['a@test.local']);
console.log(rows);
```

### SQL tagged template

```js
const { sql } = require('lite-orm');

const rows = db.query(sql`SELECT * FROM users WHERE email = ${'a@test.local'}`);
```

The tag returns `{ text, params }`.

### Transactions

```js
db.transaction(tx => {
  tx.exec('INSERT INTO users(email) VALUES(?)', ['a@test.local']);
  tx.exec('INSERT INTO users(email) VALUES(?)', ['b@test.local']);
});
```

If the callback throws, the transaction rolls back.

### Async wrapper

```js
const rows = await db.async.query('SELECT * FROM users');
await db.async.exec('INSERT INTO users(email) VALUES(?)', ['a@test.local']);
```

Current async API is a Promise-compatible wrapper around the sync native calls, so the API is ready for a future worker-thread backend without breaking user code.

### Prepared statement facade

```js
const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
const one = stmt.get(['a@test.local']);
const all = stmt.all(['a@test.local']);
stmt.finalize();
```

`stmt.run(params)` is available for write statements.

### PRAGMA tuning

```js
db.tune({
  journalMode: 'WAL',
  synchronous: 'NORMAL',
  busyTimeout: 5000,
  cacheSize: -64000,
  tempStore: 'MEMORY',
  mmapSize: 268435456
});
```

Supported option names:

- `journalMode` -> `PRAGMA journal_mode`
- `synchronous` -> `PRAGMA synchronous`
- `busyTimeout` -> `PRAGMA busy_timeout`
- `cacheSize` -> `PRAGMA cache_size`
- `tempStore` -> `PRAGMA temp_store`
- `mmapSize` -> `PRAGMA mmap_size`

### Backup and restore

```js
db.backup('backup.sqlite');
db.restore('backup.sqlite');
```

Backup uses SQLite `VACUUM INTO`.

### Explain query plan

```js
const plan = db.explain(User.query().where('email', '=', 'a@test.local'));
console.log(plan);
```

### Plugins

```js
db.use((database, opts) => {
  database.hello = () => `hello ${opts.name}`;
}, { name: 'orm' });

console.log(db.hello());
```

## Schema Builder

### Create table

```js
db.schema.createTable('users', t => {
  t.increments('id');
  t.text('name').notNull();
  t.text('email').notNull().unique();
  t.integer('age').default(0);
  t.real('score').default(0);
  t.boolean('active').default(1);
  t.json('meta');
  t.timestamps();
  t.softDeletes();
  t.index(['email']);
  t.unique(['email']);
});
```

### Column helpers

- `t.increments(name)`
- `t.integer(name)`
- `t.text(name)`
- `t.real(name)`
- `t.boolean(name)`
- `t.json(name)`
- `t.timestamps()` creates `created_at` and `updated_at`
- `t.softDeletes()` creates `deleted_at`

### Column modifiers

- `.primary()`
- `.autoIncrement()`
- `.required()` / `.notNull()`
- `.nullable()`
- `.unique()`
- `.default(value)`
- `.references(table, column = 'id')`

Example:

```js
db.schema.createTable('posts', t => {
  t.increments('id');
  t.integer('user_id').notNull().references('users', 'id');
  t.text('title').notNull();
  t.text('body');
  t.timestamps();
});
```

### Schema maintenance

```js
db.schema.dropTable('old_table');
db.schema.renameTable('old_name', 'new_name');
db.schema.addColumn('users', 'phone', field.text().nullable());
db.schema.table('users', t => {
  t.index(['email']);
});
```

### Schema diff and generated migration

```js
const statements = db.schema.diff('users', {
  phone: field.text().nullable(),
  nickname: field.text().nullable()
});

const file = db.schema.generateMigration('add_user_contact_fields', statements, './migrations');
console.log(file);
```

`diff()` currently detects missing columns and produces `ALTER TABLE ... ADD COLUMN ...` statements.

## Field definitions

Field definitions describe model behavior and validation.

```js
const User = defineModel(db, 'users', {
  fields: {
    id: field.integer().primary().autoIncrement(),
    name: field.text().required().min(2).max(80),
    email: field.text().required().email().unique(),
    role: field.text().enum(['user', 'admin']).default('user'),
    token: field.text().encrypted(),
    meta: field.json().default({}),
    password: field.text().hidden(),
    version: field.integer().default(0)
  }
});
```

Available field types:

- `field.integer()`
- `field.text()`
- `field.real()`
- `field.boolean()`
- `field.json()`
- `field.blob()`

Available field validators/modifiers:

- `.required()`
- `.notNull()`
- `.nullable()`
- `.unique()`
- `.default(value)`
- `.hidden()`
- `.references(table, column)`
- `.min(n)`
- `.max(n)`
- `.email()`
- `.regex(regexp)`
- `.enum(values)`
- `.encrypted()`

## Models

### Define a model

```js
const User = defineModel(db, 'users', {
  fields: {
    name: field.text().required(),
    email: field.text().required().email()
  },
  timestamps: true,
  softDelete: true,
  json: ['meta'],
  hidden: ['password'],
  computed: {
    displayName: user => `${user.name} <${user.email}>`
  },
  validate: {
    email: v => String(v).includes('@') || 'email invalid'
  },
  scopes: {
    active: q => q.where('active', '=', 1)
  }
});
```

### Create/find/update/delete

```js
const user = User.create({ name: 'Adit', email: 'adit@test.local' });
const same = User.find(user.id);

User.query()
  .where('id', '=', user.id)
  .update({ name: 'Adit Baru' });

User.delete(user.id);        // soft delete if enabled
User.restore(user.id);       // restore soft-deleted row
User.delete(user.id, true);  // force delete
```

### Bulk insert

```js
const users = User.insertMany([
  { name: 'A', email: 'a@test.local' },
  { name: 'B', email: 'b@test.local' }
]);
```

### Upsert

```js
User.upsert(
  { email: 'a@test.local', name: 'A Updated' },
  ['email'],
  ['name']
);
```

Query-builder form:

```js
User.query()
  .insert({ email: 'a@test.local', name: 'A' })
  .onConflict('email')
  .merge(['name']);

User.query()
  .insert({ email: 'a@test.local', name: 'A' })
  .onConflict('email')
  .ignore();
```

### Model instances and dirty tracking

Rows returned from models include non-enumerable helpers.

```js
const user = User.find(1);

user.name = 'Adit Baru';
console.log(user.getChanges());
// { name: 'Adit Baru' }

user.save();
user.reload();
user.delete();
user.restore();

console.log(user.toJSON());
```

### Optimistic locking

Use a `version` column and enable `optimisticLock`.

```js
const User = defineModel(db, 'users', {
  fields: {
    name: field.text(),
    version: field.integer().default(0)
  },
  optimisticLock: true
});

const user = User.find(1);
user.name = 'New Name';
user.save();
```

If another writer changes the version before `save()`, `errors.ConflictError` is thrown.

### Hidden and computed fields

```js
const User = defineModel(db, 'users', {
  hidden: ['password', 'token'],
  computed: {
    label: u => `${u.name}<${u.email}>`
  }
});

const user = User.find(1);
console.log(user.toJSON());
```

Hidden fields are excluded from `toJSON()`.

## Query Builder

### Basic select

```js
const rows = User.query()
  .select(['users.id', 'users.email'])
  .where('users.email', 'LIKE', '%@test.local')
  .orderBy('users.id', 'desc')
  .limit(20)
  .offset(0)
  .get();
```

### First row

```js
const user = User.query()
  .where('email', '=', 'a@test.local')
  .first();
```

### Count

```js
const total = User.query().where('role', '=', 'admin').count();
```

### Grouped conditions

```js
const rows = User.query()
  .where(q => q
    .where('role', '=', 'admin')
    .orWhere('email', 'LIKE', '%@company.local')
  )
  .whereBetween('age', 18, 60)
  .get();
```

### Supported filters

- `where(column, op, value)`
- `orWhere(column, op, value)`
- `where(q => ...)`
- `orWhere(q => ...)`
- `whereNot(column, op, value)`
- `whereIn(column, values)`
- `whereNull(column)`
- `whereBetween(column, a, b)`
- `whereExists(subquery, params)`
- `whereJson(path, op, value)`

### JSON query

```js
User.query()
  .whereJson('meta.tier', '=', 'pro')
  .get();
```

With table-qualified column:

```js
User.query()
  .whereJson('users.meta.tier', '=', 'pro')
  .get();
```

### Joins

```js
const rows = User.query()
  .select(['users.id', 'users.name', 'profiles.avatar'])
  .leftJoin('profiles', 'profiles.user_id', '=', 'users.id')
  .where('users.id', '>', 0)
  .get();
```

### Group and having

```js
const rows = User.query()
  .select(['role', 'COUNT(*) AS total'])
  .groupBy('role')
  .having('COUNT(*) > ?', [1])
  .get();
```

### Distinct

```js
const roles = User.query()
  .distinct()
  .select(['role'])
  .get();
```

### Update/delete from query

```js
User.query()
  .where('role', '=', 'guest')
  .update({ role: 'user' });

User.query()
  .where('deleted_at', 'IS NOT', null)
  .delete(true);
```

### Soft delete helpers

```js
User.query().get();              // excludes soft-deleted rows
User.query().withDeleted().get();
User.query().onlyDeleted().get();
```

### Scopes

```js
const User = defineModel(db, 'users', {
  scopes: {
    admins: q => q.where('role', '=', 'admin'),
    adults: q => q.where('age', '>=', 18)
  }
});

const rows = User.query()
  .scope('admins')
  .scope('adults')
  .get();
```

### Cursor pagination

```js
const page = User.query()
  .orderBy('id', 'asc')
  .cursorPaginate({ limit: 20, column: 'id' });

console.log(page.data);
console.log(page.nextCursor);
console.log(page.hasMore);

const next = User.query()
  .orderBy('id', 'asc')
  .cursorPaginate({ after: page.nextCursor, limit: 20, column: 'id' });
```

### Query cache

```js
const rows = User.query()
  .where('role', '=', 'admin')
  .cache(5000)
  .get();

db.clearCache();
```

## Relationships

Register related models with the same `Database` instance.

### hasMany

```js
const User = defineModel(db, 'users', {
  relations: {
    posts: { type: 'hasMany', model: 'posts', foreignKey: 'user_id' }
  }
});

const Post = defineModel(db, 'posts', {
  relations: {
    user: { type: 'belongsTo', model: 'users', foreignKey: 'user_id' }
  }
});

const users = User.query().with('posts').get();
```

### hasOne

```js
const User = defineModel(db, 'users', {
  relations: {
    profile: { type: 'hasOne', model: 'profiles', foreignKey: 'user_id' }
  }
});

const users = User.query().with('profile').get();
```

### belongsTo

```js
const Post = defineModel(db, 'posts', {
  relations: {
    user: { type: 'belongsTo', model: 'users', foreignKey: 'user_id' }
  }
});

const post = Post.query().with('user').first();
```

### belongsToMany

```js
db.schema.createTable('role_user', t => {
  t.integer('user_id').notNull().references('users', 'id');
  t.integer('role_id').notNull().references('roles', 'id');
  t.unique(['user_id', 'role_id']);
});

const User = defineModel(db, 'users', {
  relations: {
    roles: {
      type: 'belongsToMany',
      model: 'roles',
      pivot: 'role_user',
      foreignPivotKey: 'user_id',
      relatedPivotKey: 'role_id'
    }
  }
});

const Role = defineModel(db, 'roles', {
  relations: {
    users: {
      type: 'belongsToMany',
      model: 'users',
      pivot: 'role_user',
      foreignPivotKey: 'role_id',
      relatedPivotKey: 'user_id'
    }
  }
});

const user = User.query().with('roles').first();
```

### Constrained eager loading

```js
const user = User.query()
  .with('posts', q => q.where('published', '=', 1).limit(5))
  .first();
```

### Relation counts

```js
const users = User.query()
  .withCount('posts')
  .get();

console.log(users[0].posts_count);
```

## Migrations

### Inline migrations

```js
const migrations = [
  {
    id: '001_create_users',
    up(db) {
      db.schema.createTable('users', t => {
        t.increments('id');
        t.text('email').notNull().unique();
      });
    },
    down(db) {
      db.schema.dropTable('users');
    }
  }
];

db.migrate(migrations);
db.rollbackMigrations(1);
```

Migrations are tracked in `_migrations` and only run once.

### Generate migration file

```js
const diff = db.schema.diff('users', {
  phone: field.text().nullable()
});

const migrationPath = db.schema.generateMigration('add_phone_to_users', diff, './migrations');
console.log(migrationPath);
```

## Validation

### Field validation

```js
const User = defineModel(db, 'users', {
  fields: {
    email: field.text().required().email(),
    username: field.text().required().min(3).max(20).regex(/^[a-z0-9_]+$/),
    role: field.text().enum(['user', 'admin']).default('user')
  }
});
```

### Custom validation

```js
const User = defineModel(db, 'users', {
  validate: {
    email: value => String(value).includes('@') || 'email invalid',
    age: value => Number(value) >= 18 || 'age must be >= 18'
  }
});
```

Validation errors throw `errors.ValidationError`.

```js
try {
  User.create({ email: 'broken' });
} catch (err) {
  if (err instanceof errors.ValidationError) {
    console.error(err.message);
  }
}
```

## Hooks

```js
User.hook('beforeCreate', row => {
  row.email = row.email.toLowerCase();
});

User.hook('afterCreate', row => {
  console.log('created', row.id);
});

User.hook('beforeUpdate', row => {
  row.updated_by = 'system';
});
```

Built-in hook names used by the model layer:

- `beforeCreate`
- `afterCreate`
- `beforeUpdate`

Custom hook names can also be registered for plugins or userland conventions.

## JSON fields

Schema:

```js
db.schema.createTable('users', t => {
  t.increments('id');
  t.json('meta');
});
```

Model:

```js
const User = defineModel(db, 'users', {
  fields: {
    meta: field.json().default({})
  },
  json: ['meta']
});
```

Usage:

```js
User.create({ meta: { tier: 'pro', flags: ['a', 'b'] } });

const rows = User.query()
  .whereJson('meta.tier', '=', 'pro')
  .get();

console.log(rows[0].meta.tier);
```

## Encrypted fields

Encrypted fields use Node built-in `crypto` with AES-256-GCM.

```js
const db = new Database('app.sqlite', {
  encryptionKey: Buffer.from('01234567890123456789012345678901')
});

const User = defineModel(db, 'users', {
  fields: {
    token: field.text().encrypted()
  }
});

const user = User.create({ token: 'secret-token' });
console.log(User.find(user.id).token); // secret-token
```

The raw SQLite value is stored with an `enc:` prefix and decrypted during hydration.

## Audit logs

Enable audit logging:

```js
db.audit.enable({
  actor: () => currentUserId
});
```

This creates `audit_logs` by default:

```sql
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT,
  row_id TEXT,
  action TEXT,
  old_values TEXT,
  new_values TEXT,
  actor_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
```

Tracked actions:

- `create`
- `upsert`
- `delete`
- `forceDelete`
- `restore`

Custom table name:

```js
db.audit.enable({
  table: 'my_audit_logs',
  actor: () => 'system'
});
```

## Full Text Search / FTS5

```js
db.fts.create('posts_search', {
  columns: ['title', 'body']
});

db.fts.insert('posts_search', {
  title: 'SQLite ORM Native',
  body: 'fast local first database'
});

const results = db.fts.search('posts_search', 'native');
console.log(results);
```

## Introspection

```js
console.log(db.inspect.tables());
console.log(db.inspect.columns('users'));
console.log(db.inspect.indexes('users'));
console.log(db.inspect.foreignKeys('posts'));
```

## Seeder and factory

### Factory

```js
db.factory(User, i => ({
  name: `User ${i}`,
  email: `user${i}@test.local`
})).createMany(100);
```

### Seeder

```js
db.seed([
  () => User.insertMany([
    { name: 'A', email: 'a@test.local' },
    { name: 'B', email: 'b@test.local' }
  ]),
  () => Post.create({ user_id: 1, title: 'Hello' })
]);
```

## Export and import

### JSON

```js
db.export.json('users', 'users.json');
db.import.json('users_copy', 'users.json');
```

### CSV

```js
db.export.csv('users', 'users.csv');
```

CSV import is not currently implemented; JSON import is implemented.

## Repository helper

```js
class UserRepo {
  constructor(model, db) {
    this.model = model;
    this.db = db;
  }

  findByEmail(email) {
    return this.model.query().where('email', '=', email).first();
  }
}

const users = db.repo(User, UserRepo);
console.log(users.findByEmail('a@test.local'));
```

## Error classes

```js
const { errors } = require('lite-orm');
```

Available classes:

- `errors.ORMError`
- `errors.ValidationError`
- `errors.QueryError`
- `errors.MigrationError`
- `errors.ConflictError`
- `errors.NotFoundError`
- `errors.SQLiteBusyError`

Example:

```js
try {
  User.create({ email: 'broken' });
} catch (err) {
  if (err instanceof errors.ValidationError) {
    console.error('validation failed', err.message);
  }
}
```

## CLI

After install:

```bash
lite-orm <command>
```

From project source:

```bash
node bin/lite-orm.js <command>
```

### init

```bash
lite-orm init .
```

Creates:

- `migrations/`
- `orm.config.js`

### inspect

```bash
lite-orm inspect app.sqlite
```

Prints tables and columns.

### make:migration

```bash
lite-orm make:migration create_users_table --dir migrations
```

Creates a migration file template.

### studio non-interactive SQL

```bash
lite-orm studio app.sqlite --exec "SELECT COUNT(*) AS n FROM users"
```

Prints JSON rows.

### export JSON

```bash
lite-orm export:json app.sqlite users users.json
```

Exports the table to JSON.

## TypeScript example

```ts
import { Database, defineModel, field } from 'lite-orm';

type UserRow = {
  id: number;
  name: string;
  email: string;
  role: string;
  version: number;
};

const db = new Database('app.sqlite');

const User = defineModel<UserRow>(db, 'users', {
  fields: {
    name: field.text().required(),
    email: field.text().required().email(),
    role: field.text().default('user'),
    version: field.integer().default(0)
  },
  optimisticLock: true
});

const user = User.create({
  name: 'Adit',
  email: 'adit@test.local'
});

const found = User.query()
  .where('email', '=', 'adit@test.local')
  .first();
```

## Complete blog example

```js
const { Database, defineModel, field } = require('lite-orm');

const db = new Database('blog.sqlite');

db.tune({ journalMode: 'WAL', synchronous: 'NORMAL', busyTimeout: 5000 });

db.schema.createTable('users', t => {
  t.increments('id');
  t.text('name').notNull();
  t.text('email').notNull().unique();
  t.text('password').notNull();
  t.integer('version').default(0);
  t.timestamps();
  t.softDeletes();
});

db.schema.createTable('posts', t => {
  t.increments('id');
  t.integer('user_id').notNull().references('users', 'id');
  t.text('title').notNull();
  t.text('body');
  t.json('meta');
  t.timestamps();
  t.softDeletes();
});

const User = defineModel(db, 'users', {
  fields: {
    name: field.text().required().min(2),
    email: field.text().required().email(),
    password: field.text().hidden(),
    version: field.integer().default(0)
  },
  timestamps: true,
  softDelete: true,
  optimisticLock: true,
  hidden: ['password'],
  relations: {
    posts: { type: 'hasMany', model: 'posts', foreignKey: 'user_id' }
  }
});

const Post = defineModel(db, 'posts', {
  fields: {
    user_id: field.integer().required(),
    title: field.text().required(),
    body: field.text(),
    meta: field.json().default({})
  },
  timestamps: true,
  softDelete: true,
  json: ['meta'],
  relations: {
    user: { type: 'belongsTo', model: 'users', foreignKey: 'user_id' }
  }
});

const user = User.create({
  name: 'Adit',
  email: 'adit@test.local',
  password: 'secret'
});

Post.insertMany([
  { user_id: user.id, title: 'Hello SQLite', body: 'Native ORM', meta: { tags: ['sqlite'] } },
  { user_id: user.id, title: 'FTS5 Search', body: 'Fast local search', meta: { tags: ['search'] } }
]);

const loaded = User.query()
  .with('posts')
  .withCount('posts')
  .where('id', '=', user.id)
  .first();

console.log(loaded.toJSON());
console.log(loaded.posts_count);
console.log(loaded.posts.map(p => p.title));
```

## Package structure

```text
lite-orm/
  bin/
    lite-orm.js       CLI
  lib/
    index.js                 ORM JavaScript layer
  src/
    addon.cc                 Native C++ SQLite addon
  types/
    index.d.ts               TypeScript declarations
  binding.gyp                node-gyp build config
  README.md
  LICENSE
  package.json
```

## Development

```bash
git clone <repo>
cd lite-orm
npm install
npm run build
npm test
```

Local source path in this environment:

```bash
cd /home/adt/Documents/orm
```

Run tests:

```bash
npm test
```

Build native addon:

```bash
npm run build
```

Create package tarball:

```bash
npm pack
```

## Publish

The package is prepared for npm publish as v1.0.0.

Pre-publish validation:

```bash
npm run build
npm test
npm pack --dry-run
npm publish --dry-run --access public
```

Publish:

```bash
npm publish --access public
```

Verify registry:

```bash
npm view lite-orm version
```

Expected output:

```text
1.0.0
```

## Smoke test from tarball

```bash
cd /home/adt/Documents/orm
npm pack

TMP=$(mktemp -d)
cd "$TMP"
npm init -y
npm install /home/adt/Documents/orm/lite-orm-1.0.0.tgz

node - <<'NODE'
const { Database, defineModel, field } = require('lite-orm');
const db = new Database(':memory:');
db.schema.createTable('users', t => {
  t.increments('id');
  t.text('email').notNull().unique();
  t.text('name');
});
const User = defineModel(db, 'users', {
  fields: {
    email: field.text().email().required(),
    name: field.text().min(2)
  }
});
User.create({ email: 'smoke@test.local', name: 'Smoke' });
console.log(User.query().count());
NODE
```

Expected output:

```text
1
```

## Current verification status

Last verified in this project:

```text
npm run build: pass
npm test: 13 tests, 13 pass, 0 fail
npm pack --dry-run: pass
npm publish --dry-run --access public: pass
smoke install from lite-orm-1.0.0.tgz: pass
```

## Notes and implementation details

- Runtime npm dependencies: none.
- Native addon links against system SQLite.
- `db.prepare()` is currently a statement facade over the native query/exec methods.
- `db.async.*` is Promise-compatible but uses the current synchronous native backend internally.
- JSON support uses SQLite JSON1 functions for `whereJson`.
- FTS support requires SQLite compiled with FTS5.
- Encryption uses Node built-in `crypto` and AES-256-GCM.

## License

MIT
