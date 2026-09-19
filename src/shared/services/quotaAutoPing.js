// Quota auto-ping scheduler: sends tiny requests on the configured schedule.
import "open-sse/index.js";

import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";
import { getExecutor } from "open-sse/executors/index.js";
import { CLAUDE_CLI_SPOOF_HEADERS } from "open-sse/providers/shared.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { QUOTA_AUTOPING_CONFIG } from "@/shared/constants/config";

const C = QUOTA_AUTOPING_CONFIG;
const CLAUDE_PING_URL = "https://api.anthropic.com/v1/messages?beta=true";

const providerHandlers = {
  claude: {
    getUsage: getClaudeUsage,
    sendPing: sendClaudePing,
  },
  codex: {
    getUsage: getCodexUsage,
    sendPing: sendCodexPing,
  },
};

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__quotaAutoPing ??= {
  interval: null,
  running: false,
  resetCache: {},
  scheduleCache: {},
  failureCache: {},
});

function cacheKey(provider, connectionId) {
  return `${provider}:${connectionId}`;
}

function normalizeResetKey(resetAt) {
  const ms = new Date(resetAt).getTime();
  if (!Number.isFinite(ms)) return resetAt;
  return new Date(Math.floor(ms / 60000) * 60000).toISOString();
}

function getScheduledSlot(providerConfig, nowMs = Date.now()) {
  if (!providerConfig.schedule) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: C.scheduleTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  if (!C.scheduleHours.includes(hour) || minute >= (C.scheduleWindowMinutes || 1)) return null;
  return `${values.year}-${values.month}-${values.day}T${values.hour}:00`;
}

function getResetDriftMs(previousResetAt, nextResetAt) {
  const previousMs = new Date(previousResetAt).getTime();
  const nextMs = new Date(nextResetAt).getTime();
  if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs)) return 0;
  return nextMs - previousMs;
}

function toFiniteNumber(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isQuotaExhausted(quota) {
  if (!quota || quota.unlimited === true) return false;
  const remaining = toFiniteNumber(quota.remaining);
  if (remaining !== null) return remaining <= 0;

  const used = toFiniteNumber(quota.used);
  const total = toFiniteNumber(quota.total);
  return total !== null && total > 0 && used !== null && used >= total;
}

function wasPingedRecently(connection, intervalMs, nowMs = Date.now()) {
  if (!intervalMs) return false;
  const lastPingAtMs = new Date(connection.lastPingAt).getTime();
  return Number.isFinite(lastPingAtMs) && nowMs - lastPingAtMs < intervalMs;
}

function isBlockingQuotaName(name, sessionKey) {
  if (name === sessionKey) return false;
  return !String(name).toLowerCase().includes("session");
}

function hasExhaustedBlockingQuota(quotas, sessionKey) {
  return Object.entries(quotas || {}).some(([name, quota]) => isBlockingQuotaName(name, sessionKey) && isQuotaExhausted(quota));
}

function shouldPingForReset(providerConfig, cachedReset, resetAt, now) {
  if (providerConfig.pingWhenResetAtSlides) {
    return Boolean(cachedReset) && getResetDriftMs(cachedReset, resetAt) >= (providerConfig.resetAtDriftMs || 0);
  }

  const resetMs = new Date(resetAt).getTime();
  return Number.isFinite(resetMs) && now >= resetMs - C.pingLeadMs;
}

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

async function sendClaudePing(connection, providerConfig, proxyOptions, deps) {
  const res = await deps.proxyAwareFetch(CLAUDE_PING_URL, {
    method: "POST",
    headers: {
      ...CLAUDE_CLI_SPOOF_HEADERS,
      "Authorization": `Bearer ${connection.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: providerConfig.pingModel,
      max_tokens: providerConfig.pingMaxTokens,
      messages: [{ role: "user", content: providerConfig.pingText }],
    }),
  }, proxyOptions);
  return res.ok;
}

function buildCodexPingInput(text) {
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  }];
}

async function drainResponseBody(response) {
  if (typeof response?.text === "function") {
    await response.text();
    return;
  }

  const reader = response?.body?.getReader?.();
  if (!reader) return;

  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock?.();
  }
}

async function sendCodexPing(connection, providerConfig, proxyOptions, deps) {
  const executor = deps.getExecutor("codex");
  const { response } = await executor.execute({
    model: providerConfig.pingModel,
    stream: true,
    credentials: {
      accessToken: connection.accessToken,
      connectionId: connection.id,
      providerSpecificData: connection.providerSpecificData,
    },
    proxyOptions,
    log: console,
    body: {
      model: providerConfig.pingModel,
      input: buildCodexPingInput(providerConfig.pingText),
      instructions: providerConfig.pingInstructions,
      reasoning: providerConfig.pingReasoningEffort
        ? { effort: providerConfig.pingReasoningEffort, summary: "auto" }
        : undefined,
      store: false,
      stream: true,
    },
  });
  if (!response.ok) {
    try { await response.body?.cancel?.(); } catch { /* noop */ }
    return false;
  }

  // Codex only starts the 5h window after the streaming response completes.
  await drainResponseBody(response);
  return true;
}

function shouldSkipAfterFailure(state, key, nowMs = Date.now()) {
  const failedAt = state.failureCache[key];
  return failedAt && nowMs - failedAt < C.failureCooldownMs;
}

async function pingConnection(conn, provider, providerConfig, handler, deps, state = g) {
  const key = cacheKey(provider, conn.id);

  const scheduledSlot = getScheduledSlot(providerConfig);
  if (providerConfig.schedule) {
    if (!scheduledSlot || conn.lastAutoPingSlot === scheduledSlot || state.scheduleCache?.[key] === scheduledSlot) return;
  } else {
    // resetAt is stable for time-based windows; Codex uses the fixed schedule above.
    const cachedReset = state.resetCache[key];
    if (cachedReset && Date.now() < new Date(cachedReset).getTime() - C.refreshAheadMs) return;
  }

  // Avoid hammering provider auth/quota endpoints if a ping failed recently.
  if (shouldSkipAfterFailure(state, key)) return;

  const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData);
  const proxyOptions = buildProxyOptions(proxyCfg);

  let connection = conn;
  try {
    const r = await deps.refreshAndUpdateCredentials(connection, false, proxyOptions);
    connection = r.connection;
  } catch (e) {
    state.failureCache[key] = Date.now();
    console.warn(`[AutoPing] ${provider}:${conn.id}: refresh failed: ${e.message}`);
    return;
  }

  const usage = await handler.getUsage(connection.accessToken, proxyOptions);
  const quotas = usage?.quotas || {};
  const quota = quotas?.[providerConfig.quotaKey];

  if (providerConfig.skipWhenBlockingQuotaExhausted && hasExhaustedBlockingQuota(quotas, providerConfig.quotaKey)) return;
  if (quota && isQuotaExhausted(quota)) return;

  const now = Date.now();
  let resetAt;
  let resetKey;
  if (!providerConfig.schedule) {
    const cachedReset = state.resetCache[key];
    resetAt = quota?.resetAt;
    if (!resetAt) return;
    state.resetCache[key] = resetAt;
    resetKey = normalizeResetKey(resetAt);
    const lastPingedResetKey = connection.lastPingedResetKey || normalizeResetKey(connection.lastPingedResetAt);
    if (!shouldPingForReset(providerConfig, cachedReset, resetAt, now)) return;
    if (lastPingedResetKey === resetKey) return;
  }
  if (wasPingedRecently(connection, providerConfig.minPingIntervalMs, now)) return;

  const ok = await handler.sendPing(connection, providerConfig, proxyOptions, deps);
  if (!ok) {
    // Do not mark reset as pinged unless upstream accepted the tiny request.
    state.failureCache[key] = Date.now();
    console.warn(`[AutoPing] ${provider}:${connection.id}: ping failed (reset ${resetAt})`);
    return;
  }

  delete state.failureCache[key];
  const pingState = {
    lastPingAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (scheduledSlot) pingState.lastAutoPingSlot = scheduledSlot;
  else {
    pingState.lastPingedResetAt = resetAt;
    pingState.lastPingedResetKey = resetKey;
  }
  await deps.updateProviderConnection(connection.id, pingState);
  if (scheduledSlot) state.scheduleCache[key] = scheduledSlot;
  console.log(`[AutoPing] ${provider}:${connection.id}: ping sent${scheduledSlot ? ` (${scheduledSlot})` : ` (reset ${resetAt})`}`);
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    proxyAwareFetch,
    getExecutor,
  };
}

export async function runQuotaAutoPingTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    const settings = await deps.getSettings();

    for (const [provider, providerConfig] of Object.entries(C.providers)) {
      const handler = providerHandlers[provider];
      if (!handler) continue;

      const providerSettings = settings?.[providerConfig.settingsKey] || {};
      if (provider === "codex" && providerSettings.enabled === false) continue;
      const enabledMap = providerSettings.connections || {};

      const conns = await deps.getProviderConnections({ provider, isActive: true });
      const targets = conns.filter((conn) => conn.authType === "oauth" && (
        provider === "codex" ? enabledMap[conn.id] !== false : enabledMap[conn.id] === true
      ));
      for (const conn of targets) {
        try {
          await pingConnection(conn, provider, providerConfig, handler, deps, state);
        } catch (e) {
          state.failureCache[cacheKey(provider, conn.id)] = Date.now();
          console.warn(`[AutoPing] ${provider}:${conn.id}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn("[AutoPing] tick error:", e.message);
  } finally {
    state.running = false;
  }
}

export function startQuotaAutoPing() {
  if (g.interval) return;
  console.log("[AutoPing] scheduler started");
  runQuotaAutoPingTick().catch(() => {});
  g.interval = setInterval(() => { runQuotaAutoPingTick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopQuotaAutoPing() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[AutoPing] scheduler stopped");
}

export function configureQuotaAutoPing(settings) {
  const enabled = settings?.codexAutoPing?.enabled !== false
    || Object.values(settings?.claudeAutoPing?.connections || {}).some(Boolean);
  if (enabled) startQuotaAutoPing();
  else stopQuotaAutoPing();
}
