export type Validator<T, K extends keyof T> = (value: T[K], row: Partial<T>) => true | undefined | string | false;
export type Relation =
  | { type: 'hasMany'; model: string; foreignKey: string; localKey?: string }
  | { type: 'hasOne'; model: string; foreignKey: string; localKey?: string }
  | { type: 'belongsTo'; model: string; foreignKey: string; ownerKey?: string }
  | { type: 'belongsToMany'; model: string; pivot: string; foreignPivotKey: string; relatedPivotKey: string };
export interface Migration { id: string; up(db: Database): void; down?(db: Database): void; }
export interface SQLStatement { text: string; params: unknown[]; }
export declare function sql(strings: TemplateStringsArray, ...values: unknown[]): SQLStatement;

export declare class FieldDef {
  primary(): this; autoIncrement(): this; required(): this; notNull(): this; nullable(): this; unique(): this; hidden(): this;
  default(value: unknown): this; references(table: string, column?: string): this;
  min(n: number): this; max(n: number): this; email(): this; regex(re: RegExp): this; enum(values: unknown[]): this; encrypted(): this;
}
export declare const field: { integer(): FieldDef; text(): FieldDef; real(): FieldDef; boolean(): FieldDef; json(): FieldDef; blob(): FieldDef };

export interface ModelOptions<T> {
  fields?: Partial<Record<keyof T & string, FieldDef>>;
  softDelete?: boolean; timestamps?: boolean; json?: (keyof T & string)[];
  validate?: Partial<{ [K in keyof T]: Validator<T, K> }>;
  relations?: Record<string, Relation>;
  hidden?: (keyof T & string)[];
  computed?: Record<string, (row: T) => unknown>;
  scopes?: Record<string, (q: QueryBuilder<T>) => void>;
}

export declare class Statement<T = Record<string, unknown>> {
  all(params?: unknown[]): T[]; get(params?: unknown[]): T | null; run(params?: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }; finalize(): void;
}
export declare class SchemaBuilder {
  createTable(name: string, fn: (t: TableBuilder) => void): void; dropTable(name: string): void; renameTable(from: string, to: string): void; addColumn(table: string, name: string, def: FieldDef): void; table(name: string, fn: (t: TableBuilder) => void): void;
}
export declare class TableBuilder {
  increments(name: string): FieldDef; integer(name: string): FieldDef; text(name: string): FieldDef; real(name: string): FieldDef; json(name: string): FieldDef; boolean(name: string): FieldDef;
  timestamps(): this; softDeletes(): this; index(cols: string | string[], name?: string): this; unique(cols: string | string[], name?: string): this;
}
export declare class Inspector { tables(): string[]; columns(table: string): any[]; indexes(table: string): any[]; foreignKeys(table: string): any[]; }
export declare class FTS { create(name: string, opts: { columns: string[] }): void; insert(name: string, row: Record<string, unknown>): void; search<T = Record<string, unknown>>(name: string, term: string, limit?: number): T[]; }

export declare class Database {
  filename: string; schema: SchemaBuilder; inspect: Inspector; fts: FTS;
  async: { query<T = Record<string, unknown>>(statement: string | SQLStatement, params?: unknown[]): Promise<T[]>; exec(statement: string | SQLStatement, params?: unknown[]): Promise<any>; transaction<T>(fn: (tx: Database) => T): Promise<T> };
  constructor(filename?: string, options?: { cache?: { ttl?: number; max?: number } });
  exec(statement: string | SQLStatement, params?: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  query<T = Record<string, unknown>>(statement: string | SQLStatement, params?: unknown[], cache?: number | { ttl: number; max?: number }): T[];
  prepare<T = Record<string, unknown>>(text: string): Statement<T>;
  clearCache(): void; close(): void; transaction<T>(fn: (tx: Database) => T): T;
  migrate(migrations: Migration[]): string[]; rollbackMigrations(steps?: number): string[];
  backup(file: string): string; restore(file: string): void; explain(query: QueryBuilder<any> | SQLStatement | string): any[]; use(plugin: (db: Database, opts?: any) => void, opts?: any): this;
}

export declare class QueryBuilder<T extends Record<string, any>> {
  select(cols: string[] | string, ...more: string[]): this; distinct(): this;
  where(fn: (q: QueryBuilder<T>) => void): this; where(column: keyof T & string | string, op: string, value: unknown): this;
  orWhere(fn: (q: QueryBuilder<T>) => void): this; orWhere(column: keyof T & string | string, op: string, value: unknown): this;
  whereNot(column: string, op: string, value: unknown): this; whereIn(column: string, values: unknown[]): this; whereNull(column: string): this; whereBetween(column: string, a: unknown, b: unknown): this; whereExists(subquery: string | QueryBuilder<any>, params?: unknown[]): this; whereJson(path: string, op: string, value: unknown): this;
  join(table: string, left: string, op: string, right: string): this; leftJoin(table: string, left: string, op: string, right: string): this; groupBy(...cols: string[]): this; having(expr: string, params?: unknown[]): this;
  orderBy(column: string, dir?: 'asc' | 'desc' | 'ASC' | 'DESC'): this; limit(n: number): this; offset(n: number): this; with(name: string): this; withDeleted(): this; onlyDeleted(): this; cache(ttl?: number): this; scope(name: string): this;
  toSQL(select?: string): SQLStatement; get<R = T>(): (R & { toJSON(): Record<string, unknown> })[]; first<R = T>(): (R & { toJSON(): Record<string, unknown> }) | null; count(): number; update(data: Partial<T>): number; delete(force?: boolean): number;
  insert(data: Partial<T>): this; onConflict(cols: string | string[]): this; ignore(): any; merge(cols?: string[]): any;
}
export declare class Model<T extends Record<string, any>> {
  readonly db: Database; readonly table: string;
  query(): QueryBuilder<T>; using(db: Database): Model<T>; hook(name: string, fn: (row: Partial<T> | T) => void): this;
  create(data: Partial<T>): T & { toJSON(): Record<string, unknown> }; insertMany(rows: Partial<T>[]): T[]; upsert(data: Partial<T>, conflictCols: string | string[], mergeCols?: string[]): any;
  find(id: number | bigint, withDeleted?: boolean): (T & { toJSON(): Record<string, unknown> }) | null; delete(id: number | bigint, force?: boolean): number; restore(id: number | bigint): number;
}
export declare function defineModel<T extends Record<string, any>>(db: Database, table: string, options?: ModelOptions<T>): Model<T>;
export declare const sqliteVersion: string;


export declare const errors: {
  ORMError: typeof Error; ValidationError: typeof Error; QueryError: typeof Error; MigrationError: typeof Error; ConflictError: typeof Error; NotFoundError: typeof Error; SQLiteBusyError: typeof Error;
};

declare module './index' {
  interface Database {
    tune(opts: { journalMode?: string; synchronous?: string; busyTimeout?: number; cacheSize?: number; tempStore?: string; mmapSize?: number }): this;
    audit: { enable(opts?: { table?: string; actor?: string | (() => string) }): void };
    export: { json(table: string, file: string): string; csv(table: string, file: string): string };
    import: { json(table: string, file: string): number };
    factory<T extends Record<string, any>>(model: Model<T>, fn: (i: number) => Partial<T>): { createMany(n: number): T[] };
    seed(fns: Array<(db: Database) => unknown>): unknown[];
    repo<T extends Record<string, any>, R>(model: Model<T>, Repo: new (model: Model<T>, db: Database) => R): R;
  }
  interface SchemaBuilder { diff(table: string, fields: Record<string, FieldDef>): string[]; generateMigration(name: string, statements: string[], dir?: string): string; }
  interface QueryBuilder<T extends Record<string, any>> { withCount(name: string): this; cursorPaginate(opts?: { after?: unknown; limit?: number; column?: string; direction?: 'asc' | 'desc' }): { data: T[]; hasMore: boolean; nextCursor: unknown }; }
}
