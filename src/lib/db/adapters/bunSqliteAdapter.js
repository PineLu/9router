// Bun runtime adapter — uses built-in bun:sqlite (native, fastest under Bun).
// Loaded only when process.versions.bun is present.
//
// Database runs in rollback-journal DELETE mode. Do not reintroduce WAL here;
// see schema.js. There is no WAL file to checkpoint.
import { PRAGMA_SQL } from "../schema.js";

export async function createBunSqliteAdapter(filePath) {
  // Dynamic import — only resolves under Bun runtime
  const { Database } = await import("bun:sqlite");
  const db = new Database(filePath, { create: true });
  db.exec(PRAGMA_SQL);

  const stmtCache = new Map();
  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  function gracefulClose() {
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }
  // Close only during the synchronous process "exit" phase. The application
  // owns SIGINT/SIGTERM and must finish any async request-detail flush before
  // the DB handle is closed. close() removes this listener when the adapter is
  // disposed manually (tests / reinitialization), so listeners do not stack.
  const onExit = () => gracefulClose();
  process.once("exit", onExit);

  return {
    driver: "bun:sqlite",
    run(sql, params = []) {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) {
      return prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return prepare(sql).all(...params);
    },
    exec(sql) { return db.exec(sql); },
    transaction(fn) {
      // bun:sqlite has db.transaction() API (similar to better-sqlite3)
      const tx = db.transaction(fn);
      return tx();
    },
    close() {
      process.off("exit", onExit);
      gracefulClose();
    },
    raw: db,
  };
}
