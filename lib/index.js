'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const native = require(path.join(__dirname, '..', 'build', 'Release', 'lite_orm.node'));

const MODEL_REGISTRY = new WeakMap();
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPS = new Set(['=', '!=', '<>', '>', '>=', '<', '<=', 'LIKE', 'GLOB', 'IS', 'IS NOT']);
class ORMError extends Error {}
class ValidationError extends ORMError {}
class QueryError extends ORMError {}
class MigrationError extends ORMError {}
class ConflictError extends ORMError {}
class NotFoundError extends ORMError {}
class SQLiteBusyError extends ORMError {}
const errors = { ORMError, ValidationError, QueryError, MigrationError, ConflictError, NotFoundError, SQLiteBusyError };

function qi(name) {
  if (name === '*' || String(name).includes('(') || String(name).includes(' AS ')) return String(name);
  return String(name).split('.').map(p => {
    if (p === '*') return '*';
    if (!IDENT.test(p)) throw new Error(`Invalid SQL identifier: ${name}`);
    return `"${p.replace(/"/g, '""')}"`;
  }).join('.');
}
function normalize(v) { if (typeof v === 'bigint') { const n = Number(v); return Number.isSafeInteger(n) ? n : v; } if (Array.isArray(v)) return v.map(normalize); if (v && typeof v === 'object' && !Buffer.isBuffer(v)) for (const k of Object.keys(v)) v[k] = normalize(v[k]); return v; }
function sql(strings, ...values) { let text = ''; for (let i = 0; i < strings.length; i++) { text += strings[i]; if (i < values.length) text += '?'; } return { text, params: values }; }
function registry(db) { if (!MODEL_REGISTRY.has(db)) MODEL_REGISTRY.set(db, new Map()); return MODEL_REGISTRY.get(db); }
function getModel(db, table) { const m = registry(db).get(table); if (!m) throw new Error(`Model not registered: ${table}`); return m; }
function quoteDefault(v) { if (v === null) return 'NULL'; if (v === 'CURRENT_TIMESTAMP') return 'CURRENT_TIMESTAMP'; if (typeof v === 'number') return String(v); return `'${String(v).replace(/'/g, "''")}'`; }

class FieldDef {
  constructor(type) { this.type = type; this.attrs = {}; }
  primary() { this.attrs.primary = true; return this; }
  autoIncrement() { this.attrs.autoIncrement = true; return this; }
  required() { this.attrs.notNull = true; return this; }
  notNull() { this.attrs.notNull = true; return this; }
  nullable() { this.attrs.nullable = true; return this; }
  unique() { this.attrs.unique = true; return this; }
  default(v) { this.attrs.default = v; return this; }
  hidden() { this.attrs.hidden = true; return this; }
  references(table, column = 'id') { this.attrs.references = { table, column }; return this; }
  min(n) { this.attrs.min = n; return this; }
  max(n) { this.attrs.max = n; return this; }
  email() { this.attrs.email = true; return this; }
  regex(re) { this.attrs.regex = re; return this; }
  enum(values) { this.attrs.enum = values; return this; }
  encrypted() { this.attrs.encrypted = true; return this; }
  toSQL(name) {
    let out = `${qi(name)} ${this.type}`;
    if (this.attrs.primary) out += ' PRIMARY KEY';
    if (this.attrs.autoIncrement) out += ' AUTOINCREMENT';
    if (this.attrs.notNull) out += ' NOT NULL';
    if (this.attrs.unique) out += ' UNIQUE';
    if ('default' in this.attrs) out += ` DEFAULT ${quoteDefault(this.attrs.default)}`;
    if (this.attrs.references) out += ` REFERENCES ${qi(this.attrs.references.table)}(${qi(this.attrs.references.column)})`;
    return out;
  }
}
const field = { integer: () => new FieldDef('INTEGER'), text: () => new FieldDef('TEXT'), real: () => new FieldDef('REAL'), boolean: () => new FieldDef('INTEGER'), json: () => { const f = new FieldDef('TEXT'); f.attrs.isJson = true; return f; }, blob: () => new FieldDef('BLOB') };

class TableBuilder {
  constructor() { this.columns = []; this.indexes = []; }
  column(name, def) { this.columns.push({ name, def }); return def; }
  increments(name) { return this.column(name, field.integer().primary().autoIncrement()); }
  integer(name) { return this.column(name, field.integer()); }
  text(name) { return this.column(name, field.text()); }
  real(name) { return this.column(name, field.real()); }
  json(name) { return this.column(name, field.json()); }
  boolean(name) { return this.column(name, field.boolean()); }
  timestamps() { this.text('created_at').default(sql`CURRENT_TIMESTAMP`); this.text('updated_at').default(sql`CURRENT_TIMESTAMP`); return this; }
  softDeletes() { this.text('deleted_at').nullable(); return this; }
  index(cols, name) { this.indexes.push({ cols: Array.isArray(cols) ? cols : [cols], name, unique: false }); return this; }
  unique(cols, name) { this.indexes.push({ cols: Array.isArray(cols) ? cols : [cols], name, unique: true }); return this; }
}
FieldDef.prototype.default = function(v) { this.attrs.default = v && v.text === 'CURRENT_TIMESTAMP' ? 'CURRENT_TIMESTAMP' : v; return this; };

class SchemaBuilder {
  constructor(db) { this.db = db; }
  createTable(name, fn) { const t = new TableBuilder(); fn(t); this.db.exec(`CREATE TABLE IF NOT EXISTS ${qi(name)} (${t.columns.map(c => c.def.toSQL(c.name)).join(', ')})`); for (const idx of t.indexes) this.db.exec(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${qi(idx.name || `${name}_${idx.cols.join('_')}_idx`)} ON ${qi(name)} (${idx.cols.map(qi).join(', ')})`); }
  dropTable(name) { this.db.exec(`DROP TABLE IF EXISTS ${qi(name)}`); }
  renameTable(from, to) { this.db.exec(`ALTER TABLE ${qi(from)} RENAME TO ${qi(to)}`); }
  addColumn(table, name, def) { this.db.exec(`ALTER TABLE ${qi(table)} ADD COLUMN ${def.toSQL(name)}`); }
  table(name, fn) { const t = new TableBuilder(); fn(t); for (const idx of t.indexes) this.db.exec(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${qi(idx.name || `${name}_${idx.cols.join('_')}_idx`)} ON ${qi(name)} (${idx.cols.map(qi).join(', ')})`); }
  diff(table, fields) { const existing = new Set(this.db.inspect.columns(table).map(c => c.name)); const stmts = []; for (const [name, def] of Object.entries(fields || {})) if (!existing.has(name)) stmts.push(`ALTER TABLE ${qi(table)} ADD COLUMN ${def.toSQL(name)}`); return stmts; }
  generateMigration(name, statements, dir = path.join(process.cwd(), 'migrations')) { fs.mkdirSync(dir, { recursive: true }); const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); const safe = String(name).replace(/[^A-Za-z0-9_]+/g, '_'); const file = path.join(dir, `${stamp}_${safe}.js`); fs.writeFileSync(file, `'use strict';\nmodule.exports = {\n  id: '${safe}',\n  up(db) {\n${statements.map(s => `    db.exec(${JSON.stringify(s)});`).join('\n')}\n  },\n  down(db) { }\n};\n`); return file; }
}

class Audit { constructor(db) { this.db = db; this.enabled = false; this.opts = {}; } enable(opts = {}) { this.enabled = true; this.opts = { table: 'audit_logs', ...opts }; this.db.exec(`CREATE TABLE IF NOT EXISTS ${qi(this.opts.table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, row_id TEXT, action TEXT, old_values TEXT, new_values TEXT, actor_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`); } log(table, rowId, action, oldValues, newValues) { if (!this.enabled) return; const actor = typeof this.opts.actor === 'function' ? this.opts.actor() : this.opts.actor; this.db.exec(`INSERT INTO ${qi(this.opts.table)}(table_name,row_id,action,old_values,new_values,actor_id) VALUES(?,?,?,?,?,?)`, [table, String(rowId ?? ''), action, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null, actor == null ? null : String(actor)]); } }

class DataPort { constructor(db, mode) { this.db = db; this.mode = mode; } json(table, file) { if (this.mode === 'export') { fs.writeFileSync(file, JSON.stringify(this.db.query(`SELECT * FROM ${qi(table)}`), null, 2)); return file; } const rows = JSON.parse(fs.readFileSync(file, 'utf8')); for (const r of rows) { const cols = Object.keys(r); this.db.exec(`INSERT INTO ${qi(table)} (${cols.map(qi).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => r[c])); } return rows.length; } csv(table, file) { const rows = this.db.query(`SELECT * FROM ${qi(table)}`); const cols = rows[0] ? Object.keys(rows[0]) : this.db.inspect.columns(table).map(c => c.name); const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`; fs.writeFileSync(file, [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')); return file; } }

class Statement { constructor(db, text) { this.db = db; this.text = text; this.closed = false; } all(params = []) { if (this.closed) throw new Error('Statement finalized'); return this.db.query(this.text, params); } get(params = []) { return this.all(params)[0] || null; } run(params = []) { if (this.closed) throw new Error('Statement finalized'); const r = this.db.exec(this.text, params); this.db.clearCache(); return r; } finalize() { this.closed = true; } }

class Database {
  constructor(filename = ':memory:', options = {}) { this.filename = filename; this.options = options; this.native = new native.NativeDatabase(filename); this.cacheStore = new Map(); this.migrations = []; this.schema = new SchemaBuilder(this); this.inspect = new Inspector(this); this.fts = new FTS(this); this.audit = new Audit(this); this.export = new DataPort(this, 'export'); this.import = new DataPort(this, 'import'); this.async = { query: async (...a) => this.query(...a), exec: async (...a) => this.exec(...a), transaction: async fn => this.transaction(fn) }; if (options.busyTimeout) this.exec(`PRAGMA busy_timeout=${Number(options.busyTimeout)}`); }
  _retry(fn) { const retry = this.options.retry || { attempts: 1, delay: 0 }; let last; for (let i = 0; i < (retry.attempts || 1); i++) { try { return fn(); } catch (e) { last = e; if (!/busy|locked/i.test(e.message) || i === (retry.attempts || 1) - 1) throw e; const end = Date.now() + (retry.delay || 0); while (Date.now() < end) {} } } throw last; }
  exec(statement, params = []) { return this._retry(() => { if (statement && statement.text) { params = statement.params || []; statement = statement.text; } try { return normalize(this.native.exec(String(statement), params)); } catch (e) { if (/busy|locked/i.test(e.message)) throw new SQLiteBusyError(e.message); throw new QueryError(e.message); } }); }
  query(statement, params = [], cacheOptions = null) { return this._retry(() => { if (statement && statement.text) { params = statement.params || []; statement = statement.text; } const text = String(statement); const key = cacheOptions ? text + '\0' + JSON.stringify(params) : null; if (key) { const hit = this.cacheStore.get(key); if (hit && hit.expires > Date.now()) return normalize(hit.rows.map(r => ({ ...r }))); if (hit) this.cacheStore.delete(key); } let rows; try { rows = normalize(this.native.query(text, params)); } catch (e) { if (/busy|locked/i.test(e.message)) throw new SQLiteBusyError(e.message); throw new QueryError(e.message); } if (key) { const ttl = typeof cacheOptions === 'number' ? cacheOptions : cacheOptions.ttl; const max = cacheOptions.max || this.options.cache?.max || 500; this.cacheStore.set(key, { expires: Date.now() + ttl, rows: rows.map(r => ({ ...r })) }); while (this.cacheStore.size > max) this.cacheStore.delete(this.cacheStore.keys().next().value); } return rows; }); }
  prepare(text) { return new Statement(this, text); }
  clearCache() { this.cacheStore.clear(); }
  close() { this.native.close(); }
  transaction(fn) { this.exec('BEGIN IMMEDIATE'); try { const result = fn(this); this.exec('COMMIT'); return result; } catch (err) { try { this.exec('ROLLBACK'); } catch (_) {} throw err; } }
  migrate(migrations) { this.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'); const applied = new Set(this.query('SELECT id FROM _migrations').map(r => r.id)); const merged = new Map(this.migrations.map(m => [m.id, m])); for (const m of migrations) { const prev = merged.get(m.id); merged.set(m.id, { ...(prev || {}), ...m, down: m.down || prev?.down }); } this.migrations = [...merged.values()]; return this.transaction(() => { const ran = []; for (const m of migrations) { if (applied.has(m.id)) continue; m.up(this); this.exec('INSERT INTO _migrations(id) VALUES (?)', [m.id]); ran.push(m.id); } return ran; }); }
  rollbackMigrations(steps = 1) { const rows = this.query('SELECT id FROM _migrations ORDER BY applied_at DESC, rowid DESC LIMIT ?', [steps]); const byId = new Map(this.migrations.map(m => [m.id, m])); return this.transaction(() => { const rolled = []; for (const row of rows) { const m = byId.get(row.id); if (!m?.down) throw new Error(`Migration ${row.id} has no down() function`); m.down(this); this.exec('DELETE FROM _migrations WHERE id = ?', [row.id]); rolled.push(row.id); } return rolled; }); }
  backup(file) { this.exec(`VACUUM INTO ?`, [file]); return file; }
  restore(file) { this.close(); if (this.filename === ':memory:') throw new Error('Cannot restore into memory database'); fs.copyFileSync(file, this.filename); this.native = new native.NativeDatabase(this.filename); this.clearCache(); }
  explain(q) { const s = q && typeof q.toSQL === 'function' ? q.toSQL() : (q.text ? q : { text: String(q), params: [] }); return this.query('EXPLAIN QUERY PLAN ' + s.text, s.params); }
  use(plugin, opts) { plugin(this, opts); return this; }
  tune(opts = {}) { const map = { journalMode: 'journal_mode', synchronous: 'synchronous', busyTimeout: 'busy_timeout', cacheSize: 'cache_size', tempStore: 'temp_store', mmapSize: 'mmap_size' }; for (const [k, v] of Object.entries(opts)) if (map[k]) this.exec(`PRAGMA ${map[k]}=${typeof v === 'string' ? v : Number(v)}`); return this; }
  factory(model, fn) { return { createMany: n => model.insertMany(Array.from({ length: n }, (_, i) => fn(i + 1))) }; }
  seed(fns) { return this.transaction(() => fns.map(fn => fn(this))); }
  repo(model, Repo) { return new Repo(model, this); }
}

class Inspector { constructor(db) { this.db = db; } tables() { return this.db.query("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name); } columns(table) { return this.db.query(`PRAGMA table_info(${qi(table)})`); } indexes(table) { return this.db.query(`PRAGMA index_list(${qi(table)})`); } foreignKeys(table) { return this.db.query(`PRAGMA foreign_key_list(${qi(table)})`); } }
class FTS { constructor(db) { this.db = db; } create(name, { columns }) { this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${qi(name)} USING fts5(${columns.map(qi).join(', ')})`); } insert(name, row) { const cols = Object.keys(row); this.db.exec(`INSERT INTO ${qi(name)} (${cols.map(qi).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c])); } search(name, term, limit = 20) { return this.db.query(`SELECT * FROM ${qi(name)} WHERE ${qi(name)} MATCH ? LIMIT ?`, [term, limit]); } }

class QueryBuilder {
  constructor(model, db = model.db, nested = false) { this.model = model; this.db = db; this.parts = []; this.params = []; this.orders = []; this.joins = []; this.groups = []; this.havings = []; this._select = ['*']; this._distinct = false; this._limit = null; this._offset = null; this._withDeleted = false; this._onlyDeleted = false; this._relations = []; this._cache = null; this.nested = nested; }
  clone() { const q = new QueryBuilder(this.model, this.db, this.nested); for (const k of ['parts','params','orders','joins','groups','havings','_select','_relations']) q[k] = [...this[k]]; Object.assign(q, { _counts: [...(this._counts || [])], _distinct: this._distinct, _limit: this._limit, _offset: this._offset, _withDeleted: this._withDeleted, _onlyDeleted: this._onlyDeleted, _cache: this._cache }); return q; }
  select(cols) { this._select = Array.isArray(cols) ? cols : [...arguments]; return this; }
  distinct() { this._distinct = true; return this; }
  _add(bool, expr, params = []) { this.parts.push({ bool, expr }); this.params.push(...params); return this; }
  where(column, op, value) { if (typeof column === 'function') { const q = new QueryBuilder(this.model, this.db, true); column(q); const w = q._whereExpr(); if (w) return this._add('AND', `(${w})`, q.params); return this; } if (value === undefined && !OPS.has(String(op).toUpperCase())) { value = op; op = '='; } return this._add('AND', `${qi(column)} ${op} ?`, [value]); }
  orWhere(column, op, value) { if (typeof column === 'function') { const q = new QueryBuilder(this.model, this.db, true); column(q); const w = q._whereExpr(); if (w) return this._add('OR', `(${w})`, q.params); return this; } if (value === undefined && !OPS.has(String(op).toUpperCase())) { value = op; op = '='; } return this._add('OR', `${qi(column)} ${op} ?`, [value]); }
  whereNot(column, op, value) { return this._add('AND', `NOT (${qi(column)} ${op} ?)`, [value]); }
  whereIn(column, values) { return values.length ? this._add('AND', `${qi(column)} IN (${values.map(() => '?').join(',')})`, values) : this._add('AND', '0=1'); }
  whereNull(column) { return this._add('AND', `${qi(column)} IS NULL`); }
  whereBetween(column, a, b) { return this._add('AND', `${qi(column)} BETWEEN ? AND ?`, [a, b]); }
  whereExists(subquery, params = []) { return this._add('AND', `EXISTS (${typeof subquery === 'string' ? subquery : subquery.toSQL().text})`, params.length ? params : (subquery.toSQL?.().params || [])); }
  whereJson(path, op, value) { const parts = String(path).split('.'); const col = parts.length > 2 ? parts.slice(0, 2).join('.') : parts[0]; const rest = parts.slice(col.includes('.') ? 2 : 1); return this._add('AND', `json_extract(${qi(col)}, ?) ${op} ?`, ['$.' + rest.join('.'), value]); }
  join(table, left, op, right) { this.joins.push(`JOIN ${qi(table)} ON ${qi(left)} ${op} ${qi(right)}`); return this; }
  leftJoin(table, left, op, right) { this.joins.push(`LEFT JOIN ${qi(table)} ON ${qi(left)} ${op} ${qi(right)}`); return this; }
  groupBy(...cols) { this.groups.push(...cols.flat()); return this; }
  having(expr, params = []) { this.havings.push(expr); this.params.push(...params); return this; }
  orderBy(column, dir = 'asc') { this.orders.push(`${qi(column)} ${String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`); return this; }
  limit(n) { this._limit = Number(n); return this; } offset(n) { this._offset = Number(n); return this; } with(name, constraint) { this._relations.push({ name, constraint }); return this; } withCount(name) { if (!this._counts) this._counts = []; this._counts.push(name); return this; } withDeleted() { this._withDeleted = true; return this; } onlyDeleted() { this._onlyDeleted = true; this._withDeleted = true; return this; } cache(ttl = 1000) { this._cache = { ttl }; return this; } scope(name) { const fn = this.model.options.scopes?.[name]; if (!fn) throw new Error(`Unknown scope: ${name}`); fn(this); return this; }
  _whereExpr(extra = []) { const arr = [...this.parts]; for (const e of extra) arr.push({ bool: 'AND', expr: e }); return arr.map((p, i) => `${i ? p.bool + ' ' : ''}${p.expr}`).join(' '); }
  _whereSql(extra = []) { const wh = [...extra]; if (this.model.options.softDelete && !this._withDeleted) wh.push(`${qi(this.model.table)}."deleted_at" IS NULL`); if (this._onlyDeleted) wh.push(`${qi(this.model.table)}."deleted_at" IS NOT NULL`); const expr = this._whereExpr(wh); return expr ? ` WHERE ${expr}` : ''; }
  toSQL(selectOverride) { const select = selectOverride || this._select.map(qi).join(', '); let text = `SELECT ${this._distinct ? 'DISTINCT ' : ''}${select} FROM ${qi(this.model.table)}`; if (this.joins.length) text += ' ' + this.joins.join(' '); text += this._whereSql(); if (this.groups.length) text += ` GROUP BY ${this.groups.map(qi).join(', ')}`; if (this.havings.length) text += ` HAVING ${this.havings.join(' AND ')}`; if (this.orders.length) text += ` ORDER BY ${this.orders.join(', ')}`; if (this._limit != null) text += ` LIMIT ${this._limit}`; if (this._offset != null) text += ` OFFSET ${this._offset}`; return { text, params: [...this.params] }; }
  get() { const { text, params } = this.toSQL(); const rows = this.db.query(text, params, this._cache); const out = rows.map(r => this.model._hydrate(r)); this.model._loadCounts(out, this._counts || [], this.db); this.model._loadRelations(out, this._relations, this.db); return out; }
  cursorPaginate({ after = null, limit = 20, column = 'id', direction = 'asc' } = {}) { const q = this.clone(); if (after != null) q.where(column, direction.toLowerCase() === 'desc' ? '<' : '>', after); q.limit(limit + 1); const rows = q.get(); const hasMore = rows.length > limit; const data = hasMore ? rows.slice(0, limit) : rows; return { data, hasMore, nextCursor: data.length ? data[data.length - 1][column.split('.').pop()] : null }; }
  first() { const q = this.clone().limit(1); return q.get()[0] || null; }
  count() { const text = `SELECT COUNT(*) AS n FROM ${qi(this.model.table)}${this._whereSql()}`; return this.db.query(text, this.params)[0].n; }
  update(data) { const row = this.model._prepareWrite(data, false); const cols = Object.keys(row); if (!cols.length) return 0; const res = this.db.exec(`UPDATE ${qi(this.model.table)} SET ${cols.map(c => `${qi(c)} = ?`).join(', ')}${this._whereSql()}`, [...cols.map(c => row[c]), ...this.params]); this.db.clearCache(); return res.changes; }
  delete(force = false) { if (this.model.options.softDelete && !force) return this.update({ deleted_at: new Date().toISOString() }); const res = this.db.exec(`DELETE FROM ${qi(this.model.table)}${this._whereSql()}`, this.params); this.db.clearCache(); return res.changes; }
  insert(data) { this._pendingInsert = data; return this; } onConflict(cols) { this._conflict = Array.isArray(cols) ? cols : [cols]; return this; } ignore() { return this._insertConflict('ignore'); } merge(cols) { return this._insertConflict('merge', cols); }
  _insertConflict(mode, mergeCols) { return this.model._insertConflict(this._pendingInsert, this._conflict || ['id'], mode, mergeCols); }
}

class Model {
  constructor(db, table, options = {}) { this.db = db; this.table = table; this.options = { ...options }; this.hooks = new Map(); this._deriveOptionsFromFields(); }
  _deriveOptionsFromFields() { const fields = this.options.fields || {}; this.options.hidden = [...new Set([...(this.options.hidden || []), ...Object.entries(fields).filter(([, f]) => f.attrs?.hidden).map(([k]) => k)])]; this.options.json = [...new Set([...(this.options.json || []), ...Object.entries(fields).filter(([, f]) => f.attrs?.isJson).map(([k]) => k)])]; this.options.encrypted = [...new Set([...(this.options.encrypted || []), ...Object.entries(fields).filter(([, f]) => f.attrs?.encrypted).map(([k]) => k)])]; }
  using(db) { const m = new Model(db, this.table, this.options); m.hooks = this.hooks; return m; }
  query() { return new QueryBuilder(this); }
  hook(name, fn) { if (!this.hooks.has(name)) this.hooks.set(name, []); this.hooks.get(name).push(fn); return this; }
  _runHook(name, row) { for (const fn of this.hooks.get(name) || []) fn(row); }
  _validate(row, creating) { const errs = []; for (const [k, def] of Object.entries(this.options.fields || {})) { const a = def.attrs || {}; const v = row[k]; if ((creating || k in row) && a.notNull && v == null && !('default' in a) && !a.autoIncrement) errs.push(`${k} required`); if (v != null && a.email && !String(v).includes('@')) errs.push(`${k} email invalid`); if (v != null && a.min != null && (typeof v === 'number' ? v < a.min : String(v).length < a.min)) errs.push(`${k} min ${a.min}`); if (v != null && a.max != null && (typeof v === 'number' ? v > a.max : String(v).length > a.max)) errs.push(`${k} max ${a.max}`); if (v != null && a.regex && !a.regex.test(String(v))) errs.push(`${k} regex invalid`); if (v != null && a.enum && !a.enum.includes(v)) errs.push(`${k} enum invalid`); } for (const [k, rule] of Object.entries(this.options.validate || {})) { if (!creating && !(k in row)) continue; const r = rule(row[k], row); if (r !== true && r !== undefined) errs.push(typeof r === 'string' ? r : `${k} invalid`); } if (errs.length) throw new ValidationError(`Validation failed: ${errs.join('; ')}`); }
  _applyDefaults(row) { for (const [k, def] of Object.entries(this.options.fields || {})) if (!(k in row) && 'default' in def.attrs) row[k] = typeof def.attrs.default === 'function' ? def.attrs.default() : def.attrs.default; }
  _key() { return Buffer.isBuffer(this.db.options.encryptionKey) ? this.db.options.encryptionKey : crypto.createHash('sha256').update(String(this.db.options.encryptionKey || 'lite-orm-default-key')).digest(); }
  _encrypt(v) { if (v == null || String(v).startsWith('enc:')) return v; const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', this._key(), iv); const enc = Buffer.concat([c.update(String(v), 'utf8'), c.final()]); return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64'); }
  _decrypt(v) { if (typeof v !== 'string' || !v.startsWith('enc:')) return v; const b = Buffer.from(v.slice(4), 'base64'); const iv = b.subarray(0, 12), tag = b.subarray(12, 28), data = b.subarray(28); const d = crypto.createDecipheriv('aes-256-gcm', this._key(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(data), d.final()]).toString('utf8'); }
  _prepareWrite(data, creating) { const row = { ...data }; if (creating) this._applyDefaults(row); this._validate(row, creating); this._runHook(creating ? 'beforeCreate' : 'beforeUpdate', row); this._validate(row, creating); for (const f of this.options.json || []) if (row[f] !== undefined && row[f] !== null && typeof row[f] !== 'string') row[f] = JSON.stringify(row[f]); for (const f of this.options.encrypted || []) if (row[f] !== undefined) row[f] = this._encrypt(row[f]); const now = new Date().toISOString(); if (this.options.timestamps) { if (creating && row.created_at === undefined) row.created_at = now; if (row.updated_at === undefined) row.updated_at = now; } return row; }
  _instance(row) { const model = this; const original = { ...row }; Object.defineProperties(row, { getChanges: { enumerable: false, value() { const out = {}; for (const [k, v] of Object.entries(row)) if (typeof v !== 'function' && JSON.stringify(v) !== JSON.stringify(original[k])) out[k] = v; return out; } }, save: { enumerable: false, value() { const changes = row.getChanges(); if (!Object.keys(changes).length) return 0; if (model.options.optimisticLock) { const oldVer = original.version || 0; changes.version = oldVer + 1; const prep = model._prepareWrite(changes, false); const cols = Object.keys(prep); const res = model.db.exec(`UPDATE ${qi(model.table)} SET ${cols.map(c => `${qi(c)}=?`).join(', ')} WHERE id=? AND version=?`, [...cols.map(c => prep[c]), row.id, oldVer]); if (!res.changes) throw new ConflictError('Optimistic lock conflict'); Object.assign(original, model.find(row.id, true)); Object.assign(row, original); return res.changes; } const n = model.query().where('id', '=', row.id).update(changes); Object.assign(original, row); return n; } }, delete: { enumerable: false, value(force=false) { return model.delete(row.id, force); } }, restore: { enumerable: false, value() { return model.restore(row.id); } }, reload: { enumerable: false, value() { const fresh = model.find(row.id, true); Object.assign(row, fresh); Object.assign(original, fresh); return row; } }, toJSON: { enumerable: false, value() { const out = {}; for (const [k, v] of Object.entries(row)) if (!(model.options.hidden || []).includes(k)) out[k] = v; for (const [k, fn] of Object.entries(model.options.computed || {})) out[k] = fn(row); return out; } } }); return row; }
  _hydrate(row) { for (const f of this.options.json || []) if (typeof row[f] === 'string') { try { row[f] = JSON.parse(row[f]); } catch (_) {} } for (const f of this.options.encrypted || []) if (row[f] !== undefined) row[f] = this._decrypt(row[f]); return this._instance(row); }
  create(data) { const row = this._prepareWrite(data, true); const cols = Object.keys(row); const res = this.db.exec(`INSERT INTO ${qi(this.table)} (${cols.map(qi).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c])); this.db.clearCache(); const fresh = this.find(res.lastInsertRowid, true); this.db.audit?.log(this.table, fresh?.id || res.lastInsertRowid, 'create', null, fresh?.toJSON ? fresh.toJSON() : fresh); this._runHook('afterCreate', fresh); return fresh; }
  insertMany(rows) { return this.db.transaction(() => rows.map(r => this.create(r))); }
  _insertConflict(data, conflictCols, mode, mergeCols) { const row = this._prepareWrite(data, true); const cols = Object.keys(row); let text = `INSERT INTO ${qi(this.table)} (${cols.map(qi).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(${conflictCols.map(qi).join(', ')}) DO `; if (mode === 'ignore') text += 'NOTHING'; else { const upd = (mergeCols || cols.filter(c => !conflictCols.includes(c))).map(c => `${qi(c)}=excluded.${qi(c)}`).join(', '); text += `UPDATE SET ${upd}`; } const res = this.db.exec(text, cols.map(c => row[c])); this.db.clearCache(); this.db.audit?.log(this.table, null, 'upsert', null, data); return res; }
  upsert(data, conflictCols, mergeCols) { return this._insertConflict(data, Array.isArray(conflictCols) ? conflictCols : [conflictCols], 'merge', mergeCols); }
  find(id, withDeleted = false) { const q = this.query().where(`${this.table}.id`, '=', id); if (withDeleted) q.withDeleted(); return q.first(); }
  delete(id, force = false) { const before = this.find(id, true); const n = this.query().where('id', '=', id).delete(force); if (n) this.db.audit?.log(this.table, id, force ? 'forceDelete' : 'delete', before?.toJSON ? before.toJSON() : before, null); return n; }
  restore(id) { const res = this.query().withDeleted().where('id', '=', id).update({ deleted_at: null }); if (res) this.db.audit?.log(this.table, id, 'restore', null, this.find(id, true)?.toJSON?.()); return res; }
  _loadCounts(rows, names, db) { if (!rows.length) return; for (const name of names) { const rel = this.options.relations?.[name]; if (!rel) continue; if (rel.type === 'hasMany') for (const r of rows) r[`${name}_count`] = db.query(`SELECT COUNT(*) AS n FROM ${qi(rel.model)} WHERE ${qi(rel.foreignKey)}=?`, [r[rel.localKey || 'id']])[0].n; } }
  _loadRelations(rows, relSpecs, db) { if (!rows.length || !relSpecs.length) return; for (const spec of relSpecs) { const name0 = typeof spec === 'string' ? spec : spec.name; const constraint = typeof spec === 'object' ? spec.constraint : null; const [name, ...rest] = String(name0).split('.'); const rel = this.options.relations?.[name]; if (!rel) throw new Error(`Unknown relation: ${name}`); const target = getModel(this.db, rel.model); if (rel.type === 'hasMany') { const keys = [...new Set(rows.map(r => r[rel.localKey || 'id']).filter(v => v != null))]; const q = target.using(db).query().whereIn(rel.foreignKey, keys); if (constraint) constraint(q); const children = q.get(); const bucket = new Map(); for (const c of children) { const k = c[rel.foreignKey]; if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push(c); } for (const r of rows) r[name] = bucket.get(r[rel.localKey || 'id']) || []; if (rest.length) target._loadRelations(children, [rest.join('.')], db); } else if (rel.type === 'belongsTo' || rel.type === 'hasOne') { const localVal = rel.type === 'hasOne' ? (rel.localKey || 'id') : rel.foreignKey; const foreign = rel.type === 'hasOne' ? rel.foreignKey : (rel.ownerKey || 'id'); const keys = [...new Set(rows.map(r => r[localVal]).filter(v => v != null))]; const q = target.using(db).query().whereIn(foreign, keys); if (constraint) constraint(q); const parents = q.get(); const by = new Map(parents.map(p => [p[foreign], p])); for (const r of rows) r[name] = by.get(r[localVal]) || null; if (rest.length) target._loadRelations(parents, [rest.join('.')], db); } else if (rel.type === 'belongsToMany') { const localIds = [...new Set(rows.map(r => r.id).filter(v => v != null))]; const piv = localIds.length ? db.query(`SELECT * FROM ${qi(rel.pivot)} WHERE ${qi(rel.foreignPivotKey)} IN (${localIds.map(() => '?').join(',')})`, localIds) : []; const relatedIds = [...new Set(piv.map(p => p[rel.relatedPivotKey]))]; const q = target.using(db).query().whereIn('id', relatedIds); if (constraint) constraint(q); const related = q.get(); const byId = new Map(related.map(r => [r.id, r])); const bucket = new Map(); for (const p of piv) { const item = byId.get(p[rel.relatedPivotKey]); if (!item) continue; if (!bucket.has(p[rel.foreignPivotKey])) bucket.set(p[rel.foreignPivotKey], []); bucket.get(p[rel.foreignPivotKey]).push(item); } for (const r of rows) r[name] = bucket.get(r.id) || []; } } }
}
function defineModel(db, table, options = {}) { const m = new Model(db, table, options); registry(db).set(table, m); return m; }

module.exports = { Database, defineModel, Model, QueryBuilder, sql, field, errors, sqliteVersion: native.sqliteVersion };
