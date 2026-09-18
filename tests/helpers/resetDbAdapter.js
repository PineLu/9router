// Test-only helper: tear down the process-wide SQLite adapter cache.
//
// src/lib/db/driver.js keeps its singleton on `global._dbAdapter` so it can
// survive Next.js dev hot-reload. `vi.resetModules()` only clears the module
// registry — it does NOT touch that global, so a test that points DATA_DIR at a
// temporary directory and then deletes it would leave the old adapter open:
//
//   adapter still open → temp DATA_DIR removed → next test re-imports modules
//   → global._dbAdapter still hands back the stale instance → the DELETE
//   journal mode tries to create `data.sqlite-journal` under the now-missing
//   parent directory → SqliteError: attempt to write a readonly database.
//
// journal_mode=DELETE is a deliberate production setting (it avoids the WAL
// corruption seen on macOS + podman virtiofs), so tests must adapt instead of
// reverting it. Call this BEFORE removing the temporary DATA_DIR.
export function resetDbAdapterForTests() {
  const state = global._dbAdapter;
  if (!state) return;

  try {
    state.instance?.close?.();
  } catch {
    // teardown should be best-effort
  }

  state.instance = null;
  state.initPromise = null;
  state.logged = false;

  // A still-pending initPromise captured the previous state object, so its
  // `.then` would write a stale adapter back into that object. Swap in a fresh
  // object so a late resolve can never repopulate the cache with an adapter
  // bound to the deleted DATA_DIR.
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
}
