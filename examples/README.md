# Lite ORM examples

All examples are dependency-free and can run directly from the repository after the native addon is built.

```bash
npm run build
node examples/todo/index.js
node examples/blog/index.js
node examples/auth/index.js
```

By default examples use an in-memory SQLite database. To persist the data to a file, set `LITEORM_DB`:

```bash
LITEORM_DB=./todo.sqlite node examples/todo/index.js
```

Examples:

- `todo/` — schema builder, scopes, transactions, JSON fields, soft deletes.
- `blog/` — relations, many-to-many tags, FTS5 search, relation counts.
- `auth/` — validation, password hashing, encrypted fields, audit logs, sessions.
