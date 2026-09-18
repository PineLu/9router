import Database from "better-sqlite3";
import { PRAGMA_SQL } from "../schema.js";

// Database runs in rollback-journal DELETE mode. Do not reintroduce WAL here;
// see schema.js. There is no WAL file to checkpoint.
export function createBetterSqliteAdapter(filePath) {
  const db = new Database(filePath);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

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

  // Close the handle on shutdown, but do NOT exit the process: the app owns the
  // shutdown sequence (requestDetailsRepo flushes pending rows on SIGINT/SIGTERM
  // and exits itself). Calling process.exit() here would kill the process before
  // that async flush could finish.
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);
  process.once("SIGINT", onShutdown);
  process.once("SIGTERM", onShutdown);

  return {
    driver: "better-sqlite3",
    run(sql, params = []) { return prepare(sql).run(...params); },
    get(sql, params = []) { return prepare(sql).get(...params); },
    all(sql, params = []) { return prepare(sql).all(...params); },
    exec(sql) { return db.exec(sql); },
    transaction(fn) { return db.transaction(fn)(); },
    close() { gracefulClose(); },
    raw: db,
  };
}
