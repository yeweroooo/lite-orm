export type WhereOp = '=' | '!=' | '<>' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'GLOB' | 'IS' | 'IS NOT';
export type Validator<T, K extends keyof T> = (value: T[K], row: Partial<T>) => true | undefined | string | false;
export type LifecycleHookName = 'beforeValidate' | 'afterValidate' | 'beforeCreate' | 'afterCreate' | 'beforeUpdate' | 'afterUpdate' | 'beforeDelete' | 'afterDelete' | 'beforeDestroy' | 'afterDestroy' | 'beforeRestore' | 'afterRestore' | 'beforeSave' | 'afterSave' | 'beforeUpsert' | 'afterUpsert';
export interface HookContext<T extends Record<string, any>> { db: Database; model: Model<T>; table: string; op: string; row?: Partial<T> | T; previous?: Partial<T> | T | Array<Partial<T> | T>; changes?: number; actor?: unknown; abort(reason?: string): never; }
export type Relation =
  | { type: 'hasMany'; model: string; foreignKey: string; localKey?: string }
  | { type: 'hasOne'; model: string; foreignKey: string; localKey?: string }
  | { type: 'belongsTo'; model: string; foreignKey: string; ownerKey?: string }
  | { type: 'belongsToMany'; model: string; pivot: string; foreignPivotKey: string; relatedPivotKey: string };
export interface Migration { id: string; up(db: Database): void; down?(db: Database): void; }
export interface SQLStatement { text: string; params: unknown[]; }
export declare function sql(strings: TemplateStringsArray, ...values: unknown[]): SQLStatement;

export interface ValidationIssue { field: string; code: string; message: string; value?: unknown; }
export interface ValidationResult { valid: boolean; issues: ValidationIssue[]; }
export interface ChangeRecord { seq: number; table: string; table_name?: string; rowId: string; row_id?: string; op: string; oldValues?: any; newValues?: any; source?: string; txId?: string | null; created_at?: string; }
export interface ProfileEvent { kind: 'query' | 'exec'; sql: string; params: unknown[]; durationMs: number; changes?: number | bigint; lastInsertRowid?: number | bigint; rows?: number; error?: string; }

export declare class FieldDef<TValue = unknown> {
  primary(): this; autoIncrement(): this; required(): this; notNull(): this; nullable(): this; unique(): this; hidden(): this;
  default(value: TValue | (() => TValue) | unknown): this; references(table: string, column?: string): this;
  min(n: number): this; max(n: number): this; email(): this; regex(re: RegExp): this; enum(values: readonly TValue[] | unknown[]): this; encrypted(): this; validJson(): this;
  check(code: string, fn: (value: TValue, row: any) => boolean | string | void, message?: string): this;
}
export declare const field: { integer<T = number>(): FieldDef<T>; text<T = string>(): FieldDef<T>; real<T = number>(): FieldDef<T>; boolean<T = boolean>(): FieldDef<T>; json<T = unknown>(): FieldDef<T>; blob<T = Uint8Array>(): FieldDef<T> };

export type ModelInstance<T extends Record<string, any>> = T & { toJSON(): Record<string, unknown>; getChanges(): Partial<T>; save(): number; reload(): ModelInstance<T>; delete(force?: boolean): number; restore(): number; };
export type Actor = Record<string, any> | null | undefined;
export interface PolicyContext<T extends Record<string, any>> { actor: any; model: Model<T>; row?: Partial<T> | T; q?: QueryBuilder<T>; field?: string; action: string; }
export type Policy<T extends Record<string, any>> = boolean | ((ctx: PolicyContext<T>) => boolean | void | QueryBuilder<T>);
export interface ModelPolicies<T extends Record<string, any>> { read?: Policy<T>; create?: Policy<T>; update?: Policy<T>; delete?: Policy<T>; fields?: Record<string, Partial<Record<'read' | 'create' | 'update' | 'delete', Policy<T>>>>; }
export interface ModelOptions<T extends Record<string, any>> {
  fields?: Partial<Record<keyof T & string, FieldDef<any>>>;
  softDelete?: boolean; paranoid?: boolean; deletedAt?: keyof T & string; timestamps?: boolean; json?: (keyof T & string)[];
  optimisticLock?: boolean; strict?: boolean | 'strip';
  validate?: Partial<{ [K in keyof T]: Validator<T, K> }>;
  relations?: Record<string, Relation>; hidden?: (keyof T & string)[]; computed?: Record<string, (row: T) => unknown>; scopes?: Record<string, (q: QueryBuilder<T>) => void>;
  policies?: ModelPolicies<T>; fts?: { table: string; columns?: string[] };
}

export type InferModel<M> = M extends Model<infer T, any, any> ? T : never;
export type InferCreateInput<M> = M extends Model<infer T, infer C, any> ? C : never;
export type InferUpdateInput<M> = M extends Model<infer T, any, infer U> ? U : never;
export type InferJSON<M> = Partial<InferModel<M>> & Record<string, unknown>;

export declare class Statement<T = Record<string, unknown>> { all(params?: unknown[]): T[]; get(params?: unknown[]): T | null; run(params?: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }; finalize(): void; columns(): string[]; readonly(): boolean; }
export declare class SchemaBuilder { createTable(name: string, fn: (t: TableBuilder) => void): void; dropTable(name: string): void; renameTable(from: string, to: string): void; addColumn(table: string, name: string, def: FieldDef): void; table(name: string, fn: (t: TableBuilder) => void): void; diff(table: string, fields: Record<string, FieldDef>): string[]; generateMigration(name: string, statements: string[], dir?: string): string; }
export declare class TableBuilder { increments(name: string): FieldDef<number>; integer(name: string): FieldDef<number>; text(name: string): FieldDef<string>; real(name: string): FieldDef<number>; json<T = unknown>(name: string, opts?: { valid?: boolean }): FieldDef<T>; boolean(name: string): FieldDef<boolean>; timestamps(): this; softDeletes(column?: string): this; paranoid(opts?: { deletedAt?: string; deletedBy?: string }): this; index(cols: string | string[], name?: string): this; unique(cols: string | string[], name?: string): this; indexJson(path: string, name?: string): this; }
export declare class Inspector { tables(): string[]; columns(table: string): any[]; indexes(table: string): any[]; foreignKeys(table: string): any[]; }
export declare class FTS { create(name: string, opts: { columns: string[]; tokenize?: string; prefix?: number[]; content?: string; contentRowid?: string }): void; sync(name: string, table: string, opts: { columns: string[]; rowid?: string; triggers?: boolean }): this; insert(name: string, row: Record<string, unknown>): void; search<T = Record<string, unknown>>(name: string, term: string, opts?: number | { limit?: number; offset?: number; rank?: boolean; orderByRank?: boolean; highlight?: { column: string | number; before?: string; after?: string }; snippet?: { column?: string | number; before?: string; after?: string; ellipsis?: string; tokens?: number } }): T[]; delete(name: string, rowid: unknown): number; rebuild(name: string): this; optimize(name: string): this; }
export interface CDC { enable(opts?: { table?: string; tables?: string[]; source?: string; actor?: () => string }): this; changes(opts?: { since?: number; table?: string; limit?: number }): ChangeRecord[]; checkpoint(): number; subscribe(fn: (change: ChangeRecord) => void): () => void; apply(changes: ChangeRecord[], opts?: any): { applied: number }; }
export interface SyncHelpers { push(adapter: { send(batch: ChangeRecord[]): number | unknown }, opts?: { since?: number; limit?: number }): { sent: number; changes: ChangeRecord[] }; pull(adapter: { receive(opts?: any): ChangeRecord[] }, opts?: any): { received: number; applied: number }; run(adapter: any, opts?: any): any; }

export declare class Database {
  filename: string; schema: SchemaBuilder; inspect: Inspector; fts: FTS; cdc: CDC; sync: SyncHelpers;
  async: { query<T = Record<string, unknown>>(statement: string | SQLStatement, params?: unknown[]): Promise<T[]>; exec(statement: string | SQLStatement, params?: unknown[]): Promise<any>; transaction<T>(fn: (tx: Database) => T): Promise<T> };
  constructor(filename?: string, options?: { cache?: { ttl?: number; max?: number }; busyTimeout?: number; retry?: { attempts?: number; delay?: number }; encryptionKey?: string | Uint8Array; statementCache?: number | false; wal?: boolean; journalMode?: string; synchronous?: string });
  exec(statement: string | SQLStatement, params?: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  query<T = Record<string, unknown>>(statement: string | SQLStatement, params?: unknown[], cache?: number | { ttl: number; max?: number }): T[];
  prepare<T = Record<string, unknown>>(text: string): Statement<T>; clearCache(): void; close(): void;
  clearStatementCache(): this; statementCacheStats(): { size: number; max: number; hits: number; misses: number; evictions: number }; setStatementCacheSize(max: number): this;
  inTransaction(): boolean; transaction<T>(fn: (tx: Database) => T, options?: { mode?: 'deferred' | 'immediate' | 'exclusive'; retries?: number; retryDelay?: number; savepoint?: boolean; name?: string }): T; savepoint<T>(fn: (tx: Database) => T, name?: string): T; setBusyTimeout(ms: number): this;
  migrate(migrations: Migration[]): string[]; rollbackMigrations(steps?: number): string[]; backup(file: string): string; restore(file: string): void; explain(query: QueryBuilder<any> | SQLStatement | string): any[]; use(plugin: (db: Database, opts?: any) => void, opts?: any): this;
  pragma(name: string, value?: string | number): any; tune(opts: { journalMode?: string; synchronous?: string; busyTimeout?: number; cacheSize?: number; tempStore?: string; mmapSize?: number; walAutocheckpoint?: number }): this; checkpoint(mode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'): any; optimize(): this;
  createFunction(name: string, fn: (...args: any[]) => any, opts?: { arity?: number; deterministic?: boolean; directOnly?: boolean; innocuous?: boolean }): this; dropFunction(name: string, arity?: number): this; createCollation(name: string, compare: (a: string, b: string) => number): this; dropCollation(name: string): this;
  profile(fn: ((ev: ProfileEvent) => void) | null, opts?: { thresholdMs?: number; expandedSql?: boolean }): this; on(name: 'query' | 'change' | string, fn: (payload: any) => void): () => void; off(name: string, fn: (payload: any) => void): this;
  audit: { enable(opts?: { table?: string; actor?: string | (() => string) }): void }; export: { json(table: string, file: string): string; csv(table: string, file: string): string }; import: { json(table: string, file: string): number };
  factory<T extends Record<string, any>>(model: Model<T>, fn: (i: number) => Partial<T>): { createMany(n: number): T[] }; seed(fns: Array<(db: Database) => unknown>): unknown[]; seedDeterministic<T extends Record<string, any>>(model: Model<T>, fn: (i: number) => Partial<T>, count: number): T[]; repo<T extends Record<string, any>, R>(model: Model<T>, Repo: new (model: Model<T>, db: Database) => R): R;
  as<T>(actor: Actor, fn: (db: Database) => T): T; asSystem<T>(fn: (db: Database) => T): T; rotateEncryptionKey(models: Model<any>[], newKey: string | Uint8Array): number;
}

export declare class QueryBuilder<T extends Record<string, any>> {
  select<K extends keyof T & string>(cols: K[] | K, ...more: K[]): QueryBuilder<Pick<T, K>>; distinct(): this;
  where(fn: (q: QueryBuilder<T>) => void): this; where<K extends keyof T & string>(column: K, op: WhereOp, value: T[K]): this;
  orWhere(fn: (q: QueryBuilder<T>) => void): this; orWhere<K extends keyof T & string>(column: K, op: WhereOp, value: T[K]): this;
  whereNot<K extends keyof T & string>(column: K, op: WhereOp, value: T[K]): this; whereIn<K extends keyof T & string>(column: K, values: T[K][]): this; whereNull(column: keyof T & string): this; whereBetween<K extends keyof T & string>(column: K, a: T[K], b: T[K]): this; whereExists(subquery: string | QueryBuilder<any>, params?: unknown[]): this;
  whereJson(path: string, op: WhereOp, value: unknown): this; whereJsonExists(path: string): this; whereJsonContains(path: string, value: unknown): this; whereJsonLength(path: string, op: WhereOp, value: number): this; orderByJson(path: string, dir?: 'asc' | 'desc' | 'ASC' | 'DESC'): this;
  join(table: string, left: string, op: string, right: string): this; leftJoin(table: string, left: string, op: string, right: string): this; groupBy(...cols: string[]): this; having(expr: string, params?: unknown[]): this;
  orderBy(column: keyof T & string | string, dir?: 'asc' | 'desc' | 'ASC' | 'DESC'): this; limit(n: number): this; offset(n: number): this; with(name: string, constraint?: (q: QueryBuilder<any>) => void): this; withCount(name: string): this; withDeleted(): this; withTrashed(): this; onlyDeleted(): this; onlyTrashed(): this; cache(ttl?: number): this; scope(name: string): this;
  toSQL(select?: string): SQLStatement; get<R extends Record<string, any> = T>(): ModelInstance<R>[]; first<R extends Record<string, any> = T>(): ModelInstance<R> | null; count(): number; update(data: Partial<T>): number; delete(force?: boolean): number; restore(): number;
  jsonSet(path: string, value: unknown): number; jsonPatch(column: string, patch: unknown): number; jsonRemove(path: string): number;
  insert(data: Partial<T>): this; onConflict(cols: string | string[]): this; ignore(): any; merge(cols?: string[]): any; cursorPaginate<R extends Record<string, any> = T>(opts?: { after?: unknown; limit?: number; column?: string; direction?: 'asc' | 'desc' }): { data: ModelInstance<R>[]; hasMore: boolean; nextCursor: unknown };
}
export declare class Model<T extends Record<string, any>, TCreate = Partial<T>, TUpdate = Partial<T>> {
  readonly db: Database; readonly table: string;
  query(): QueryBuilder<T>; using(db: Database): Model<T, TCreate, TUpdate>; hook(name: LifecycleHookName, fn: (row: Partial<T> | T, ctx: HookContext<T>) => void | false): () => void;
  validate(data: Partial<T>, opts?: { mode?: 'create' | 'update'; partial?: boolean; strict?: boolean }): ValidationResult; assertValid(data: Partial<T>, opts?: { mode?: 'create' | 'update'; partial?: boolean; strict?: boolean }): void;
  create(data: TCreate): ModelInstance<T>; insertMany(rows: TCreate[]): ModelInstance<T>[]; upsert(data: TCreate, conflictCols: string | string[], mergeCols?: string[]): any;
  find(id: number | bigint, withDeleted?: boolean): ModelInstance<T> | null; delete(id: number | bigint, force?: boolean): number; forceDelete(id: number | bigint): number; restore(id: number | bigint): number; search(term: string, opts?: any): ModelInstance<T>[];
  can(action: 'read' | 'create' | 'update' | 'delete' | string, actor: Actor, row?: Partial<T> | T): boolean; authorize(action: string, actor: Actor, row?: Partial<T> | T): void;
}
export declare function defineModel<T extends Record<string, any>, TCreate = Partial<T>, TUpdate = Partial<T>>(db: Database, table: string, options?: ModelOptions<T>): Model<T, TCreate, TUpdate>;
export declare function createSqlJsAdapter(SQL: any, filename?: string): { exec(sql: string, params?: unknown[]): any; query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]; export(): Uint8Array; close(): void };
export declare const sqliteVersion: string;
export declare const errors: { ORMError: typeof Error; ValidationError: typeof Error; QueryError: typeof Error; MigrationError: typeof Error; ConflictError: typeof Error; NotFoundError: typeof Error; SQLiteBusyError: typeof Error; HookAbortError: typeof Error; AuthorizationError: typeof Error; };
