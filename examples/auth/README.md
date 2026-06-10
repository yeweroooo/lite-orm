# Auth example

Demonstrates validation, password hashing with Node built-in crypto, encrypted casts, audit logs, optimistic locking, sessions, and many-to-many roles.

Run from the repository root:

```bash
node examples/auth/index.js
```

Use a persistent SQLite file:

```bash
LITEORM_DB=./auth.sqlite node examples/auth/index.js
```
