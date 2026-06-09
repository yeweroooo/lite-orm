#include <node_api.h>
#include <sqlite3.h>
#include <string>
#include <vector>
#include <stdexcept>

#define NAPI_OK(env, call) do { napi_status _napi_status = (call); if (_napi_status != napi_ok) throw std::runtime_error("N-API call failed"); } while (0)

static napi_ref db_ctor;

struct DbWrap { sqlite3* db = nullptr; };

static std::string str(napi_env env, napi_value v) {
  size_t len = 0;
  NAPI_OK(env, napi_get_value_string_utf8(env, v, nullptr, 0, &len));
  std::string out(len, '\0');
  NAPI_OK(env, napi_get_value_string_utf8(env, v, out.data(), len + 1, &len));
  return out;
}

static napi_value js_string(napi_env env, const char* s) { napi_value v; NAPI_OK(env, napi_create_string_utf8(env, s ? s : "", NAPI_AUTO_LENGTH, &v)); return v; }
static napi_value js_string(napi_env env, const std::string& s) { napi_value v; NAPI_OK(env, napi_create_string_utf8(env, s.c_str(), s.size(), &v)); return v; }
static napi_value js_int64(napi_env env, sqlite3_int64 x) { napi_value v; NAPI_OK(env, napi_create_bigint_int64(env, x, &v)); return v; }
static napi_value js_num(napi_env env, double x) { napi_value v; NAPI_OK(env, napi_create_double(env, x, &v)); return v; }
static napi_value js_null(napi_env env) { napi_value v; NAPI_OK(env, napi_get_null(env, &v)); return v; }

static void throw_sql(napi_env env, sqlite3* db, const std::string& prefix = "SQLite error") {
  std::string msg = prefix + ": " + (db ? sqlite3_errmsg(db) : "unknown");
  napi_throw_error(env, nullptr, msg.c_str());
}

static DbWrap* unwrap(napi_env env, napi_value self) {
  DbWrap* w = nullptr;
  NAPI_OK(env, napi_unwrap(env, self, reinterpret_cast<void**>(&w)));
  if (!w || !w->db) throw std::runtime_error("Database is closed");
  return w;
}

static void finalize_db(napi_env env, void* data, void*) {
  auto* w = static_cast<DbWrap*>(data);
  if (w) { if (w->db) sqlite3_close(w->db); delete w; }
}

static void bind_value(napi_env env, sqlite3_stmt* stmt, int idx, napi_value v) {
  napi_valuetype t;
  NAPI_OK(env, napi_typeof(env, v, &t));
  if (t == napi_null || t == napi_undefined) { sqlite3_bind_null(stmt, idx); return; }
  if (t == napi_boolean) { bool b; NAPI_OK(env, napi_get_value_bool(env, v, &b)); sqlite3_bind_int(stmt, idx, b ? 1 : 0); return; }
  if (t == napi_number) { double d; NAPI_OK(env, napi_get_value_double(env, v, &d)); sqlite3_bind_double(stmt, idx, d); return; }
  if (t == napi_bigint) { int64_t x; bool lossless; NAPI_OK(env, napi_get_value_bigint_int64(env, v, &x, &lossless)); sqlite3_bind_int64(stmt, idx, static_cast<sqlite3_int64>(x)); return; }
  if (t == napi_string) { auto s = str(env, v); sqlite3_bind_text(stmt, idx, s.c_str(), (int)s.size(), SQLITE_TRANSIENT); return; }
  bool is_buf = false; NAPI_OK(env, napi_is_buffer(env, v, &is_buf));
  if (is_buf) { void* data; size_t len; NAPI_OK(env, napi_get_buffer_info(env, v, &data, &len)); sqlite3_bind_blob(stmt, idx, data, (int)len, SQLITE_TRANSIENT); return; }
  napi_throw_type_error(env, nullptr, "Unsupported SQLite parameter type");
}

static void bind_params(napi_env env, sqlite3_stmt* stmt, napi_value arr) {
  bool is_arr = false; NAPI_OK(env, napi_is_array(env, arr, &is_arr));
  if (!is_arr) return;
  uint32_t n = 0; NAPI_OK(env, napi_get_array_length(env, arr, &n));
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

static napi_value DbNew(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; napi_value self;
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, args, &self, nullptr));
  if (argc < 1) { napi_throw_type_error(env, nullptr, "Database path required"); return nullptr; }
  auto path = str(env, args[0]);
  auto* w = new DbWrap();
  int rc = sqlite3_open_v2(path.c_str(), &w->db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr);
  if (rc != SQLITE_OK) { std::string msg = sqlite3_errmsg(w->db); if (w->db) sqlite3_close(w->db); delete w; napi_throw_error(env, nullptr, msg.c_str()); return nullptr; }
  sqlite3_exec(w->db, "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;", nullptr, nullptr, nullptr);
  NAPI_OK(env, napi_wrap(env, self, w, finalize_db, nullptr, nullptr));
  return self;
}

static napi_value Exec(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2]; napi_value self;
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, args, &self, nullptr));
  DbWrap* w;
  try { w = unwrap(env, self); } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
  auto sql = str(env, args[0]);
  sqlite3_stmt* stmt = nullptr;
  const char* tail = sql.c_str();
  sqlite3_int64 changed = 0;
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
  napi_value o; NAPI_OK(env, napi_create_object(env, &o));
  napi_value c = js_int64(env, changed), id = js_int64(env, sqlite3_last_insert_rowid(w->db));
  NAPI_OK(env, napi_set_named_property(env, o, "changes", c));
  NAPI_OK(env, napi_set_named_property(env, o, "lastInsertRowid", id));
  return o;
}

static napi_value Query(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2]; napi_value self;
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, args, &self, nullptr));
  DbWrap* w;
  try { w = unwrap(env, self); } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
  auto sql = str(env, args[0]);
  sqlite3_stmt* stmt = nullptr;
  int rc = sqlite3_prepare_v2(w->db, sql.c_str(), -1, &stmt, nullptr);
  if (rc != SQLITE_OK) { throw_sql(env, w->db); return nullptr; }
  if (argc > 1) bind_params(env, stmt, args[1]);
  napi_value rows; NAPI_OK(env, napi_create_array(env, &rows));
  uint32_t ri = 0;
  int cols = sqlite3_column_count(stmt);
  while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
    napi_value row; NAPI_OK(env, napi_create_object(env, &row));
    for (int i = 0; i < cols; ++i) {
      const char* name = sqlite3_column_name(stmt, i);
      NAPI_OK(env, napi_set_named_property(env, row, name, column_value(env, stmt, i)));
    }
    NAPI_OK(env, napi_set_element(env, rows, ri++, row));
  }
  if (rc != SQLITE_DONE) { sqlite3_finalize(stmt); throw_sql(env, w->db); return nullptr; }
  sqlite3_finalize(stmt);
  return rows;
}

static napi_value Close(napi_env env, napi_callback_info info) {
  napi_value self; NAPI_OK(env, napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr));
  DbWrap* w = nullptr; NAPI_OK(env, napi_unwrap(env, self, reinterpret_cast<void**>(&w)));
  if (w && w->db) { sqlite3_close(w->db); w->db = nullptr; }
  napi_value undef; NAPI_OK(env, napi_get_undefined(env, &undef)); return undef;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"exec", nullptr, Exec, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"query", nullptr, Query, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_value ctor;
  NAPI_OK(env, napi_define_class(env, "NativeDatabase", NAPI_AUTO_LENGTH, DbNew, nullptr, 3, props, &ctor));
  NAPI_OK(env, napi_create_reference(env, ctor, 1, &db_ctor));
  NAPI_OK(env, napi_set_named_property(env, exports, "NativeDatabase", ctor));
  napi_value sqlite_ver = js_string(env, sqlite3_libversion());
  NAPI_OK(env, napi_set_named_property(env, exports, "sqliteVersion", sqlite_ver));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
