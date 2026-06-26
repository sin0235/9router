import { ensureDirs, DATA_FILE, LEGACY_FILES } from "./paths.js";
import { initR2Db, uploadDbToR2, syncR2WithLocal } from "@/lib/r2DbSync.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false, syncInterval: null };
const state = global._dbAdapter;

const R2_SYNC_INTERVAL_MS = 30000; // Pull from R2 every 30 seconds

function queueUploadDbToR2() {
  void uploadDbToR2(DATA_FILE).catch((error) => {
    console.warn(`[R2 DB] Queued upload failed: ${error.message}`);
  });
}

async function tryBunSqlite() {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function tryBetterSqlite() {
  // Skip on Bun — better-sqlite3 native bindings unsupported
  if (process.versions.bun) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function tryNodeSqlite() {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
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

  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js
  //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js
  let adapter = await tryBunSqlite();
  if (!adapter) adapter = await tryBetterSqlite();
  if (!adapter) adapter = await tryNodeSqlite();
  if (!adapter) adapter = await trySqlJs();
  if (!adapter) throw new Error("[DB] No SQLite driver available (bun/better/node/sql.js all failed)");

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  adapter.checkpoint?.();

  const syncedAdapter = withR2Sync(adapter);
  state.instance = syncedAdapter;
  
  // 1. Initial Pull: Ensure we have the latest from cloud before we push any local changes (like migrations)
  await syncR2WithLocal(DATA_FILE);

  // 2. Initial Push: Upload current state
  queueUploadDbToR2();

  // Setup periodic R2 sync (pull newer data from cloud)
  if (!state.syncInterval) {
    state.syncInterval = setInterval(() => {
      void syncR2WithLocal(DATA_FILE).catch((error) => {
        console.warn(`[R2 DB] Periodic sync failed: ${error.message}`);
      });
    }, R2_SYNC_INTERVAL_MS);
  }

  return syncedAdapter;
}

function withR2Sync(adapter) {
  function sync() {
    try {
      adapter.checkpoint?.();
    } catch (error) {
      console.warn(`[DB] SQLite checkpoint failed: ${error.message}`);
    }
    queueUploadDbToR2();
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

export function closeAdapterForTests() {
  if (state.syncInterval) {
    clearInterval(state.syncInterval);
    state.syncInterval = null;
  }
  state.instance?.close?.();
  state.instance = null;
  state.initPromise = null;
  state.logged = false;
}
