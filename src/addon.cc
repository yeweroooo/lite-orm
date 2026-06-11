#include <node_api.h>
#include <sqlite3.h>
#include <algorithm>
#include <chrono>
#include <cctype>
#include <deque>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#define NAPI_OK(env, call) do { napi_status _napi_status = (call); if (_napi_status != napi_ok) throw std::runtime_error("N-API call failed"); } while (0)

static napi_ref db_ctor;
static napi_ref stmt_ctor;

struct DbWrap;
struct StmtWrap { DbWrap* owner = nullptr; sqlite3_stmt* stmt = nullptr; bool finalized = false; std::string sql; };
struct FunctionWrap { napi_env env = nullptr; napi_ref fn = nullptr; };
struct CollationWrap { napi_env env = nullptr; napi_ref fn = nullptr; };

struct DbWrap {
  sqlite3* db = nullptr;
  bool closed = false;
  std::unordered_map<std::string, sqlite3_stmt*> cache;
  std::deque<std::string> lru;
  size_t cache_max = 100;
  uint64_t hits = 0, misses = 0, evictions = 0;
  std::set<StmtWrap*> live;
};

static std::string str(napi_env env, napi_value v) {
  size_t len = 0;
  NAPI_OK(env, napi_get_value_string_utf8(env, v, nullptr, 0, &len));
  std::vector<char> buf(len + 1);
  NAPI_OK(env, napi_get_value_string_utf8(env, v, buf.data(), buf.size(), &len));
  return std::string(buf.data(), len);
}

static napi_value js_string(napi_env env, const char* s) { napi_value v; NAPI_OK(env, napi_create_string_utf8(env, s ? s : "", NAPI_AUTO_LENGTH, &v)); return v; }
static napi_value js_string(napi_env env, const std::string& s) { napi_value v; NAPI_OK(env, napi_create_string_utf8(env, s.c_str(), s.size(), &v)); return v; }
static napi_value js_int64(napi_env env, sqlite3_int64 x) { napi_value v; NAPI_OK(env, napi_create_bigint_int64(env, x, &v)); return v; }
static napi_value js_num(napi_env env, double x) { napi_value v; NAPI_OK(env, napi_create_double(env, x, &v)); return v; }
static napi_value js_bool(napi_env env, bool b) { napi_value v; NAPI_OK(env, napi_get_boolean(env, b, &v)); return v; }
static napi_value js_null(napi_env env) { napi_value v; NAPI_OK(env, napi_get_null(env, &v)); return v; }
static napi_value js_undefined(napi_env env) { napi_value v; NAPI_OK(env, napi_get_undefined(env, &v)); return v; }

static bool is_tail_empty(const char* tail) {
  if (!tail) return true;
  while (*tail) {
    if (std::isspace(static_cast<unsigned char>(*tail)) || *tail == ';') { ++tail; continue; }
    return false;
  }
  return true;
}

static void throw_sql(napi_env env, sqlite3* db, const std::string& prefix = "SQLite error") {
  std::string msg = prefix + ": " + (db ? sqlite3_errmsg(db) : "unknown");
  napi_throw_error(env, nullptr, msg.c_str());
}

static DbWrap* unwrap_db(napi_env env, napi_value self) {
  DbWrap* w = nullptr;
  NAPI_OK(env, napi_unwrap(env, self, reinterpret_cast<void**>(&w)));
  if (!w || !w->db || w->closed) throw std::runtime_error("Database is closed");
  return w;
}

static StmtWrap* unwrap_stmt(napi_env env, napi_value self) {
  StmtWrap* s = nullptr;
  NAPI_OK(env, napi_unwrap(env, self, reinterpret_cast<void**>(&s)));
  if (!s || s->finalized || !s->stmt) throw std::runtime_error("Statement finalized");
  if (!s->owner || s->owner->closed || !s->owner->db) throw std::runtime_error("Database is closed");
  return s;
}

static void finalize_stmt_wrap(StmtWrap* sw) {
  if (!sw) return;
  if (sw->owner) sw->owner->live.erase(sw);
  if (sw->stmt) sqlite3_finalize(sw->stmt);
  sw->stmt = nullptr;
  sw->finalized = true;
}

static void clear_cache(DbWrap* w) {
  if (!w) return;
  for (auto& kv : w->cache) sqlite3_finalize(kv.second);
  w->cache.clear();
  w->lru.clear();
}

static void finalize_db(napi_env env, void* data, void*) {
  auto* w = static_cast<DbWrap*>(data);
  if (!w) return;
  clear_cache(w);
  for (auto* sw : std::vector<StmtWrap*>(w->live.begin(), w->live.end())) {
    if (sw) { if (sw->stmt) sqlite3_finalize(sw->stmt); sw->stmt = nullptr; sw->finalized = true; sw->owner = nullptr; }
  }
  w->live.clear();
  if (w->db) sqlite3_close(w->db);
  w->db = nullptr;
  w->closed = true;
  delete w;
}

static void bind_value(napi_env env, sqlite3_stmt* stmt, int idx, napi_value v) {
  napi_valuetype t;
  NAPI_OK(env, napi_typeof(env, v, &t));
  int rc = SQLITE_OK;
  if (t == napi_null || t == napi_undefined) rc = sqlite3_bind_null(stmt, idx);
  else if (t == napi_boolean) { bool b; NAPI_OK(env, napi_get_value_bool(env, v, &b)); rc = sqlite3_bind_int(stmt, idx, b ? 1 : 0); }
  else if (t == napi_number) { double d; NAPI_OK(env, napi_get_value_double(env, v, &d)); rc = sqlite3_bind_double(stmt, idx, d); }
  else if (t == napi_bigint) { int64_t x; bool lossless; NAPI_OK(env, napi_get_value_bigint_int64(env, v, &x, &lossless)); if (!lossless) throw std::runtime_error("BigInt outside int64 range"); rc = sqlite3_bind_int64(stmt, idx, static_cast<sqlite3_int64>(x)); }
  else if (t == napi_string) { auto s = str(env, v); if (s.size() > static_cast<size_t>(std::numeric_limits<int>::max())) throw std::runtime_error("String parameter too large"); rc = sqlite3_bind_text(stmt, idx, s.c_str(), (int)s.size(), SQLITE_TRANSIENT); }
  else {
    bool is_buf = false; NAPI_OK(env, napi_is_buffer(env, v, &is_buf));
    if (is_buf) { void* data; size_t len; NAPI_OK(env, napi_get_buffer_info(env, v, &data, &len)); if (len > static_cast<size_t>(std::numeric_limits<int>::max())) throw std::runtime_error("Buffer parameter too large"); rc = sqlite3_bind_blob(stmt, idx, data, (int)len, SQLITE_TRANSIENT); }
    else throw std::runtime_error("Unsupported SQLite parameter type");
  }
  if (rc != SQLITE_OK) throw std::runtime_error("SQLite bind failed");
}

static void bind_params(napi_env env, sqlite3_stmt* stmt, napi_value arr) {
  bool is_arr = false; NAPI_OK(env, napi_is_array(env, arr, &is_arr));
  if (!is_arr) return;
  uint32_t n = 0; NAPI_OK(env, napi_get_array_length(env, arr, &n));
  sqlite3_clear_bindings(stmt);
  for (uint32_t i = 0; i < n; ++i) { napi_value v; NAPI_OK(env, napi_get_element(env, arr, i, &v)); bind_value(env, stmt, (int)i + 1, v); }
}

static napi_value column_value(napi_env env, sqlite3_stmt* stmt, int i) {
  switch (sqlite3_column_type(stmt, i)) {
    case SQLITE_NULL: return js_null(env);
    case SQLITE_INTEGER: return js_int64(env, sqlite3_column_int64(stmt, i));
    case SQLITE_FLOAT: return js_num(env, sqlite3_column_double(stmt, i));
    case SQLITE_TEXT: return js_string(env, reinterpret_cast<const char*>(sqlite3_column_text(stmt, i)));
    case SQLITE_BLOB: {
      const void* blob = sqlite3_column_blob(stmt, i); int len = sqlite3_column_bytes(stmt, i); napi_value buf; void* out;
      NAPI_OK(env, napi_create_buffer_copy(env, len, blob, &out, &buf)); return buf;
    }
  }
  return js_null(env);
}

static napi_value sqlite_value_to_js(napi_env env, sqlite3_value* v) {
  switch (sqlite3_value_type(v)) {
    case SQLITE_NULL: return js_null(env);
    case SQLITE_INTEGER: return js_num(env, static_cast<double>(sqlite3_value_int64(v)));
    case SQLITE_FLOAT: return js_num(env, sqlite3_value_double(v));
    case SQLITE_TEXT: return js_string(env, reinterpret_cast<const char*>(sqlite3_value_text(v)));
    case SQLITE_BLOB: {
      const void* blob = sqlite3_value_blob(v); int len = sqlite3_value_bytes(v); napi_value buf; void* out;
      NAPI_OK(env, napi_create_buffer_copy(env, len, blob, &out, &buf)); return buf;
    }
  }
  return js_null(env);
}

static std::string stringify_js(napi_env env, napi_value v) {
  napi_value json, stringify, global, out;
  NAPI_OK(env, napi_get_global(env, &global));
  NAPI_OK(env, napi_get_named_property(env, global, "JSON", &json));
  NAPI_OK(env, napi_get_named_property(env, json, "stringify", &stringify));
  napi_value argv[1] = { v };
  napi_status st = napi_call_function(env, json, stringify, 1, argv, &out);
  if (st != napi_ok) return "null";
  return str(env, out);
}

static void js_to_sqlite_result(napi_env env, sqlite3_context* ctx, napi_value v) {
  napi_valuetype t;
  NAPI_OK(env, napi_typeof(env, v, &t));
  if (t == napi_null || t == napi_undefined) { sqlite3_result_null(ctx); return; }
  if (t == napi_boolean) { bool b; NAPI_OK(env, napi_get_value_bool(env, v, &b)); sqlite3_result_int(ctx, b ? 1 : 0); return; }
  if (t == napi_number) { double d; NAPI_OK(env, napi_get_value_double(env, v, &d)); sqlite3_result_double(ctx, d); return; }
  if (t == napi_bigint) { int64_t x; bool lossless; NAPI_OK(env, napi_get_value_bigint_int64(env, v, &x, &lossless)); if (!lossless) { sqlite3_result_error(ctx, "BigInt outside int64 range", -1); return; } sqlite3_result_int64(ctx, static_cast<sqlite3_int64>(x)); return; }
  if (t == napi_string) { auto s = str(env, v); sqlite3_result_text(ctx, s.c_str(), (int)s.size(), SQLITE_TRANSIENT); return; }
  bool is_buf = false; NAPI_OK(env, napi_is_buffer(env, v, &is_buf));
  if (is_buf) { void* data; size_t len; NAPI_OK(env, napi_get_buffer_info(env, v, &data, &len)); sqlite3_result_blob(ctx, data, (int)len, SQLITE_TRANSIENT); return; }
  auto s = stringify_js(env, v);
  sqlite3_result_text(ctx, s.c_str(), (int)s.size(), SQLITE_TRANSIENT);
}

static napi_value rows_from_stmt(napi_env env, sqlite3_stmt* stmt) {
  napi_value rows; NAPI_OK(env, napi_create_array(env, &rows));
  uint32_t ri = 0;
  int cols = sqlite3_column_count(stmt);
  int rc;
  while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
    napi_value row; NAPI_OK(env, napi_create_object(env, &row));
    for (int i = 0; i < cols; ++i) {
      const char* name = sqlite3_column_name(stmt, i);
      NAPI_OK(env, napi_set_named_property(env, row, name, column_value(env, stmt, i)));
    }
    NAPI_OK(env, napi_set_element(env, rows, ri++, row));
  }
  if (rc != SQLITE_DONE) throw std::runtime_error(sqlite3_errmsg(sqlite3_db_handle(stmt)));
  return rows;
}

static bool cacheable_sql(const std::string& sql) {
  std::string upper;
  upper.reserve(sql.size());
  for (char c : sql) upper.push_back((char)std::toupper((unsigned char)c));
  return upper.find(";") == std::string::npos || upper.find(";") >= upper.size() - 1;
}

static void touch_lru(DbWrap* w, const std::string& sql) {
  auto it = std::find(w->lru.begin(), w->lru.end(), sql);
  if (it != w->lru.end()) w->lru.erase(it);
  w->lru.push_back(sql);
}

static sqlite3_stmt* get_cached_stmt(DbWrap* w, const std::string& sql, bool* cached) {
  *cached = false;
  if (w->cache_max == 0 || !cacheable_sql(sql)) return nullptr;
  auto it = w->cache.find(sql);
  if (it != w->cache.end()) {
    w->hits++;
    *cached = true;
    sqlite3_reset(it->second);
    sqlite3_clear_bindings(it->second);
    touch_lru(w, sql);
    return it->second;
  }
  w->misses++;
  sqlite3_stmt* stmt = nullptr;
  const char* tail = nullptr;
  int rc = sqlite3_prepare_v3(w->db, sql.c_str(), -1, SQLITE_PREPARE_PERSISTENT, &stmt, &tail);
  if (rc != SQLITE_OK || !stmt || !is_tail_empty(tail)) { if (stmt) sqlite3_finalize(stmt); return nullptr; }
  w->cache.emplace(sql, stmt);
  touch_lru(w, sql);
  while (w->cache.size() > w->cache_max && !w->lru.empty()) {
    auto victim = w->lru.front(); w->lru.pop_front();
    auto vit = w->cache.find(victim);
    if (vit != w->cache.end()) { sqlite3_finalize(vit->second); w->cache.erase(vit); w->evictions++; }
  }
  *cached = true;
  return stmt;
}

static napi_value result_object(napi_env env, sqlite3_int64 changes, sqlite3_int64 last_id) {
  napi_value o; NAPI_OK(env, napi_create_object(env, &o));
  NAPI_OK(env, napi_set_named_property(env, o, "changes", js_int64(env, changes)));
  NAPI_OK(env, napi_set_named_property(env, o, "lastInsertRowid", js_int64(env, last_id)));
  return o;
}

static napi_value DbNew(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value args[1]; napi_value self;
    NAPI_OK(env, napi_get_cb_info(env, info, &argc, args, &self, nullptr));
    if (argc < 1) { napi_throw_type_error(env, nullptr, "Database path required"); return nullptr; }
    auto path = str(env, args[0]);
    auto* w = new DbWrap();
    int rc = sqlite3_open_v2(path.c_str(), &w->db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr);
    if (rc != SQLITE_OK) { std::string msg = sqlite3_errmsg(w->db); if (w->db) sqlite3_close(w->db); delete w; napi_throw_error(env, nullptr, msg.c_str()); return nullptr; }
    sqlite3_extended_result_codes(w->db, 1);
    sqlite3_exec(w->db, "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;", nullptr, nullptr, nullptr);
    NAPI_OK(env, napi_wrap(env, self, w, finalize_db, nullptr, nullptr));
    return self;
  } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}

static napi_value Exec(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_value self;
    NAPI_OK(env, napi_get_cb_info(env, info, &argc, args, &self, nullptr));
    DbWrap* w = unwrap_db(env, self);
    auto sql = str(env, args[0]);
    sqlite3_int64 changed = 0;
    bool cached = false;
    sqlite3_stmt* cstmt = get_cached_stmt(w, sql, &cached);
    if (cstmt) {
      if (argc > 1) bind_params(env, cstmt, args[1]);
      int rc; while ((rc = sqlite3_step(cstmt)) == SQLITE_ROW) {}
      if (rc != SQLITE_DONE) { sqlite3_reset(cstmt); throw std::runtime_error(sqlite3_errmsg(w->db)); }
      changed = sqlite3_changes(w->db);
      sqlite3_reset(cstmt);
      return result_object(env, changed, sqlite3_last_insert_rowid(w->db));
    }
    sqlite3_stmt* stmt = nullptr;
    const char* tail = sql.c_str();
    while (*tail) {
      int rc = sqlite3_prepare_v2(w->db, tail, -1, &stmt, &tail);
      if (rc != SQLITE_OK) { throw_sql(env, w->db); return nullptr; }
      if (!stmt) continue;
      if (argc > 1) bind_params(env, stmt, args[1]);
      while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {}
      if (rc != SQLITE_DONE) { sqlite3_finalize(stmt); throw_sql(env, w->db); return nullptr; }
      changed += sqlite3_changes(w->db);
      sqlite3_finalize(stmt); stmt = nullptr;
    }
    return result_object(env, changed, sqlite3_last_insert_rowid(w->db));
  } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}

static napi_value Query(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; napi_value self;
    NAPI_OK(env, napi_get_cb_info(env, info, &argc, args, &self, nullptr));
    DbWrap* w = unwrap_db(env, self);
    auto sql = str(env, args[0]);
    bool cached = false;
    sqlite3_stmt* stmt = get_cached_stmt(w, sql, &cached);
    bool temp_stmt = false;
    if (!stmt) {
      int rc = sqlite3_prepare_v2(w->db, sql.c_str(), -1, &stmt, nullptr);
      if (rc != SQLITE_OK) { throw_sql(env, w->db); return nullptr; }
      temp_stmt = true;
    }
    if (argc > 1) bind_params(env, stmt, args[1]);
    napi_value rows = rows_from_stmt(env, stmt);
    sqlite3_reset(stmt);
    sqlite3_clear_bindings(stmt);
    if (temp_stmt) sqlite3_finalize(stmt);
    return rows;
  } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}

static napi_value Close(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 0; napi_value self;
    NAPI_OK(env, napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr));
    DbWrap* w = nullptr; NAPI_OK(env, napi_unwrap(env, self, reinterpret_cast<void**>(&w)));
    if (w && w->db && !w->closed) {
      clear_cache(w);
      for (auto* sw : std::vector<StmtWrap*>(w->live.begin(), w->live.end())) { if (sw) { if (sw->stmt) sqlite3_finalize(sw->stmt); sw->stmt = nullptr; sw->finalized = true; sw->owner = nullptr; } }
      w->live.clear();
      sqlite3_close(w->db); w->db = nullptr; w->closed = true;
    }
    return js_undefined(env);
  } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}

static napi_value SetStatementCacheSize(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value args[1]; napi_value self; NAPI_OK(env, napi_get_cb_info(env, info, &argc, args, &self, nullptr));
    DbWrap* w = unwrap_db(env, self);
    double n = 0; if (argc > 0) NAPI_OK(env, napi_get_value_double(env, args[0], &n));
    w->cache_max = n <= 0 ? 0 : static_cast<size_t>(n);
    while (w->cache.size() > w->cache_max && !w->lru.empty()) { auto victim = w->lru.front(); w->lru.pop_front(); auto it = w->cache.find(victim); if (it != w->cache.end()) { sqlite3_finalize(it->second); w->cache.erase(it); w->evictions++; } }
    return js_undefined(env);
  } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}

static napi_value ClearStatementCache(napi_env env, napi_callback_info info) {
  try { size_t argc=0; napi_value self; NAPI_OK(env, napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr)); DbWrap* w=unwrap_db(env,self); clear_cache(w); return js_undefined(env); }
  catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}

static napi_value StatementCacheStats(napi_env env, napi_callback_info info) {
  try {
    size_t argc=0; napi_value self; NAPI_OK(env, napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr)); DbWrap* w=unwrap_db(env,self);
    napi_value o; NAPI_OK(env, napi_create_object(env, &o));
    NAPI_OK(env, napi_set_named_property(env, o, "size", js_num(env, (double)w->cache.size())));
    NAPI_OK(env, napi_set_named_property(env, o, "max", js_num(env, (double)w->cache_max)));
    NAPI_OK(env, napi_set_named_property(env, o, "hits", js_num(env, (double)w->hits)));
    NAPI_OK(env, napi_set_named_property(env, o, "misses", js_num(env, (double)w->misses)));
    NAPI_OK(env, napi_set_named_property(env, o, "evictions", js_num(env, (double)w->evictions)));
    return o;
  } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}

static napi_value InTransaction(napi_env env, napi_callback_info info) {
  try { size_t argc=0; napi_value self; NAPI_OK(env, napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr)); DbWrap* w=unwrap_db(env,self); return js_bool(env, sqlite3_get_autocommit(w->db) == 0); }
  catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}

static napi_value SetBusyTimeout(napi_env env, napi_callback_info info) {
  try { size_t argc=1; napi_value args[1], self; NAPI_OK(env, napi_get_cb_info(env, info, &argc, args, &self, nullptr)); DbWrap* w=unwrap_db(env,self); double ms=0; if(argc) NAPI_OK(env,napi_get_value_double(env,args[0],&ms)); sqlite3_busy_timeout(w->db, (int)ms); return js_undefined(env); }
  catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}

static napi_value Checkpoint(napi_env env, napi_callback_info info) {
  try {
    size_t argc=1; napi_value args[1], self; NAPI_OK(env, napi_get_cb_info(env, info, &argc, args, &self, nullptr)); DbWrap* w=unwrap_db(env,self);
    std::string mode = argc ? str(env,args[0]) : "PASSIVE"; int m = SQLITE_CHECKPOINT_PASSIVE;
    if (mode == "FULL") m = SQLITE_CHECKPOINT_FULL; else if (mode == "RESTART") m = SQLITE_CHECKPOINT_RESTART; else if (mode == "TRUNCATE") m = SQLITE_CHECKPOINT_TRUNCATE;
    int log=0, ckpt=0; int rc = sqlite3_wal_checkpoint_v2(w->db, nullptr, m, &log, &ckpt); if (rc != SQLITE_OK) { throw_sql(env,w->db); return nullptr; }
    napi_value o; NAPI_OK(env,napi_create_object(env,&o)); NAPI_OK(env,napi_set_named_property(env,o,"log",js_num(env,log))); NAPI_OK(env,napi_set_named_property(env,o,"checkpointed",js_num(env,ckpt))); return o;
  } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}

static napi_value StmtNew(napi_env env, napi_callback_info info) {
  napi_value self; size_t argc=0; NAPI_OK(env, napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr));
  auto* s = new StmtWrap(); NAPI_OK(env, napi_wrap(env, self, s, [](napi_env, void* data, void*) { auto* sw = static_cast<StmtWrap*>(data); if (sw) { finalize_stmt_wrap(sw); delete sw; } }, nullptr, nullptr));
  return self;
}

static napi_value Prepare(napi_env env, napi_callback_info info) {
  try {
    size_t argc=1; napi_value args[1], self; NAPI_OK(env, napi_get_cb_info(env, info, &argc, args, &self, nullptr)); DbWrap* w=unwrap_db(env,self);
    auto sql = str(env,args[0]); sqlite3_stmt* stmt=nullptr; const char* tail=nullptr; int rc=sqlite3_prepare_v2(w->db, sql.c_str(), -1, &stmt, &tail); if(rc!=SQLITE_OK){throw_sql(env,w->db);return nullptr;} if(!stmt){napi_throw_error(env,nullptr,"No statement prepared"); return nullptr;}
    napi_value ctor; NAPI_OK(env, napi_get_reference_value(env, stmt_ctor, &ctor)); napi_value obj; NAPI_OK(env, napi_new_instance(env, ctor, 0, nullptr, &obj));
    StmtWrap* sw=nullptr; NAPI_OK(env,napi_unwrap(env,obj,reinterpret_cast<void**>(&sw))); sw->owner=w; sw->stmt=stmt; sw->sql=sql; sw->finalized=false; w->live.insert(sw); return obj;
  } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}

static napi_value StmtAll(napi_env env, napi_callback_info info) {
  try { size_t argc=1; napi_value args[1], self; NAPI_OK(env,napi_get_cb_info(env,info,&argc,args,&self,nullptr)); StmtWrap* sw=unwrap_stmt(env,self); sqlite3_reset(sw->stmt); sqlite3_clear_bindings(sw->stmt); if(argc) bind_params(env,sw->stmt,args[0]); napi_value rows=rows_from_stmt(env,sw->stmt); sqlite3_reset(sw->stmt); sqlite3_clear_bindings(sw->stmt); return rows; }
  catch (const std::exception& e) { napi_throw_error(env,nullptr,e.what()); return nullptr; }
}
static napi_value StmtGet(napi_env env, napi_callback_info info) {
  try { napi_value rows = StmtAll(env, info); bool is_arr=false; NAPI_OK(env,napi_is_array(env,rows,&is_arr)); uint32_t len=0; NAPI_OK(env,napi_get_array_length(env,rows,&len)); if(len==0) return js_null(env); napi_value first; NAPI_OK(env,napi_get_element(env,rows,0,&first)); return first; }
  catch (const std::exception& e) { napi_throw_error(env,nullptr,e.what()); return nullptr; }
}
static napi_value StmtRun(napi_env env, napi_callback_info info) {
  try { size_t argc=1; napi_value args[1], self; NAPI_OK(env,napi_get_cb_info(env,info,&argc,args,&self,nullptr)); StmtWrap* sw=unwrap_stmt(env,self); sqlite3_reset(sw->stmt); sqlite3_clear_bindings(sw->stmt); if(argc) bind_params(env,sw->stmt,args[0]); int rc; while((rc=sqlite3_step(sw->stmt))==SQLITE_ROW){} if(rc!=SQLITE_DONE){sqlite3_reset(sw->stmt); throw std::runtime_error(sqlite3_errmsg(sw->owner->db));} sqlite3_int64 ch=sqlite3_changes(sw->owner->db); sqlite3_reset(sw->stmt); sqlite3_clear_bindings(sw->stmt); return result_object(env,ch,sqlite3_last_insert_rowid(sw->owner->db)); }
  catch (const std::exception& e) { napi_throw_error(env,nullptr,e.what()); return nullptr; }
}
static napi_value StmtFinalize(napi_env env, napi_callback_info info) {
  try { size_t argc=0; napi_value self; NAPI_OK(env,napi_get_cb_info(env,info,&argc,nullptr,&self,nullptr)); StmtWrap* sw=nullptr; NAPI_OK(env,napi_unwrap(env,self,reinterpret_cast<void**>(&sw))); if(sw && !sw->finalized && sw->stmt){ finalize_stmt_wrap(sw); } return js_undefined(env); }
  catch (const std::exception& e) { napi_throw_error(env,nullptr,e.what()); return nullptr; }
}
static napi_value StmtReadonly(napi_env env, napi_callback_info info) {
  try { size_t argc=0; napi_value self; NAPI_OK(env,napi_get_cb_info(env,info,&argc,nullptr,&self,nullptr)); StmtWrap* sw=unwrap_stmt(env,self); return js_bool(env, sqlite3_stmt_readonly(sw->stmt)); }
  catch (const std::exception& e) { napi_throw_error(env,nullptr,e.what()); return nullptr; }
}
static napi_value StmtColumns(napi_env env, napi_callback_info info) {
  try { size_t argc=0; napi_value self; NAPI_OK(env,napi_get_cb_info(env,info,&argc,nullptr,&self,nullptr)); StmtWrap* sw=unwrap_stmt(env,self); int n=sqlite3_column_count(sw->stmt); napi_value arr; NAPI_OK(env,napi_create_array(env,&arr)); for(int i=0;i<n;i++) NAPI_OK(env,napi_set_element(env,arr,i,js_string(env,sqlite3_column_name(sw->stmt,i)))); return arr; }
  catch (const std::exception& e) { napi_throw_error(env,nullptr,e.what()); return nullptr; }
}

static void function_destroy(void* p) { auto* fw = static_cast<FunctionWrap*>(p); if (fw) { if (fw->fn) napi_delete_reference(fw->env, fw->fn); delete fw; } }
static void sql_function(sqlite3_context* ctx, int argc, sqlite3_value** argv) {
  auto* fw = static_cast<FunctionWrap*>(sqlite3_user_data(ctx));
  napi_env env = fw->env; napi_handle_scope scope; napi_open_handle_scope(env, &scope);
  napi_value cb, global; if (napi_get_reference_value(env, fw->fn, &cb) != napi_ok) { sqlite3_result_error(ctx, "UDF callback unavailable", -1); napi_close_handle_scope(env, scope); return; }
  napi_get_global(env, &global); std::vector<napi_value> jsargs(argc); for(int i=0;i<argc;i++) jsargs[i]=sqlite_value_to_js(env, argv[i]);
  napi_value result; napi_status st = napi_call_function(env, global, cb, argc, jsargs.data(), &result);
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (st != napi_ok || pending) { napi_value exc; napi_get_and_clear_last_exception(env, &exc); std::string msg = "UDF callback error"; try { napi_value m; if (napi_get_named_property(env, exc, "message", &m) == napi_ok) msg = str(env, m); } catch (...) {} sqlite3_result_error(ctx, msg.c_str(), -1); napi_close_handle_scope(env, scope); return; }
  try { js_to_sqlite_result(env, ctx, result); } catch (const std::exception& e) { sqlite3_result_error(ctx, e.what(), -1); }
  napi_close_handle_scope(env, scope);
}

static napi_value CreateFunction(napi_env env, napi_callback_info info) {
  try {
    size_t argc=3; napi_value args[3], self; NAPI_OK(env,napi_get_cb_info(env,info,&argc,args,&self,nullptr)); DbWrap* w=unwrap_db(env,self); if(argc<2) { napi_throw_type_error(env,nullptr,"createFunction(name, fn, options?)"); return nullptr; }
    auto name=str(env,args[0]); int arity=-1; int flags=SQLITE_UTF8;
    if(argc>=3) { napi_value v; bool has=false; if(napi_has_named_property(env,args[2],"arity",&has)==napi_ok && has){ NAPI_OK(env,napi_get_named_property(env,args[2],"arity",&v)); double d; NAPI_OK(env,napi_get_value_double(env,v,&d)); arity=(int)d; } if(napi_has_named_property(env,args[2],"deterministic",&has)==napi_ok && has){ NAPI_OK(env,napi_get_named_property(env,args[2],"deterministic",&v)); bool b=false; NAPI_OK(env,napi_get_value_bool(env,v,&b)); if(b) flags|=SQLITE_DETERMINISTIC; } if(napi_has_named_property(env,args[2],"directOnly",&has)==napi_ok && has){ NAPI_OK(env,napi_get_named_property(env,args[2],"directOnly",&v)); bool b=false; NAPI_OK(env,napi_get_value_bool(env,v,&b)); if(b) flags|=SQLITE_DIRECTONLY; } if(napi_has_named_property(env,args[2],"innocuous",&has)==napi_ok && has){ NAPI_OK(env,napi_get_named_property(env,args[2],"innocuous",&v)); bool b=false; NAPI_OK(env,napi_get_value_bool(env,v,&b)); if(b) flags|=SQLITE_INNOCUOUS; } }
    if (arity < -1) { napi_throw_range_error(env, nullptr, "UDF arity must be -1 or greater"); return nullptr; }
    auto* fw=new FunctionWrap(); fw->env=env; NAPI_OK(env,napi_create_reference(env,args[1],1,&fw->fn));
    int rc=sqlite3_create_function_v2(w->db,name.c_str(),arity,flags,fw,sql_function,nullptr,nullptr,function_destroy); if(rc!=SQLITE_OK){ throw_sql(env,w->db); return nullptr; } return js_undefined(env);
  } catch (const std::exception& e) { napi_throw_error(env,nullptr,e.what()); return nullptr; }
}
static napi_value DropFunction(napi_env env, napi_callback_info info) {
  try { size_t argc=2; napi_value args[2], self; NAPI_OK(env,napi_get_cb_info(env,info,&argc,args,&self,nullptr)); DbWrap* w=unwrap_db(env,self); auto name=str(env,args[0]); int arity=-1; if(argc>1){double d; NAPI_OK(env,napi_get_value_double(env,args[1],&d)); arity=(int)d;} sqlite3_create_function_v2(w->db,name.c_str(),arity,SQLITE_UTF8,nullptr,nullptr,nullptr,nullptr,nullptr); return js_undefined(env); }
  catch (const std::exception& e) { napi_throw_error(env,nullptr,e.what()); return nullptr; }
}

static void collation_destroy(void* p) { auto* cw = static_cast<CollationWrap*>(p); if (cw) { if (cw->fn) napi_delete_reference(cw->env, cw->fn); delete cw; } }
static int sql_collation(void* p, int la, const void* a, int lb, const void* b) {
  auto* cw = static_cast<CollationWrap*>(p); napi_env env=cw->env; napi_handle_scope scope; napi_open_handle_scope(env,&scope); napi_value cb, global, av, bv, out; int result=0;
  if(napi_get_reference_value(env,cw->fn,&cb)==napi_ok){ napi_get_global(env,&global); napi_create_string_utf8(env,(const char*)a,la,&av); napi_create_string_utf8(env,(const char*)b,lb,&bv); napi_value args[2]={av,bv}; if(napi_call_function(env,global,cb,2,args,&out)==napi_ok){ double d=0; if(napi_get_value_double(env,out,&d)==napi_ok) result = d<0 ? -1 : (d>0 ? 1 : 0); } }
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if(pending){ napi_value exc; napi_get_and_clear_last_exception(env,&exc); }
  napi_close_handle_scope(env,scope); return result;
}
static napi_value CreateCollation(napi_env env, napi_callback_info info) {
  try { size_t argc=2; napi_value args[2], self; NAPI_OK(env,napi_get_cb_info(env,info,&argc,args,&self,nullptr)); DbWrap* w=unwrap_db(env,self); auto name=str(env,args[0]); auto* cw=new CollationWrap(); cw->env=env; NAPI_OK(env,napi_create_reference(env,args[1],1,&cw->fn)); int rc=sqlite3_create_collation_v2(w->db,name.c_str(),SQLITE_UTF8,cw,sql_collation,collation_destroy); if(rc!=SQLITE_OK){collation_destroy(cw); throw_sql(env,w->db); return nullptr;} return js_undefined(env); }
  catch (const std::exception& e) { napi_throw_error(env,nullptr,e.what()); return nullptr; }
}
static napi_value DropCollation(napi_env env, napi_callback_info info) {
  try { size_t argc=1; napi_value args[1], self; NAPI_OK(env,napi_get_cb_info(env,info,&argc,args,&self,nullptr)); DbWrap* w=unwrap_db(env,self); auto name=str(env,args[0]); sqlite3_create_collation_v2(w->db,name.c_str(),SQLITE_UTF8,nullptr,nullptr,nullptr); return js_undefined(env); }
  catch (const std::exception& e) { napi_throw_error(env,nullptr,e.what()); return nullptr; }
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor db_props[] = {
    {"exec", nullptr, Exec, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"query", nullptr, Query, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"prepare", nullptr, Prepare, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setStatementCacheSize", nullptr, SetStatementCacheSize, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"clearStatementCache", nullptr, ClearStatementCache, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"statementCacheStats", nullptr, StatementCacheStats, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inTransaction", nullptr, InTransaction, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setBusyTimeout", nullptr, SetBusyTimeout, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"checkpoint", nullptr, Checkpoint, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createFunction", nullptr, CreateFunction, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"dropFunction", nullptr, DropFunction, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createCollation", nullptr, CreateCollation, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"dropCollation", nullptr, DropCollation, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_property_descriptor stmt_props[] = {
    {"all", nullptr, StmtAll, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"get", nullptr, StmtGet, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"run", nullptr, StmtRun, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"finalize", nullptr, StmtFinalize, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readonly", nullptr, StmtReadonly, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"columns", nullptr, StmtColumns, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_value dbclass; NAPI_OK(env, napi_define_class(env, "NativeDatabase", NAPI_AUTO_LENGTH, DbNew, nullptr, sizeof(db_props)/sizeof(db_props[0]), db_props, &dbclass));
  NAPI_OK(env, napi_create_reference(env, dbclass, 1, &db_ctor));
  NAPI_OK(env, napi_set_named_property(env, exports, "NativeDatabase", dbclass));
  napi_value stmtclass; NAPI_OK(env, napi_define_class(env, "NativeStatement", NAPI_AUTO_LENGTH, StmtNew, nullptr, sizeof(stmt_props)/sizeof(stmt_props[0]), stmt_props, &stmtclass));
  NAPI_OK(env, napi_create_reference(env, stmtclass, 1, &stmt_ctor));
  NAPI_OK(env, napi_set_named_property(env, exports, "NativeStatement", stmtclass));
  NAPI_OK(env, napi_set_named_property(env, exports, "sqliteVersion", js_string(env, sqlite3_libversion())));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
