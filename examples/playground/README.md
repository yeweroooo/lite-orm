# LiteORM playground

Run a compact end-to-end example that uses paranoid soft deletes, lifecycle hooks, CDC, JSON fields, and statement cache stats.

```bash
node examples/playground/index.js
LITEORM_PROFILE=1 node examples/playground/index.js
```

The script uses `:memory:` by default. Set `LITEORM_DB=playground.sqlite` to persist the database.
