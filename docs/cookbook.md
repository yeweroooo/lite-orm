# LiteORM cookbook

Practical recipes for the native C++ SQLite ORM package.

## Auth + RBAC

```js
const db = new Database('app.sqlite');
const User = defineModel(db, 'users', {
  policies: {
    read: ({ actor, q }) => actor.role === 'admin' ? true : q.where('tenant_id', '=', actor.tenant_id),
    create: ({ actor }) => actor.role === 'admin',
    fields: { password_hash: { read: false } }
  }
});

db.as({ id: 1, role: 'admin', tenant_id: 7 }, () => User.create({ email: 'a@b.test' }));
```

## Multi-tenant query scopes

Use a `read` policy to inject tenant predicates. Raw `db.exec()` remains an explicit escape hatch.

## Tests with in-memory DB

```js
const db = new Database(':memory:', { wal: false, statementCache: 0 });
db.seed([db => User.insertMany([{ name: 'Ada' }, { name: 'Budi' }])]);
```

## Paranoid soft deletes

```js
const User = defineModel(db, 'users', { paranoid: true, deletedAt: 'removed_at' });
User.delete(1);                  // UPDATE removed_at
User.query().withTrashed().get(); // include deleted
User.query().onlyTrashed().restore();
User.forceDelete(1);             // physical delete
```

## Lifecycle hooks

Hooks are synchronous and abortable. Throw, return `false`, or call `ctx.abort()` to cancel.

```js
User.hook('beforeCreate', (row, ctx) => {
  if (!row.email.endsWith('@company.test')) ctx.abort('company email required');
});
```

## Realtime local changes

```js
db.cdc.enable({ source: 'desktop' });
const stop = db.cdc.subscribe(change => console.log(change));
```

## JSON and FTS5

```js
User.query().whereJsonContains('meta.tags', 'pro').orderByJson('meta.score', 'desc').get();
db.fts.create('user_search', { columns: ['name', 'email'], tokenize: 'unicode61', prefix: [2, 3] });
db.fts.sync('user_search', 'users', { columns: ['name', 'email'], triggers: true });
db.fts.search('user_search', 'ada', { rank: true, highlight: { column: 'name', before: '[', after: ']' } });
```

## UDF and collation

```js
db.createFunction('slugify', s => String(s).toLowerCase().replace(/\s+/g, '-'), { deterministic: true });
db.createCollation('REVERSE', (a, b) => b.localeCompare(a));
```

## Migrations CLI

```bash
lite-orm generate model User --fields name:string,email:string
lite-orm migrate:preview app.sqlite --dir migrations
lite-orm migrate app.sqlite --dir migrations
lite-orm migrate:status app.sqlite --dir migrations
lite-orm migrate:seed app.sqlite --dir seeders
lite-orm migrate:rollback app.sqlite --dir migrations --steps 1
```
