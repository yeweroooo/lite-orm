'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let native;
let nativeLoadError = null;
try {
  native = require(path.join(__dirname, '..', 'build', 'Release', 'lite_orm.node'));
} catch (err) {
  nativeLoadError = err;
  native = {
    sqliteVersion: null,
    NativeDatabase: class NativeDatabaseUnavailable {
      constructor() { throw nativeLoadError; }
    }
  };
}

const MODEL_REGISTRY = new WeakMap();
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPS = new Set(['=', '!=', '<>', '>', '>=', '<', '<=', 'LIKE', 'GLOB', 'IS', 'IS NOT']);
const LIFECYCLE_HOOKS = new Set([
  'beforeValidate', 'afterValidate', 'beforeCreate', 'afterCreate', 'beforeUpdate', 'afterUpdate',
  'beforeDelete', 'afterDelete', 'beforeDestroy', 'afterDestroy', 'beforeRestore', 'afterRestore',
  'beforeSave', 'afterSave', 'beforeUpsert', 'afterUpsert'
]);

class ORMError extends Error {}
class ValidationError extends ORMError { constructor(message, issues = []) { super(message); this.issues = issues; } }
class QueryError extends ORMError {}
class MigrationError extends ORMError {}
class ConflictError extends ORMError {}
class NotFoundError extends ORMError {}
class SQLiteBusyError extends ORMError {}
class HookAbortError extends ORMError {}
class AuthorizationError extends ORMError {}
const errors = { ORMError, ValidationError, QueryError, MigrationError, ConflictError, NotFoundError, SQLiteBusyError, HookAbortError, AuthorizationError };

function qi(name) {
  if (name === '*' || String(name).includes('(') || String(name).includes(' AS ')) return String(name);
  return String(name).split('.').map(p => {
    if (p === '*') return '*';
    if (!IDENT.test(p)) throw new Error(`Invalid SQL identifier: ${name}`);
    return `"${p.replace(/"/g, '""')}"`;
  }).join('.');
}
function normalize(v) {
  if (typeof v === 'bigint') { const n = Number(v); return Number.isSafeInteger(n) ? n : v; }
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object' && !Buffer.isBuffer(v)) for (const k of Object.keys(v)) v[k] = normalize(v[k]);
  return v;
}
function sql(strings, ...values) { let text = ''; for (let i = 0; i < strings.length; i++) { text += strings[i]; if (i < values.length) text += '?'; } return { text, params: values }; }
function registry(db) { if (!MODEL_REGISTRY.has(db)) MODEL_REGISTRY.set(db, new Map()); return MODEL_REGISTRY.get(db); }
function getModel(db, table) { const m = registry(db).get(table); if (!m) throw new Error(`Model not registered: ${table}`); return m; }
function quoteDefault(v) { if (v === null) return 'NULL'; if (v === 'CURRENT_TIMESTAMP') return 'CURRENT_TIMESTAMP'; if (typeof v === 'number') return String(v); return `'${String(v).replace(/'/g, "''")}'`; }
function sqlLiteral(v) { return `'${String(v).replace(/'/g, "''")}'`; }
function checkOp(op) { const s = String(op).toUpperCase(); if (!OPS.has(s)) throw new Error(`Invalid SQL operator: ${op}`); return s; }
function sleep(ms) { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function isPromiseLike(v) { return v && typeof v.then === 'function'; }
function jsonValue(v) { return JSON.stringify(v); }
function safeJsonParse(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } }
function nowIso() { return new Date().toISOString(); }
function tableSingular(name) { return String(name).replace(/s$/, ''); }
function camelToSnake(s) { return String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(); }

function splitJsonPath(pathStr, table = null) {
  const parts = String(pathStr).split('.');
  const hasTablePrefix = table && parts.length > 2 && parts[0] === table;
  const col = hasTablePrefix ? parts.slice(0, 2).join('.') : parts[0];
  const rest = parts.slice(hasTablePrefix ? 2 : 1);
  const path = '$' + rest.map(p => {
    const m = p.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[(\d+)\])?$/);
    if (!m) return `.${String(p).replace(/"/g, '\\"')}`;
    return `.${m[1]}${m[2] || ''}`;
  }).join('');
  return { column: col, path: path === '$' ? '$' : path };
}

class FieldDef {
  constructor(type, jsType = null) { this.type = type; this.jsType = jsType; this.attrs = {}; }
  primary() { this.attrs.primary = true; return this; }
  autoIncrement() { this.attrs.autoIncrement = true; return this; }
  required() { this.attrs.notNull = true; return this; }
  notNull() { this.attrs.notNull = true; return this; }
  nullable() { this.attrs.nullable = true; return this; }
  unique() { this.attrs.unique = true; return this; }
  default(v) { this.attrs.default = v && v.text === 'CURRENT_TIMESTAMP' ? 'CURRENT_TIMESTAMP' : v; return this; }
  hidden() { this.attrs.hidden = true; return this; }
  references(table, column = 'id') { this.attrs.references = { table, column }; return this; }
  min(n) { this.attrs.min = n; return this; }
  max(n) { this.attrs.max = n; return this; }
  email() { this.attrs.email = true; return this; }
  regex(re) { this.attrs.regex = re; return this; }
  enum(values) { this.attrs.enum = values; return this; }
  encrypted() { this.attrs.encrypted = true; return this; }
  validJson() { this.attrs.validJson = true; this.attrs.isJson = true; return this; }
  check(code, fn, message) { if (!this.attrs.checks) this.attrs.checks = []; this.attrs.checks.push({ code, fn, message }); return this; }
  toSQL(name) {
    let out = `${qi(name)} ${this.type}`;
    if (this.attrs.primary) out += ' PRIMARY KEY';
    if (this.attrs.autoIncrement) out += ' AUTOINCREMENT';
    if (this.attrs.notNull) out += ' NOT NULL';
    if (this.attrs.unique) out += ' UNIQUE';
    if ('default' in this.attrs) out += ` DEFAULT ${quoteDefault(this.attrs.default)}`;
    if (this.attrs.validJson) out += ` CHECK (${qi(name)} IS NULL OR json_valid(${qi(name)}))`;
    if (this.attrs.references) out += ` REFERENCES ${qi(this.attrs.references.table)}(${qi(this.attrs.references.column)})`;
    return out;
  }
}
const field = {
  integer: () => new FieldDef('INTEGER', 'integer'),
  text: () => new FieldDef('TEXT', 'text'),
  real: () => new FieldDef('REAL', 'real'),
  boolean: () => new FieldDef('INTEGER', 'boolean'),
  json: () => { const f = new FieldDef('TEXT', 'json'); f.attrs.isJson = true; return f; },
  blob: () => new FieldDef('BLOB', 'blob')
};

class TableBuilder {
  constructor() { this.columns = []; this.indexes = []; }
  column(name, def) { this.columns.push({ name, def }); return def; }
  increments(name) { return this.column(name, field.integer().primary().autoIncrement()); }
  integer(name) { return this.column(name, field.integer()); }
  text(name) { return this.column(name, field.text()); }
  real(name) { return this.column(name, field.real()); }
  json(name, opts = {}) { const f = field.json(); if (opts.valid) f.validJson(); return this.column(name, f); }
  boolean(name) { return this.column(name, field.boolean()); }
  timestamps() { this.text('created_at').default('CURRENT_TIMESTAMP'); this.text('updated_at').default('CURRENT_TIMESTAMP'); return this; }
  softDeletes(column = 'deleted_at') { this.text(column).nullable(); return this; }
  paranoid(opts = {}) { this.text(opts.deletedAt || 'deleted_at').nullable(); if (opts.deletedBy) this.text(opts.deletedBy).nullable(); return this; }
  index(cols, name) { this.indexes.push({ cols: Array.isArray(cols) ? cols : [cols], name, unique: false }); return this; }
  unique(cols, name) { this.indexes.push({ cols: Array.isArray(cols) ? cols : [cols], name, unique: true }); return this; }
  indexJson(jsonPath, name) { this.indexes.push({ jsonPath, name, unique: false }); return this; }
}

class SchemaBuilder {
  constructor(db) { this.db = db; }
  createTable(name, fn) {
    const t = new TableBuilder(); fn(t);
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${qi(name)} (${t.columns.map(c => c.def.toSQL(c.name)).join(', ')})`);
    for (const idx of t.indexes) {
      if (idx.jsonPath) { const jp = splitJsonPath(idx.jsonPath); this.db.exec(`CREATE INDEX IF NOT EXISTS ${qi(idx.name || `${name}_${idx.jsonPath.replace(/\W+/g, '_')}_idx`)} ON ${qi(name)} (json_extract(${qi(jp.column)}, ${sqlLiteral(jp.path)}))`); }
      else this.db.exec(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${qi(idx.name || `${name}_${idx.cols.join('_')}_idx`)} ON ${qi(name)} (${idx.cols.map(qi).join(', ')})`);
    }
  }
  dropTable(name) { this.db.exec(`DROP TABLE IF EXISTS ${qi(name)}`); }
  renameTable(from, to) { this.db.exec(`ALTER TABLE ${qi(from)} RENAME TO ${qi(to)}`); }
  addColumn(table, name, def) { this.db.exec(`ALTER TABLE ${qi(table)} ADD COLUMN ${def.toSQL(name)}`); }
  table(name, fn) { const t = new TableBuilder(); fn(t); for (const idx of t.indexes) this.db.exec(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${qi(idx.name || `${name}_${idx.cols.join('_')}_idx`)} ON ${qi(name)} (${idx.cols.map(qi).join(', ')})`); }
  diff(table, fields) { const existing = new Set(this.db.inspect.columns(table).map(c => c.name)); const stmts = []; for (const [name, def] of Object.entries(fields || {})) if (!existing.has(name)) stmts.push(`ALTER TABLE ${qi(table)} ADD COLUMN ${def.toSQL(name)}`); return stmts; }
  generateMigration(name, statements, dir = path.join(process.cwd(), 'migrations')) { fs.mkdirSync(dir, { recursive: true }); const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); const safe = String(name).replace(/[^A-Za-z0-9_]+/g, '_'); const file = path.join(dir, `${stamp}_${safe}.js`); fs.writeFileSync(file, `'use strict';\nmodule.exports = {\n  id: '${safe}',\n  up(db) {\n${statements.map(s => `    db.exec(${JSON.stringify(s)});`).join('\n')}\n  },\n  down(db) { }\n};\n`); return file; }
}

class Audit {
  constructor(db) { this.db = db; this.enabled = false; this.opts = {}; }
  enable(opts = {}) { this.enabled = true; this.opts = { table: 'audit_logs', ...opts }; this.db.exec(`CREATE TABLE IF NOT EXISTS ${qi(this.opts.table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, row_id TEXT, action TEXT, old_values TEXT, new_values TEXT, actor_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`); }
  log(table, rowId, action, oldValues, newValues) { if (!this.enabled) return; const actor = typeof this.opts.actor === 'function' ? this.opts.actor() : this.opts.actor; this.db.exec(`INSERT INTO ${qi(this.opts.table)}(table_name,row_id,action,old_values,new_values,actor_id) VALUES(?,?,?,?,?,?)`, [table, String(rowId ?? ''), action, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null, actor == null ? null : String(actor)]); }
}

class DataPort {
  constructor(db, mode) { this.db = db; this.mode = mode; }
  json(table, file) { if (this.mode === 'export') { fs.writeFileSync(file, JSON.stringify(this.db.query(`SELECT * FROM ${qi(table)}`), null, 2)); return file; } const rows = JSON.parse(fs.readFileSync(file, 'utf8')); for (const r of rows) { const cols = Object.keys(r); this.db.exec(`INSERT INTO ${qi(table)} (${cols.map(qi).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => r[c])); } return rows.length; }
  csv(table, file) { const rows = this.db.query(`SELECT * FROM ${qi(table)}`); const cols = rows[0] ? Object.keys(rows[0]) : this.db.inspect.columns(table).map(c => c.name); const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`; fs.writeFileSync(file, [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')); return file; }
}

class Statement {
  constructor(db, text, nativeStmt = null) { this.db = db; this.text = text; this.native = nativeStmt; this.closed = false; }
  all(params = []) { if (this.closed) throw new Error('Statement finalized'); return this.native ? normalize(this.native.all(params)) : this.db.query(this.text, params); }
  get(params = []) { if (this.native) return normalize(this.native.get(params)); return this.all(params)[0] || null; }
  run(params = []) { if (this.closed) throw new Error('Statement finalized'); const r = this.native ? normalize(this.native.run(params)) : this.db.exec(this.text, params); this.db.clearCache(); return r; }
  finalize() { if (!this.closed && this.native?.finalize) this.native.finalize(); this.closed = true; }
  columns() { if (this.closed) throw new Error('Statement finalized'); return this.native?.columns ? this.native.columns() : []; }
  readonly() { if (this.closed) throw new Error('Statement finalized'); return this.native?.readonly ? this.native.readonly() : /^\s*select/i.test(this.text); }
}

class CDC {
  constructor(db) { this.db = db; this.enabled = false; this.opts = {}; this.subs = new Set(); }
  enable(opts = {}) { this.enabled = true; this.opts = { table: '_liteorm_changes', source: 'local', ...opts }; this.db.exec(`CREATE TABLE IF NOT EXISTS ${qi(this.opts.table)} (seq INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, row_id TEXT, op TEXT, old_values TEXT, new_values TEXT, source TEXT, tx_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`); return this; }
  _record(table, rowId, op, oldValues, newValues) { if (!this.enabled) return null; const tx = this.db._txId || null; this.db.exec(`INSERT INTO ${qi(this.opts.table)}(table_name,row_id,op,old_values,new_values,source,tx_id) VALUES(?,?,?,?,?,?,?)`, [table, String(rowId ?? ''), op, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null, this.opts.source, tx]); const seq = this.db.query('SELECT last_insert_rowid() AS seq')[0].seq; const change = { seq, table, table_name: table, rowId: String(rowId ?? ''), row_id: String(rowId ?? ''), op, oldValues, newValues, source: this.opts.source, txId: tx }; for (const fn of this.subs) fn(change); this.db._emit('change', change); return change; }
  changes(opts = {}) { if (!this.enabled) this.enable(); const wh = []; const params = []; if (opts.since != null) { wh.push('seq > ?'); params.push(opts.since); } if (opts.table) { wh.push('table_name = ?'); params.push(opts.table); } const rows = this.db.query(`SELECT * FROM ${qi(this.opts.table)}${wh.length ? ' WHERE ' + wh.join(' AND ') : ''} ORDER BY seq ASC${opts.limit ? ' LIMIT ' + Number(opts.limit) : ''}`, params); return rows.map(r => ({ seq: r.seq, table: r.table_name, table_name: r.table_name, rowId: r.row_id, row_id: r.row_id, op: r.op, oldValues: safeJsonParse(r.old_values), newValues: safeJsonParse(r.new_values), source: r.source, txId: r.tx_id, created_at: r.created_at })); }
  checkpoint() { const row = this.db.query(`SELECT COALESCE(MAX(seq),0) AS seq FROM ${qi(this.opts.table || '_liteorm_changes')}`)[0]; return row ? row.seq : 0; }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  apply(changes, opts = {}) { let applied = 0; for (const ch of changes || []) { if (!ch.table && !ch.table_name) continue; const table = ch.table || ch.table_name; const op = String(ch.op || '').toLowerCase(); const rowId = ch.rowId ?? ch.row_id; if (op.includes('delete') && rowId != null) { this.db.exec(`DELETE FROM ${qi(table)} WHERE id=?`, [rowId]); applied++; continue; } const row = ch.newValues || ch.new_values; if (row) { const cols = Object.keys(row); const conflict = cols.includes('id') ? 'id' : cols[0]; this.db.exec(`INSERT INTO ${qi(table)} (${cols.map(qi).join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(${qi(conflict)}) DO UPDATE SET ${cols.map(c => `${qi(c)}=excluded.${qi(c)}`).join(',')}`, cols.map(c => row[c])); applied++; } } return { applied }; }
}

class SyncHelpers {
  constructor(db) { this.db = db; }
  push(adapter, opts = {}) { const batch = this.db.cdc.changes({ since: opts.since || 0, limit: opts.limit }); const sent = adapter?.send ? adapter.send(batch) : batch.length; return { sent: typeof sent === 'number' ? sent : batch.length, changes: batch }; }
  pull(adapter, opts = {}) { const batch = adapter?.receive ? adapter.receive(opts) : []; const result = this.db.cdc.apply(batch, opts); return { received: batch.length, ...result }; }
  run(adapter, opts = {}) { const pushed = this.push(adapter, opts); const pulled = this.pull(adapter, opts); return { pushed, pulled }; }
}

class Database {
  constructor(filename = ':memory:', options = {}) {
    this.filename = filename; this.options = options; this.native = new native.NativeDatabase(filename);
    this.cacheStore = new Map(); this.migrations = []; this.schema = new SchemaBuilder(this); this.inspect = new Inspector(this); this.fts = new FTS(this); this.audit = new Audit(this); this.export = new DataPort(this, 'export'); this.import = new DataPort(this, 'import'); this.cdc = new CDC(this); this.sync = new SyncHelpers(this); this._events = new Map(); this._txDepth = 0; this._spId = 0; this._actorStack = []; this._systemDepth = 0; this._profile = null;
    this.async = { query: async (...a) => this.query(...a), exec: async (...a) => this.exec(...a), transaction: async fn => this.transaction(fn) };
    if (options.statementCache === false) this.native.setStatementCacheSize?.(0); else this.native.setStatementCacheSize?.(Number(options.statementCache ?? 100));
    if (options.busyTimeout) this.setBusyTimeout(options.busyTimeout);
    if (options.wal === false) this.pragma('journal_mode', 'DELETE');
    if (options.journalMode) this.pragma('journal_mode', options.journalMode);
    if (options.synchronous) this.pragma('synchronous', options.synchronous);
  }
  _emit(name, payload) { for (const fn of this._events.get(name) || []) fn(payload); }
  on(name, fn) { if (!this._events.has(name)) this._events.set(name, new Set()); this._events.get(name).add(fn); return () => this.off(name, fn); }
  off(name, fn) { this._events.get(name)?.delete(fn); return this; }
  profile(fn, opts = {}) { this._profile = fn ? { fn, opts: { thresholdMs: 0, ...opts } } : null; return this; }
  _profileEvent(kind, text, params, start, result, err) { const durationMs = Number(process.hrtime.bigint() - start) / 1e6; const ev = { kind, sql: text, params, durationMs, changes: result?.changes, lastInsertRowid: result?.lastInsertRowid, error: err?.message }; this._emit('query', ev); if (this._profile && durationMs >= (this._profile.opts.thresholdMs ?? 0)) this._profile.fn(ev); }
  _retry(fn, opts = null) { const retry = opts || this.options.retry || { attempts: 1, delay: 0 }; let last; for (let i = 0; i < (retry.attempts || retry.retries || 1); i++) { try { return fn(); } catch (e) { last = e; if (!/busy|locked/i.test(e.message) || i === (retry.attempts || retry.retries || 1) - 1) throw e; sleep(retry.delay || retry.retryDelay || 0); } } throw last; }
  exec(statement, params = []) { if (statement && statement.text) { params = statement.params || []; statement = statement.text; } const text = String(statement); const start = process.hrtime.bigint(); try { const res = this._retry(() => normalize(this.native.exec(text, params))); this._profileEvent('exec', text, params, start, res, null); return res; } catch (e) { const err = /busy|locked/i.test(e.message) ? new SQLiteBusyError(e.message) : new QueryError(e.message); this._profileEvent('exec', text, params, start, null, err); throw err; } }
  query(statement, params = [], cacheOptions = null) { if (statement && statement.text) { params = statement.params || []; statement = statement.text; } const text = String(statement); const key = cacheOptions ? text + '\0' + JSON.stringify(params) : null; if (key) { const hit = this.cacheStore.get(key); if (hit && hit.expires > Date.now()) return normalize(hit.rows.map(r => ({ ...r }))); if (hit) this.cacheStore.delete(key); } const start = process.hrtime.bigint(); try { const rows = this._retry(() => normalize(this.native.query(text, params))); if (key) { const ttl = typeof cacheOptions === 'number' ? cacheOptions : cacheOptions.ttl; const max = cacheOptions.max || this.options.cache?.max || 500; this.cacheStore.set(key, { expires: Date.now() + ttl, rows: rows.map(r => ({ ...r })) }); while (this.cacheStore.size > max) this.cacheStore.delete(this.cacheStore.keys().next().value); } this._profileEvent('query', text, params, start, { rows: rows.length }, null); return rows; } catch (e) { const err = /busy|locked/i.test(e.message) ? new SQLiteBusyError(e.message) : new QueryError(e.message); this._profileEvent('query', text, params, start, null, err); throw err; } }
  prepare(text) { return new Statement(this, text, this.native.prepare ? this.native.prepare(String(text)) : null); }
  clearCache() { this.cacheStore.clear(); }
  clearStatementCache() { this.native.clearStatementCache?.(); return this; }
  statementCacheStats() { return this.native.statementCacheStats ? normalize(this.native.statementCacheStats()) : { size: 0, max: 0, hits: 0, misses: 0, evictions: 0 }; }
  setStatementCacheSize(n) { this.native.setStatementCacheSize?.(Number(n)); return this; }
  close() { this.native.close(); }
  inTransaction() { return this.native.inTransaction ? !!this.native.inTransaction() : this._txDepth > 0; }
  setBusyTimeout(ms) { if (this.native.setBusyTimeout) this.native.setBusyTimeout(Number(ms)); else this.exec(`PRAGMA busy_timeout=${Number(ms)}`); return this; }
  transaction(fn, options = {}) {
    if (this._txDepth > 0 || options.savepoint) return this.savepoint(fn, options.name);
    const attempts = options.retries || options.attempts || this.options.retry?.attempts || 1;
    const delay = options.retryDelay || options.delay || this.options.retry?.delay || 0;
    return this._retry(() => {
      const rawMode = String(options.mode || 'IMMEDIATE').toUpperCase();
      const mode = ['DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'].includes(rawMode) ? rawMode : (() => { throw new Error(`Invalid transaction mode: ${options.mode}`); })();
      const prevTx = this._txId;
      this._txId = crypto.randomBytes(6).toString('hex');
      this.exec(`BEGIN ${mode}`); this._txDepth++;
      try { const result = fn(this); this._txDepth--; this.exec('COMMIT'); this._txId = prevTx; return result; }
      catch (err) { this._txDepth = Math.max(0, this._txDepth - 1); try { this.exec('ROLLBACK'); } catch (_) {} this._txId = prevTx; throw err; }
    }, { attempts, delay });
  }
  savepoint(fn, name = null) { const sp = name || `liteorm_sp_${++this._spId}`; this.exec(`SAVEPOINT ${qi(sp)}`); this._txDepth++; try { const result = fn(this); this._txDepth--; this.exec(`RELEASE ${qi(sp)}`); return result; } catch (err) { this._txDepth = Math.max(0, this._txDepth - 1); try { this.exec(`ROLLBACK TO ${qi(sp)}`); this.exec(`RELEASE ${qi(sp)}`); } catch (_) {} throw err; } }
  migrate(migrations) { this.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'); const applied = new Set(this.query('SELECT id FROM _migrations').map(r => r.id)); const merged = new Map(this.migrations.map(m => [m.id, m])); for (const m of migrations) { const prev = merged.get(m.id); merged.set(m.id, { ...(prev || {}), ...m, down: m.down || prev?.down }); } this.migrations = [...merged.values()]; return this.transaction(() => { const ran = []; for (const m of migrations) { if (applied.has(m.id)) continue; m.up(this); this.exec('INSERT INTO _migrations(id) VALUES (?)', [m.id]); ran.push(m.id); } return ran; }); }
  rollbackMigrations(steps = 1) { const rows = this.query('SELECT id FROM _migrations ORDER BY applied_at DESC, rowid DESC LIMIT ?', [steps]); const byId = new Map(this.migrations.map(m => [m.id, m])); return this.transaction(() => { const rolled = []; for (const row of rows) { const m = byId.get(row.id); if (!m?.down) throw new Error(`Migration ${row.id} has no down() function`); m.down(this); this.exec('DELETE FROM _migrations WHERE id = ?', [row.id]); rolled.push(row.id); } return rolled; }); }
  backup(file) { this.exec(`VACUUM INTO ?`, [file]); return file; }
  restore(file) { this.close(); if (this.filename === ':memory:') throw new Error('Cannot restore into memory database'); fs.copyFileSync(file, this.filename); this.native = new native.NativeDatabase(this.filename); this.clearCache(); }
  explain(q) { const s = q && typeof q.toSQL === 'function' ? q.toSQL() : (q.text ? q : { text: String(q), params: [] }); return this.query('EXPLAIN QUERY PLAN ' + s.text, s.params); }
  use(plugin, opts) { plugin(this, opts); return this; }
  pragma(name, value) { const allowed = new Set(['journal_mode','synchronous','busy_timeout','cache_size','temp_store','mmap_size','wal_autocheckpoint','foreign_keys','trusted_schema','query_only']); const n = String(name).replace(/[A-Z]/g, m => '_' + m.toLowerCase()).toLowerCase(); if (!allowed.has(n)) throw new Error(`Unsupported PRAGMA: ${name}`); if (value === undefined) return this.query(`PRAGMA ${n}`)[0]; const safe = typeof value === 'string' ? `'${String(value).replace(/'/g, "''")}'` : Number(value); return this.query(`PRAGMA ${n}=${safe}`)[0] || null; }
  tune(opts = {}) { const map = { journalMode: 'journal_mode', synchronous: 'synchronous', busyTimeout: 'busy_timeout', cacheSize: 'cache_size', tempStore: 'temp_store', mmapSize: 'mmap_size', walAutocheckpoint: 'wal_autocheckpoint' }; for (const [k, v] of Object.entries(opts)) if (map[k]) this.pragma(map[k], v); return this; }
  checkpoint(mode = 'PASSIVE') { return this.native.checkpoint ? normalize(this.native.checkpoint(String(mode).toUpperCase())) : this.query('PRAGMA wal_checkpoint')[0]; }
  optimize() { this.exec('PRAGMA optimize'); return this; }
  createFunction(name, fn, opts) { if (!this.native.createFunction) throw new Error('Native createFunction unavailable; rebuild package'); this.native.createFunction(name, fn, opts || {}); return this; }
  dropFunction(name, arity) { this.native.dropFunction?.(name, arity); return this; }
  createCollation(name, compare) { if (!this.native.createCollation) throw new Error('Native createCollation unavailable; rebuild package'); this.native.createCollation(name, compare); return this; }
  dropCollation(name) { this.native.dropCollation?.(name); return this; }
  factory(model, fn) { return { createMany: n => model.insertMany(Array.from({ length: n }, (_, i) => fn(i + 1))) }; }
  seed(fns) { return this.transaction(() => fns.map(fn => fn(this))); }
  seedDeterministic(model, fn, count) { return this.factory(model, fn).createMany(count); }
  repo(model, Repo) { return new Repo(model, this); }
  actor() { return this._actorStack[this._actorStack.length - 1] || null; }
  as(actor, fn) { this._actorStack.push(actor); try { return fn(this); } finally { this._actorStack.pop(); } }
  asSystem(fn) { this._systemDepth++; try { return fn(this); } finally { this._systemDepth--; } }
  get isSystem() { return this._systemDepth > 0; }
  rotateEncryptionKey(models, newKey) { const oldOptions = { ...this.options }; const updates = []; for (const model of models) { const enc = model.options.encrypted || []; if (!enc.length) continue; for (const row of this.query(`SELECT * FROM ${qi(model.table)}`)) { const hydrated = model._hydrate({ ...row }); const plain = {}; for (const f of enc) plain[f] = hydrated[f]; updates.push({ model, id: row.id, plain }); } } this.options.encryptionKey = newKey; for (const u of updates) { const out = {}; for (const [k, v] of Object.entries(u.plain)) out[k] = u.model._encrypt(v); const cols = Object.keys(out); this.exec(`UPDATE ${qi(u.model.table)} SET ${cols.map(c => `${qi(c)}=?`).join(', ')} WHERE id=?`, [...cols.map(c => out[c]), u.id]); } return updates.length; }
}

class Inspector { constructor(db) { this.db = db; } tables() { return this.db.query("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name); } columns(table) { return this.db.query(`PRAGMA table_info(${qi(table)})`); } indexes(table) { return this.db.query(`PRAGMA index_list(${qi(table)})`); } foreignKeys(table) { return this.db.query(`PRAGMA foreign_key_list(${qi(table)})`); } }

class FTS {
  constructor(db) { this.db = db; this.meta = new Map(); }
  create(name, opts = {}) { const cols = opts.columns || []; const extras = []; if (opts.tokenize) { const tok = String(opts.tokenize); if (!/^[A-Za-z0-9_\s]+$/.test(tok)) throw new Error('Invalid FTS tokenizer'); extras.push(`tokenize=${sqlLiteral(tok)}`); } if (opts.prefix) { const pref = opts.prefix.map(Number); if (!pref.every(n => Number.isInteger(n) && n > 0)) throw new Error('Invalid FTS prefix'); extras.push(`prefix=${sqlLiteral(pref.join(' '))}`); } this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${qi(name)} USING fts5(${cols.map(qi).join(', ')}${extras.length ? ', ' + extras.join(', ') : ''})`); this.meta.set(name, { columns: cols }); }
  insert(name, row) { const cols = Object.keys(row); this.db.exec(`INSERT INTO ${qi(name)} (${cols.map(qi).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c])); }
  sync(name, table, opts = {}) { const columns = opts.columns || this.meta.get(name)?.columns || []; const rowid = opts.rowid || 'id'; this.db.exec(`DELETE FROM ${qi(name)}`); this.db.exec(`INSERT INTO ${qi(name)}(rowid, ${columns.map(qi).join(', ')}) SELECT ${qi(rowid)}, ${columns.map(qi).join(', ')} FROM ${qi(table)}`); if (opts.triggers) { const prefix = `${table}_${name}`.replace(/[^A-Za-z0-9_]/g, '_'); this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${qi(prefix + '_ai')} AFTER INSERT ON ${qi(table)} BEGIN INSERT INTO ${qi(name)}(rowid, ${columns.map(qi).join(', ')}) VALUES (new.${qi(rowid)}, ${columns.map(c => 'new.' + qi(c)).join(', ')}); END;`); this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${qi(prefix + '_ad')} AFTER DELETE ON ${qi(table)} BEGIN DELETE FROM ${qi(name)} WHERE rowid=old.${qi(rowid)}; END;`); this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${qi(prefix + '_au')} AFTER UPDATE ON ${qi(table)} BEGIN DELETE FROM ${qi(name)} WHERE rowid=old.${qi(rowid)}; INSERT INTO ${qi(name)}(rowid, ${columns.map(qi).join(', ')}) VALUES (new.${qi(rowid)}, ${columns.map(c => 'new.' + qi(c)).join(', ')}); END;`); } return this; }
  search(name, term, opts = 20) { if (typeof opts === 'number') opts = { limit: opts }; const meta = this.meta.get(name) || {}; const cols = meta.columns || ['*']; const select = [`rowid`, ...cols.map(qi)]; if (opts.rank) select.push(`bm25(${qi(name)}) AS rank`); if (opts.highlight) { const col = typeof opts.highlight.column === 'number' ? opts.highlight.column : Math.max(0, cols.indexOf(opts.highlight.column)); select.push(`highlight(${qi(name)}, ${Number(col)}, ${sqlLiteral(opts.highlight.before || '<b>')}, ${sqlLiteral(opts.highlight.after || '</b>')}) AS highlight`); } if (opts.snippet) { const col = typeof opts.snippet.column === 'number' ? opts.snippet.column : Math.max(0, cols.indexOf(opts.snippet.column || cols[0])); select.push(`snippet(${qi(name)}, ${Number(col)}, ${sqlLiteral(opts.snippet.before || '<b>')}, ${sqlLiteral(opts.snippet.after || '</b>')}, ${sqlLiteral(opts.snippet.ellipsis || '…')}, ${Number(opts.snippet.tokens || 12)}) AS snippet`); } let text = `SELECT ${select.join(', ')} FROM ${qi(name)} WHERE ${qi(name)} MATCH ?`; if (opts.rank || opts.orderByRank) text += ` ORDER BY bm25(${qi(name)})`; text += ` LIMIT ?`; return this.db.query(text, [term, opts.limit || 20]); }
  delete(name, rowid) { return this.db.exec(`DELETE FROM ${qi(name)} WHERE rowid=?`, [rowid]).changes; }
  rebuild(name) { this.db.exec(`INSERT INTO ${qi(name)}(${qi(name)}) VALUES('rebuild')`); return this; }
  optimize(name) { this.db.exec(`INSERT INTO ${qi(name)}(${qi(name)}) VALUES('optimize')`); return this; }
}

class QueryBuilder {
  constructor(model, db = model.db, nested = false) { this.model = model; this.db = db; this.parts = []; this.params = []; this.orders = []; this.joins = []; this.groups = []; this.havings = []; this._select = ['*']; this._distinct = false; this._limit = null; this._offset = null; this._withDeleted = false; this._onlyDeleted = false; this._relations = []; this._counts = []; this._cache = null; this.nested = nested; }
  clone() { const q = new QueryBuilder(this.model, this.db, this.nested); for (const k of ['parts','params','orders','joins','groups','havings','_select','_relations','_counts']) q[k] = [...this[k]]; Object.assign(q, { _distinct: this._distinct, _limit: this._limit, _offset: this._offset, _withDeleted: this._withDeleted, _onlyDeleted: this._onlyDeleted, _cache: this._cache }); return q; }
  select(cols) { this._select = Array.isArray(cols) ? cols : [...arguments]; return this; }
  distinct() { this._distinct = true; return this; }
  _add(bool, expr, params = []) { this.parts.push({ bool, expr }); this.params.push(...params); return this; }
  where(column, op, value) { if (typeof column === 'function') { const q = new QueryBuilder(this.model, this.db, true); column(q); const w = q._whereExpr(); if (w) return this._add('AND', `(${w})`, q.params); return this; } if (value === undefined && !OPS.has(String(op).toUpperCase())) { value = op; op = '='; } op = checkOp(op); return this._add('AND', `${qi(column)} ${op} ?`, [value]); }
  orWhere(column, op, value) { if (typeof column === 'function') { const q = new QueryBuilder(this.model, this.db, true); column(q); const w = q._whereExpr(); if (w) return this._add('OR', `(${w})`, q.params); return this; } if (value === undefined && !OPS.has(String(op).toUpperCase())) { value = op; op = '='; } op = checkOp(op); return this._add('OR', `${qi(column)} ${op} ?`, [value]); }
  whereNot(column, op, value) { op = checkOp(op); return this._add('AND', `NOT (${qi(column)} ${op} ?)`, [value]); }
  whereIn(column, values) { return values.length ? this._add('AND', `${qi(column)} IN (${values.map(() => '?').join(',')})`, values) : this._add('AND', '0=1'); }
  whereNull(column) { return this._add('AND', `${qi(column)} IS NULL`); }
  whereBetween(column, a, b) { return this._add('AND', `${qi(column)} BETWEEN ? AND ?`, [a, b]); }
  whereExists(subquery, params = []) { const s = typeof subquery === 'string' ? { text: subquery, params } : subquery.toSQL(); return this._add('AND', `EXISTS (${s.text})`, params.length ? params : (s.params || [])); }
  whereJson(pathStr, op, value) { const jp = splitJsonPath(pathStr, this.model.table); op = checkOp(op); return this._add('AND', `json_extract(${qi(jp.column)}, ?) ${op} ?`, [jp.path, value]); }
  whereJsonExists(pathStr) { const jp = splitJsonPath(pathStr, this.model.table); return this._add('AND', `json_type(${qi(jp.column)}, ?) IS NOT NULL`, [jp.path]); }
  whereJsonContains(pathStr, value) { const jp = splitJsonPath(pathStr, this.model.table); return this._add('AND', `EXISTS (SELECT 1 FROM json_each(json_extract(${qi(jp.column)}, ?)) WHERE value = ?)`, [jp.path, value]); }
  whereJsonLength(pathStr, op, value) { const jp = splitJsonPath(pathStr, this.model.table); op = checkOp(op); return this._add('AND', `json_array_length(json_extract(${qi(jp.column)}, ?)) ${op} ?`, [jp.path, value]); }
  orderByJson(pathStr, dir = 'asc') { const jp = splitJsonPath(pathStr, this.model.table); this.orders.push(`json_extract(${qi(jp.column)}, ${sqlLiteral(jp.path)}) ${String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`); return this; }
  join(table, left, op, right) { this.joins.push(`JOIN ${qi(table)} ON ${qi(left)} ${op} ${qi(right)}`); return this; }
  leftJoin(table, left, op, right) { this.joins.push(`LEFT JOIN ${qi(table)} ON ${qi(left)} ${op} ${qi(right)}`); return this; }
  groupBy(...cols) { this.groups.push(...cols.flat()); return this; }
  having(expr, params = []) { this.havings.push(expr); this.params.push(...params); return this; }
  orderBy(column, dir = 'asc') { this.orders.push(`${qi(column)} ${String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`); return this; }
  limit(n) { this._limit = Number(n); return this; }
  offset(n) { this._offset = Number(n); return this; }
  with(name, constraint) { this._relations.push({ name, constraint }); return this; }
  withCount(name) { this._counts.push(name); return this; }
  withDeleted() { this._withDeleted = true; return this; }
  withTrashed() { return this.withDeleted(); }
  onlyDeleted() { this._onlyDeleted = true; this._withDeleted = true; return this; }
  onlyTrashed() { return this.onlyDeleted(); }
  cache(ttl = 1000) { this._cache = { ttl }; return this; }
  scope(name) { const fn = this.model.options.scopes?.[name]; if (!fn) throw new Error(`Unknown scope: ${name}`); fn(this); return this; }
  _whereExpr(extra = []) { const arr = [...this.parts]; for (const e of extra) arr.push({ bool: 'AND', expr: e }); return arr.map((p, i) => `${i ? p.bool + ' ' : ''}${p.expr}`).join(' '); }
  _whereSql(extra = []) { const wh = [...extra]; const deleted = this.model._deletedColumn(); if (this.model._paranoid() && !this._withDeleted) wh.push(`${qi(this.model.table)}.${qi(deleted)} IS NULL`); if (this._onlyDeleted) wh.push(`${qi(this.model.table)}.${qi(deleted)} IS NOT NULL`); const expr = this._whereExpr(wh); return expr ? ` WHERE ${expr}` : ''; }
  _applyReadPolicy() { this.model._applyReadPolicy(this); return this; }
  toSQL(selectOverride) { const select = selectOverride || this._select.map(qi).join(', '); let text = `SELECT ${this._distinct ? 'DISTINCT ' : ''}${select} FROM ${qi(this.model.table)}`; if (this.joins.length) text += ' ' + this.joins.join(' '); text += this._whereSql(); if (this.groups.length) text += ` GROUP BY ${this.groups.map(qi).join(', ')}`; if (this.havings.length) text += ` HAVING ${this.havings.join(' AND ')}`; if (this.orders.length) text += ` ORDER BY ${this.orders.join(', ')}`; if (this._limit != null) text += ` LIMIT ${this._limit}`; if (this._offset != null) text += ` OFFSET ${this._offset}`; return { text, params: [...this.params] }; }
  get() { this._applyReadPolicy(); const { text, params } = this.toSQL(); const rows = this.db.query(text, params, this._cache); const out = rows.map(r => this.model._hydrate(r)); this.model._loadCounts(out, this._counts || [], this.db); this.model._loadRelations(out, this._relations, this.db); return out; }
  cursorPaginate({ after = null, limit = 20, column = 'id', direction = 'asc' } = {}) { const q = this.clone(); if (after != null) q.where(column, direction.toLowerCase() === 'desc' ? '<' : '>', after); q.limit(limit + 1); const rows = q.get(); const hasMore = rows.length > limit; const data = hasMore ? rows.slice(0, limit) : rows; return { data, hasMore, nextCursor: data.length ? data[data.length - 1][column.split('.').pop()] : null }; }
  first() { const q = this.clone().limit(1); return q.get()[0] || null; }
  count() { this._applyReadPolicy(); const text = `SELECT COUNT(*) AS n FROM ${qi(this.model.table)}${this._whereSql()}`; return this.db.query(text, this.params)[0].n; }
  update(data) { this.model._authorize('update', data); this.model._authorizeFields('update', data); const before = this.clone().withDeleted().get(); const row = this.model._prepareWrite(data, false); const cols = Object.keys(row); if (!cols.length) return 0; const res = this.db.exec(`UPDATE ${qi(this.model.table)} SET ${cols.map(c => `${qi(c)} = ?`).join(', ')}${this._whereSql()}`, [...cols.map(c => row[c]), ...this.params]); this.db.clearCache(); if (res.changes) { for (const b of before) this.model._afterWrite('update', b.id, b, { ...b, ...data }, res.changes); this.model._runHook('afterUpdate', row, { op: 'update', changes: res.changes, previous: before }); this.model._runHook('afterSave', row, { op: 'update', changes: res.changes, previous: before }); } return res.changes; }
  delete(force = false) { this.model._authorize('delete', null); const before = this.clone().get(); for (const r of before) this.model._runHook('beforeDestroy', r, { op: force ? 'forceDelete' : 'delete', previous: r }); for (const r of before) this.model._runHook('beforeDelete', r, { op: force ? 'forceDelete' : 'delete', previous: r }); let changes; if (this.model._paranoid() && !force) changes = this.update({ [this.model._deletedColumn()]: nowIso() }); else { const res = this.db.exec(`DELETE FROM ${qi(this.model.table)}${this._whereSql()}`, this.params); this.db.clearCache(); changes = res.changes; } if (changes) for (const r of before) { this.model.db.audit?.log(this.model.table, r.id, force ? 'forceDelete' : 'delete', r.toJSON ? r.toJSON() : r, null); this.model.db.cdc?._record(this.model.table, r.id, force ? 'forceDelete' : 'delete', r.toJSON ? r.toJSON() : r, null); this.model._runHook('afterDestroy', r, { op: force ? 'forceDelete' : 'delete', changes }); this.model._runHook('afterDelete', r, { op: force ? 'forceDelete' : 'delete', changes }); } return changes; }
  restore() { if (!this.model._paranoid()) return 0; const before = this.clone().withDeleted().get(); for (const r of before) this.model._runHook('beforeRestore', r, { op: 'restore', previous: r }); const res = this.update({ [this.model._deletedColumn()]: null }); if (res) for (const r of before) { this.model.db.audit?.log(this.model.table, r.id, 'restore', null, this.model.find(r.id, true)?.toJSON?.()); this.model.db.cdc?._record(this.model.table, r.id, 'restore', r.toJSON ? r.toJSON() : r, this.model.find(r.id, true)?.toJSON?.()); this.model._runHook('afterRestore', r, { op: 'restore', changes: res }); } return res; }
  jsonSet(pathStr, value) { const jp = splitJsonPath(pathStr, this.model.table); const res = this.db.exec(`UPDATE ${qi(this.model.table)} SET ${qi(jp.column)} = json_set(COALESCE(${qi(jp.column)}, '{}'), ?, json(?))${this._whereSql()}`, [jp.path, jsonValue(value), ...this.params]); this.db.clearCache(); return res.changes; }
  jsonPatch(column, patch) { const res = this.db.exec(`UPDATE ${qi(this.model.table)} SET ${qi(column)} = json_patch(COALESCE(${qi(column)}, '{}'), json(?))${this._whereSql()}`, [jsonValue(patch), ...this.params]); this.db.clearCache(); return res.changes; }
  jsonRemove(pathStr) { const jp = splitJsonPath(pathStr, this.model.table); const res = this.db.exec(`UPDATE ${qi(this.model.table)} SET ${qi(jp.column)} = json_remove(COALESCE(${qi(jp.column)}, '{}'), ?)${this._whereSql()}`, [jp.path, ...this.params]); this.db.clearCache(); return res.changes; }
  insert(data) { this._pendingInsert = data; return this; }
  onConflict(cols) { this._conflict = Array.isArray(cols) ? cols : [cols]; return this; }
  ignore() { return this._insertConflict('ignore'); }
  merge(cols) { return this._insertConflict('merge', cols); }
  _insertConflict(mode, mergeCols) { return this.model._insertConflict(this._pendingInsert, this._conflict || ['id'], mode, mergeCols); }
}

class Model {
  constructor(db, table, options = {}) { this.db = db; this.table = table; this.options = { ...options }; this.hooks = new Map(); this._deriveOptionsFromFields(); }
  _deriveOptionsFromFields() { const fields = this.options.fields || {}; this.options.hidden = [...new Set([...(this.options.hidden || []), ...Object.entries(fields).filter(([, f]) => f.attrs?.hidden).map(([k]) => k)])]; this.options.json = [...new Set([...(this.options.json || []), ...Object.entries(fields).filter(([, f]) => f.attrs?.isJson).map(([k]) => k)])]; this.options.encrypted = [...new Set([...(this.options.encrypted || []), ...Object.entries(fields).filter(([, f]) => f.attrs?.encrypted).map(([k]) => k)])]; }
  _paranoid() { return !!(this.options.paranoid || this.options.softDelete); }
  _deletedColumn() { return this.options.deletedAt || 'deleted_at'; }
  using(db) { const m = new Model(db, this.table, this.options); m.hooks = this.hooks; return m; }
  query() { return new QueryBuilder(this); }
  hook(name, fn) { if (!LIFECYCLE_HOOKS.has(name)) throw new Error(`Unknown lifecycle hook: ${name}`); if (!this.hooks.has(name)) this.hooks.set(name, []); this.hooks.get(name).push(fn); return () => { const arr = this.hooks.get(name) || []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }; }
  _runHook(name, row, ctx = {}) { const fns = this.hooks.get(name) || []; for (const fn of fns) { const context = { db: this.db, model: this, table: this.table, op: name.replace(/^before|^after/, '').toLowerCase(), row, ...ctx, abort(reason) { throw new HookAbortError(String(reason || 'Hook aborted')); } }; const ret = fn(row, context); if (isPromiseLike(ret)) throw new QueryError('Async hooks are not supported by synchronous API'); if (ret === false) throw new HookAbortError(`${name} aborted`); } }
  validate(row, opts = {}) { const issues = this._collectIssues({ ...row }, opts.mode !== 'update', opts); return { valid: issues.length === 0, issues }; }
  assertValid(row, opts = {}) { const result = this.validate(row, opts); if (!result.valid) throw new ValidationError(`Validation failed: ${result.issues.map(i => i.message).join('; ')}`, result.issues); }
  _collectIssues(row, creating, opts = {}) { const issues = []; const fields = this.options.fields || {}; if ((this.options.strict || opts.strict) && Object.keys(fields).length) for (const k of Object.keys(row)) if (!(k in fields)) issues.push({ field: k, code: 'unknown', message: `${k} unknown`, value: row[k] }); for (const [k, def] of Object.entries(fields)) { const a = def.attrs || {}; const v = row[k]; const present = Object.prototype.hasOwnProperty.call(row, k); if ((creating || present) && a.notNull && v == null && !('default' in a) && !a.autoIncrement) issues.push({ field: k, code: 'required', message: `${k} required`, value: v }); if (v != null && def.jsType === 'integer' && typeof v !== 'number') issues.push({ field: k, code: 'type', message: `${k} must be number`, value: v }); if (v != null && def.jsType === 'text' && typeof v !== 'string') issues.push({ field: k, code: 'type', message: `${k} must be string`, value: v }); if (v != null && def.jsType === 'boolean' && typeof v !== 'boolean' && !(v === 0 || v === 1)) issues.push({ field: k, code: 'type', message: `${k} must be boolean`, value: v }); if (v != null && a.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) issues.push({ field: k, code: 'email', message: `${k} email invalid`, value: v }); if (v != null && a.min != null && (typeof v === 'number' ? v < a.min : String(v).length < a.min)) issues.push({ field: k, code: 'min', message: `${k} min ${a.min}`, value: v }); if (v != null && a.max != null && (typeof v === 'number' ? v > a.max : String(v).length > a.max)) issues.push({ field: k, code: 'max', message: `${k} max ${a.max}`, value: v }); if (v != null && a.regex) { a.regex.lastIndex = 0; if (!a.regex.test(String(v))) issues.push({ field: k, code: 'regex', message: `${k} regex invalid`, value: v }); } if (v != null && a.enum && !a.enum.includes(v)) issues.push({ field: k, code: 'enum', message: `${k} enum invalid`, value: v }); if (v != null && a.validJson && typeof v === 'string') { try { JSON.parse(v); } catch (_) { issues.push({ field: k, code: 'json', message: `${k} invalid JSON`, value: v }); } } for (const chk of a.checks || []) { const ok = chk.fn(v, row); if (ok !== true && ok !== undefined) issues.push({ field: k, code: chk.code, message: typeof ok === 'string' ? ok : (chk.message || `${k} invalid`), value: v }); } }
    for (const [k, rule] of Object.entries(this.options.validate || {})) { if (!creating && !(k in row)) continue; const r = rule(row[k], row); if (r !== true && r !== undefined) issues.push({ field: k, code: 'custom', message: typeof r === 'string' ? r : `${k} invalid`, value: row[k] }); }
    return issues;
  }
  _validate(row, creating) { this._runHook('beforeValidate', row, { op: creating ? 'create' : 'update' }); const issues = this._collectIssues(row, creating); if (issues.length) throw new ValidationError(`Validation failed: ${issues.map(i => i.message).join('; ')}`, issues); this._runHook('afterValidate', row, { op: creating ? 'create' : 'update' }); }
  _applyDefaults(row) { for (const [k, def] of Object.entries(this.options.fields || {})) if (!(k in row) && 'default' in def.attrs) row[k] = typeof def.attrs.default === 'function' ? def.attrs.default() : def.attrs.default; }
  _key() { const k = this.db.options.encryptionKey; return Buffer.isBuffer(k) ? k : (k instanceof Uint8Array ? Buffer.from(k) : crypto.createHash('sha256').update(String(k || 'lite-orm-default-key')).digest()); }
  _encrypt(v) { if (v == null || String(v).startsWith('enc:')) return v; const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', this._key(), iv); const enc = Buffer.concat([c.update(String(v), 'utf8'), c.final()]); return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64'); }
  _decrypt(v) { if (typeof v !== 'string' || !v.startsWith('enc:')) return v; const b = Buffer.from(v.slice(4), 'base64'); const iv = b.subarray(0, 12), tag = b.subarray(12, 28), data = b.subarray(28); const d = crypto.createDecipheriv('aes-256-gcm', this._key(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(data), d.final()]).toString('utf8'); }
  _prepareWrite(data, creating) { const row = { ...data }; if (creating) this._applyDefaults(row); this._validate(row, creating); this._runHook(creating ? 'beforeCreate' : 'beforeUpdate', row, { op: creating ? 'create' : 'update' }); this._runHook('beforeSave', row, { op: creating ? 'create' : 'update' }); this._validate(row, creating); for (const f of this.options.json || []) if (row[f] !== undefined && row[f] !== null && typeof row[f] !== 'string') row[f] = JSON.stringify(row[f]); for (const f of this.options.encrypted || []) if (row[f] !== undefined) row[f] = this._encrypt(row[f]); const now = nowIso(); if (this.options.timestamps) { if (creating && row.created_at === undefined) row.created_at = now; if (row.updated_at === undefined) row.updated_at = now; } return row; }
  _fieldAllowed(action, fieldName, row) { if (this.db.isSystem) return true; const rule = this.options.policies?.fields?.[fieldName]?.[action]; if (rule == null) return true; if (typeof rule === 'function') return !!rule({ actor: this.db.actor(), model: this, row, field: fieldName, action }); return !!rule; }
  _authorizeFields(action, data, row) { if (this.db.isSystem || !data) return true; for (const fieldName of Object.keys(data)) if (!this._fieldAllowed(action, fieldName, row || data)) throw new AuthorizationError(`${action} denied for field ${fieldName} on ${this.table}`); return true; }
  can(action, actor, row) { try { return this.db.as(actor, () => { this._authorize(action, row); return true; }); } catch (e) { if (e instanceof AuthorizationError) return false; throw e; } }
  authorize(action, actor, row) { return this.db.as(actor, () => this._authorize(action, row)); }
  _authorize(action, row) { if (this.db.isSystem) return true; const policy = this.options.policies?.[action]; if (!policy) return true; const out = typeof policy === 'function' ? policy({ actor: this.db.actor(), model: this, row, action }) : policy; if (out === false) throw new AuthorizationError(`${action} denied on ${this.table}`); return true; }
  _applyReadPolicy(q) { if (this.db.isSystem) return; const policy = this.options.policies?.read; if (!policy || q._readPolicyApplied) return; q._readPolicyApplied = true; const out = typeof policy === 'function' ? policy({ actor: this.db.actor(), model: this, q, action: 'read' }) : policy; if (out === false) throw new AuthorizationError(`read denied on ${this.table}`); }
  _instance(row) { const model = this; const original = { ...row }; Object.defineProperties(row, { getChanges: { enumerable: false, value() { const out = {}; for (const [k, v] of Object.entries(row)) if (typeof v !== 'function' && JSON.stringify(v) !== JSON.stringify(original[k])) out[k] = v; return out; } }, save: { enumerable: false, value() { const changes = row.getChanges(); if (!Object.keys(changes).length) return 0; if (model.options.optimisticLock) { model._authorize('update', changes); model._authorizeFields('update', changes, row); const oldVer = original.version || 0; changes.version = oldVer + 1; const prep = model._prepareWrite(changes, false); const cols = Object.keys(prep); const res = model.db.exec(`UPDATE ${qi(model.table)} SET ${cols.map(c => `${qi(c)}=?`).join(', ')} WHERE id=? AND version=?`, [...cols.map(c => prep[c]), row.id, oldVer]); if (!res.changes) throw new ConflictError('Optimistic lock conflict'); Object.assign(original, model.find(row.id, true)); Object.assign(row, original); return res.changes; } const n = model.query().where('id', '=', row.id).update(changes); Object.assign(original, row); return n; } }, delete: { enumerable: false, value(force=false) { return model.delete(row.id, force); } }, restore: { enumerable: false, value() { return model.restore(row.id); } }, reload: { enumerable: false, value() { const fresh = model.find(row.id, true); Object.assign(row, fresh); Object.assign(original, fresh); return row; } }, toJSON: { enumerable: false, value() { const out = {}; for (const [k, v] of Object.entries(row)) if (!(model.options.hidden || []).includes(k) && model._fieldAllowed('read', k, row)) out[k] = v; for (const [k, fn] of Object.entries(model.options.computed || {})) out[k] = fn(row); return out; } } }); return row; }
  _hydrate(row) { for (const f of this.options.json || []) if (typeof row[f] === 'string') { try { row[f] = JSON.parse(row[f]); } catch (_) {} } for (const f of this.options.encrypted || []) if (row[f] !== undefined) row[f] = this._decrypt(row[f]); return this._instance(row); }
  _afterWrite(op, rowId, oldValues, newValues, changes = 1) { this.db.cdc?._record(this.table, rowId, op, oldValues?.toJSON ? oldValues.toJSON() : oldValues, newValues?.toJSON ? newValues.toJSON() : newValues); }
  create(data) { this._authorize('create', data); this._authorizeFields('create', data); return this.db.savepoint(() => { const row = this._prepareWrite(data, true); const cols = Object.keys(row); const res = this.db.exec(`INSERT INTO ${qi(this.table)} (${cols.map(qi).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c])); this.db.clearCache(); const fresh = this.find(res.lastInsertRowid, true); this.db.audit?.log(this.table, fresh?.id || res.lastInsertRowid, 'create', null, fresh?.toJSON ? fresh.toJSON() : fresh); this._afterWrite('create', fresh?.id || res.lastInsertRowid, null, fresh?.toJSON ? fresh.toJSON() : fresh); this._runHook('afterCreate', fresh, { op: 'create' }); this._runHook('afterSave', fresh, { op: 'create' }); return fresh; }); }
  insertMany(rows) { return this.db.transaction(() => rows.map(r => this.create(r))); }
  _insertConflict(data, conflictCols, mode, mergeCols) { this._authorize('create', data); this._authorizeFields('create', data); const row = this._prepareWrite(data, true); this._runHook('beforeUpsert', row, { op: 'upsert' }); const cols = Object.keys(row); let text = `INSERT INTO ${qi(this.table)} (${cols.map(qi).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(${conflictCols.map(qi).join(', ')}) DO `; if (mode === 'ignore') text += 'NOTHING'; else { const upd = (mergeCols || cols.filter(c => !conflictCols.includes(c))).map(c => `${qi(c)}=excluded.${qi(c)}`).join(', '); text += `UPDATE SET ${upd}`; } const res = this.db.exec(text, cols.map(c => row[c])); this.db.clearCache(); this.db.audit?.log(this.table, null, 'upsert', null, data); this._afterWrite('upsert', null, null, data); this._runHook('afterUpsert', row, { op: 'upsert', changes: res.changes }); return res; }
  upsert(data, conflictCols, mergeCols) { return this._insertConflict(data, Array.isArray(conflictCols) ? conflictCols : [conflictCols], 'merge', mergeCols); }
  find(id, withDeleted = false) { const q = this.query().where(`${this.table}.id`, '=', id); if (withDeleted) q.withDeleted(); return q.first(); }
  delete(id, force = false) { return this.query().where('id', '=', id).delete(force); }
  forceDelete(id) { this._authorize('delete', null); const before = this.find(id, true); if (!before) return 0; const res = this.db.exec(`DELETE FROM ${qi(this.table)} WHERE id=?`, [id]); this.db.clearCache(); if (res.changes) { this.db.audit?.log(this.table, id, 'forceDelete', before.toJSON ? before.toJSON() : before, null); this.db.cdc?._record(this.table, id, 'forceDelete', before.toJSON ? before.toJSON() : before, null); } return res.changes; }
  restore(id) { return this.query().withDeleted().where('id', '=', id).restore(); }
  _loadCounts(rows, names, db) { if (!rows.length) return; for (const name of names) { const rel = this.options.relations?.[name]; if (!rel) continue; const target = getModel(this.db, rel.model); if (rel.type === 'hasMany') for (const r of rows) r[`${name}_count`] = target.using(db).query().where(rel.foreignKey, '=', r[rel.localKey || 'id']).count(); } }
  _loadRelations(rows, relSpecs, db) { if (!rows.length || !relSpecs.length) return; for (const spec of relSpecs) { const name0 = typeof spec === 'string' ? spec : spec.name; const constraint = typeof spec === 'object' ? spec.constraint : null; const [name, ...rest] = String(name0).split('.'); const rel = this.options.relations?.[name]; if (!rel) throw new Error(`Unknown relation: ${name}`); const target = getModel(this.db, rel.model); if (rel.type === 'hasMany') { const keys = [...new Set(rows.map(r => r[rel.localKey || 'id']).filter(v => v != null))]; const q = target.using(db).query().whereIn(rel.foreignKey, keys); if (constraint) constraint(q); const children = q.get(); const bucket = new Map(); for (const c of children) { const k = c[rel.foreignKey]; if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push(c); } for (const r of rows) r[name] = bucket.get(r[rel.localKey || 'id']) || []; if (rest.length) target._loadRelations(children, [rest.join('.')], db); } else if (rel.type === 'belongsTo' || rel.type === 'hasOne') { const localVal = rel.type === 'hasOne' ? (rel.localKey || 'id') : rel.foreignKey; const foreign = rel.type === 'hasOne' ? rel.foreignKey : (rel.ownerKey || 'id'); const keys = [...new Set(rows.map(r => r[localVal]).filter(v => v != null))]; const q = target.using(db).query().whereIn(foreign, keys); if (constraint) constraint(q); const parents = q.get(); const by = new Map(parents.map(p => [p[foreign], p])); for (const r of rows) r[name] = by.get(r[localVal]) || null; if (rest.length) target._loadRelations(parents, [rest.join('.')], db); } else if (rel.type === 'belongsToMany') { const localIds = [...new Set(rows.map(r => r.id).filter(v => v != null))]; const piv = localIds.length ? db.query(`SELECT * FROM ${qi(rel.pivot)} WHERE ${qi(rel.foreignPivotKey)} IN (${localIds.map(() => '?').join(',')})`, localIds) : []; const relatedIds = [...new Set(piv.map(p => p[rel.relatedPivotKey]))]; const q = target.using(db).query().whereIn('id', relatedIds); if (constraint) constraint(q); const related = q.get(); const byId = new Map(related.map(r => [r.id, r])); const bucket = new Map(); for (const p of piv) { const k = p[rel.foreignPivotKey]; if (!bucket.has(k)) bucket.set(k, []); const item = byId.get(p[rel.relatedPivotKey]); if (item) bucket.get(k).push(item); } for (const r of rows) r[name] = bucket.get(r.id) || []; if (rest.length) target._loadRelations(related, [rest.join('.')], db); } } }
  search(term, opts = {}) { const table = this.options.fts?.table; if (!table) throw new Error('Model has no fts table configured'); const rows = this.db.fts.search(table, term, opts); const ids = rows.map(r => r.rowid).filter(Boolean); return ids.length ? this.query().whereIn('id', ids).get() : []; }
}

function defineModel(db, table, options = {}) { const m = new Model(db, table, options); registry(db).set(table, m); return m; }
function createSqlJsAdapter(SQL, filename = ':memory:') { return require('./adapters/sqljs').createSqlJsAdapter(SQL, filename); }

module.exports = { Database, defineModel, Model, QueryBuilder, sql, field, FieldDef, errors, sqliteVersion: native.sqliteVersion, createSqlJsAdapter };
