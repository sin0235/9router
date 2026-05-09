import { ensureDirs, DATA_FILE, LEGACY_FILES } from "./paths.js";
import { initR2Db, uploadDbToR2 } from "@/lib/r2DbSync.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

async function tryBetterSqlite() {
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

async function initAdapter() {
  ensureDirs();
  await initR2Db(DATA_FILE);
  await initR2Db(LEGACY_FILES.main);

  let adapter = await tryBetterSqlite();
  if (!adapter) adapter = await trySqlJs();
  if (!adapter) throw new Error("[DB] No SQLite driver available (better-sqlite3 + sql.js both failed)");

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  adapter.checkpoint?.();
  await uploadDbToR2(DATA_FILE);
  return withR2Sync(adapter);
}

function withR2Sync(adapter) {
  function sync() {
    try { adapter.checkpoint?.(); } catch {}
    void uploadDbToR2(DATA_FILE);
  }

  return {
    ...adapter,
    run(sql, params = []) {
      const result = adapter.run(sql, params);
      sync();
      return result;
    },
    exec(sql) {
      const result = adapter.exec(sql);
      sync();
      return result;
    },
    transaction(fn) {
      const result = adapter.transaction(fn);
      sync();
      return result;
    },
  };
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) state.initPromise = initAdapter().then((a) => { state.instance = a; return a; });
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
