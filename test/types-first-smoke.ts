import { Database, defineModel, field, InferModel, InferCreateInput, InferUpdateInput, HookContext, QueryBuilder } from '../types';

interface UserRow {
  id: number;
  name: string;
  email: string;
  age: number;
  meta: { tier: 'free' | 'pro'; tags: string[] };
  deleted_at: string | null;
}

const db = new Database(':memory:', { statementCache: 16, wal: false });
const User = defineModel<UserRow>(db, 'users', {
  paranoid: true,
  deletedAt: 'deleted_at',
  fields: {
    id: field.integer<number>().primary().autoIncrement(),
    name: field.text<string>().required().min(2),
    email: field.text<string>().required().email(),
    age: field.integer<number>().default(0),
    meta: field.json<UserRow['meta']>().default({ tier: 'free', tags: [] }),
    deleted_at: field.text<string | null>().nullable()
  },
  policies: {
    read: ({ q, actor }) => actor?.role === 'admin' ? true : q!.where('age', '>=', 18),
    fields: { email: { read: ({ actor }) => actor?.role === 'admin' } }
  }
});

type Row = InferModel<typeof User>;
type Create = InferCreateInput<typeof User>;
type Update = InferUpdateInput<typeof User>;

const createPayload: Create = { name: 'Ada', email: 'ada@test.local', meta: { tier: 'pro', tags: ['math'] } };
const updatePayload: Update = { name: 'Ada Lovelace' };
const row: Row = User.create(createPayload);
row.meta.tags.push('code');
User.query().where('age', '>=', 18).whereJsonContains('meta.tags', 'code').orderByJson('meta.tier', 'asc').get();
User.query().withTrashed().onlyTrashed().restore();
User.hook('beforeCreate', (data: Partial<UserRow>, ctx: HookContext<UserRow>) => {
  ctx.abort;
  data.name = String(data.name || '').trim();
});
const stmt = db.prepare<{ n: number }>('SELECT 1 AS n');
const got = stmt.get();
if (got) got.n.toFixed();
db.createFunction('twice', (n: number) => n * 2, { deterministic: true });
db.createCollation('NOCASE_ID', (a, b) => a.localeCompare(b));
db.profile(ev => ev.durationMs.toFixed(), { thresholdMs: 0 });
const changes = db.cdc.changes({ since: 0 });
changes.forEach(c => c.seq.toFixed());

// @ts-expect-error unknown model field rejected by create type
const badCreate: Create = { does_not_exist: true };
// @ts-expect-error wrong typed where value rejected for known key
User.query().where('age', '=', 'old');
// @ts-expect-error invalid hook name rejected
User.hook('notALifecycleHook', () => {});
// @ts-expect-error invalid order direction rejected
User.query().orderByJson('meta.tier', 'sideways');

function acceptsQuery(q: QueryBuilder<UserRow>) { return q; }
acceptsQuery(User.query());
void updatePayload;
