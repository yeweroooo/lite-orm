# Examples

The examples are included in the npm package and use no third-party runtime dependencies.

Run from a source checkout:

```bash
npm run build
node examples/todo/index.js
node examples/blog/index.js
node examples/auth/index.js
```

Run all examples:

```bash
npm run test:examples
```

Run with a persistent SQLite file:

```bash
LITEORM_DB=./todo.sqlite node examples/todo/index.js
LITEORM_DB=./blog.sqlite node examples/blog/index.js
LITEORM_DB=./auth.sqlite node examples/auth/index.js
```

Run from an installed package:

```bash
node node_modules/@ghuts/liteorm/examples/todo/index.js
node node_modules/@ghuts/liteorm/examples/blog/index.js
node node_modules/@ghuts/liteorm/examples/auth/index.js
```

## What each example demonstrates

- `todo`: schema builder, validators, scopes, JSON fields, transactions, soft deletes.
- `blog`: hasMany, belongsTo, belongsToMany, FTS5 search, relation count, hidden/computed fields.
- `auth`: password hashing with `node:crypto`, encrypted field casts, audit logs, many-to-many roles, sessions.
