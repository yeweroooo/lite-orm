# Package readiness checklist

Use this before publishing a new release of `@ghuts/liteorm`.

## Metadata

```bash
npm pkg get name version repository homepage bugs publishConfig --json
```

Expected:

- name is `@ghuts/liteorm`
- `publishConfig.access` is `public`
- repository/homepage/bugs point at `https://github.com/yeweroooo/lite-orm`

## Zero runtime dependencies

```bash
node - <<'NODE'
const p = require('./package.json');
for (const k of ['dependencies','optionalDependencies','peerDependencies','bundleDependencies','bundledDependencies']) {
  if (p[k]) throw new Error(k + ' must be absent for zero runtime deps');
}
console.log('zero runtime dependency fields: ok');
NODE
```

Development dependencies such as TypeScript are allowed for repository checks; they are not installed as runtime dependencies when users install `@ghuts/liteorm`.

## Build and tests

```bash
npm run build
npm test
npm run test:types
npm run test:examples
node bin/lite-orm.js doctor
```

## Tarball smoke test

```bash
PACK_DIR="$(mktemp -d)"
SMOKE_DIR="$(mktemp -d)"
npm pack --pack-destination "$PACK_DIR"
PKG_PATH="$(node -e "const fs=require('fs'),path=require('path'); const d=process.argv[1]; const f=fs.readdirSync(d).find(x=>x.endsWith('.tgz')); if(!f) throw new Error('tarball not found'); console.log(path.join(d,f));" "$PACK_DIR")"

(
  cd "$SMOKE_DIR"
  npm init -y >/dev/null
  npm install "$PKG_PATH"
  node - <<'NODE'
const { Database, defineModel, field } = require('@ghuts/liteorm');
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
db.close();
NODE
  node node_modules/@ghuts/liteorm/examples/todo/index.js
)
```

## Publish dry-run

```bash
npm pack --dry-run
npm publish --dry-run --access public
```

## Publish

```bash
npm publish --access public
```

If npm requires OTP/passkey, complete browser authentication or pass `--otp=<code>`.
