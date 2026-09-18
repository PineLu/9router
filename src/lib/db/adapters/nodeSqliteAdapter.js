// Built-in node:sqlite adapter — available in Node >= 22.5.0.
// No native build, no npm install. API mirrors betterSqliteAdapter.
//
// Database runs in rollback-journal DELETE mode. Do not reintroduce WAL here;
// see schema.js. There is no WAL file to checkpoint.
import { PRAGMA_SQL } from "../schema.js";

export async function createNodeSqliteAdapter(filePath) {
  // Suppress "ExperimentalWarning: SQLite is an experimental feature" from node:sqlite.
  // Stable enough for production use as of Node 22.x (RC quality).
  const origEmit = process.emit;
  process.emit = function (name, data, ...rest) {
    if (name === "warning" && data?.name === "ExperimentalWarning" && /SQLite/i.test(data.message || "")) {
      return false;
    }
    return origEmit.call(process, name, data, ...rest);
  };

  // Dynamic import — fails on Node < 22.5 → driver.js falls back to sql.js
  const sqlite = await import("node:sqlite");
  const Database = sqlite.DatabaseSync;
  const db = new Database(filePath);

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
    driver: "node:sqlite",
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
      // node:sqlite has no transaction wrapper. Use SAVEPOINT for nested support.
      const sp = `sp_${Math.random().toString(36).slice(2)}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const r = fn();
        db.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
        throw e;
      }
    },
    close() {
      process.off("exit", onExit);
      gracefulClose();
    },
    raw: db,
  };
}
