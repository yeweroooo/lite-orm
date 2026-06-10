import { Database, defineModel, field, errors } from '../types';

type User = {
  id: number;
  email: string;
  name: string;
  version: number;
};

const db = new Database(':memory:', {
  retry: { attempts: 2, delay: 1 },
  busyTimeout: 1000,
  encryptionKey: 'type-smoke-key'
});

const UserModel = defineModel<User>(db, 'users', {
  fields: {
    email: field.text().required().email(),
    name: field.text().min(2),
    version: field.integer().default(0)
  },
  optimisticLock: true,
  scopes: {
    named: q => q.where('name', '=', 'Smoke')
  }
});

const created = UserModel.create({ email: 'smoke@test.local', name: 'Smoke' });
created.toJSON();

const found = UserModel.query()
  .with('roles', q => q.where('name', '=', 'admin'))
  .withCount('posts')
  .where('email', '=', 'smoke@test.local')
  .first();

if (found) found.toJSON();

const page = UserModel.query().cursorPaginate({ limit: 10 });
if (page.data[0]) page.data[0].toJSON();

try {
  UserModel.create({ email: 'bad' });
} catch (err) {
  if (err instanceof errors.ValidationError) {
    console.error(err.message);
  }
}
