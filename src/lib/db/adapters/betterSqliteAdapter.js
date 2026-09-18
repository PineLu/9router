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

  // Close only during the synchronous process "exit" phase. The application
  // owns SIGINT/SIGTERM and must finish any async request-detail flush before
  // the DB handle is closed. close() removes this listener when the adapter is
  // disposed manually (tests / reinitialization), so listeners do not stack.
  const onExit = () => gracefulClose();
  process.once("exit", onExit);

  return {
    driver: "better-sqlite3",
    run(sql, params = []) { return prepare(sql).run(...params); },
    get(sql, params = []) { return prepare(sql).get(...params); },
    all(sql, params = []) { return prepare(sql).all(...params); },
    exec(sql) { return db.exec(sql); },
    transaction(fn) { return db.transaction(fn)(); },
    close() {
      process.off("exit", onExit);
      gracefulClose();
    },
    raw: db,
  };
}
