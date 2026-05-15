import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

const SETTINGS_UPDATED_AT_KEY = "__settingsUpdatedAt";

const AUTH_CRITICAL_SETTINGS = new Set([
  "requireLogin",
  "tunnelDashboardAccess",
  "authMode",
  "passwordHash",
  "passwordSalt",
  "oidcIssuerUrl",
  "oidcClientId",
  "oidcClientSecret",
  "oidcScopes",
  "oidcLoginLabel",
]);

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  requireLogin: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  enableObservability: true,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  cavemanEnabled: false,
  cavemanLevel: "full",
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

function stripInternalSettings(raw) {
  const { [SETTINGS_UPDATED_AT_KEY]: _settingsUpdatedAt, ...settings } = raw || {};
  return settings;
}

function getUpdatedAt(raw) {
  const value = raw?.[SETTINGS_UPDATED_AT_KEY];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isNewerOrEqual(incoming, current) {
  if (!incoming) return false;
  if (!current) return true;
  return incoming >= current;
}

// Merge raw settings with defaults; backward-compat for missing keys
function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...stripInternalSettings(raw) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    const updatedAt = { ...getUpdatedAt(current) };
    const now = new Date().toISOString();
    for (const key of Object.keys(updates || {})) {
      if (key !== SETTINGS_UPDATED_AT_KEY) updatedAt[key] = now;
    }
    next = { ...current, ...updates, [SETTINGS_UPDATED_AT_KEY]: updatedAt };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)]
    );
  });
  return mergeWithDefaults(next);
}

export async function importSettings(importedSettings) {
  if (!importedSettings || typeof importedSettings !== "object" || Array.isArray(importedSettings)) {
    return await getSettings();
  }

  const db = await getAdapter();
  let next;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    const incoming = { ...importedSettings };
    const currentUpdatedAt = getUpdatedAt(current);
    const incomingUpdatedAt = getUpdatedAt(incoming);
    const nextUpdatedAt = { ...currentUpdatedAt };

    delete incoming[SETTINGS_UPDATED_AT_KEY];
    next = { ...current };

    for (const [key, value] of Object.entries(incoming)) {
      if (AUTH_CRITICAL_SETTINGS.has(key)) {
        const importedAt = incomingUpdatedAt[key];
        if (!isNewerOrEqual(importedAt, currentUpdatedAt[key])) continue;
        nextUpdatedAt[key] = importedAt;
      } else if (incomingUpdatedAt[key]) {
        nextUpdatedAt[key] = incomingUpdatedAt[key];
      }
      next[key] = value;
    }

    next[SETTINGS_UPDATED_AT_KEY] = nextUpdatedAt;
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)]
    );
  });

  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
