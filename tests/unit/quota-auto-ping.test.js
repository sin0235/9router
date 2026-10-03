import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("@/shared/constants/config", () => ({
  QUOTA_AUTOPING_CONFIG: {
    tickIntervalMs: 60000,
    pingLeadMs: 5000,
    refreshAheadMs: 300000,
    failureCooldownMs: 900000,
    retryAttempts: 2,
    retryDelayMs: 0,
    scheduleTimezone: "Asia/Ho_Chi_Minh",
    scheduleHours: [6, 11, 16, 21],
    accountTimeoutMs: 25000,
    providers: {
      claude: {
        settingsKey: "claudeAutoPing",
        quotaKey: "session (5h)",
        pingModel: "claude-haiku-4-5-20251001",
        pingText: "hi",
        pingMaxTokens: 1,
      },
      codex: {
        settingsKey: "codexAutoPing",
        quotaKey: "session",
        pingModel: "gpt-6-luna",
        pingText: "hi",
        pingInstructions: "Reply with OK.",
        pingReasoningEffort: "low",
        schedule: true,
        sessionWindowMs: 5 * 60 * 60 * 1000,
        minPingIntervalMs: 240000,
        failureCooldownMs: 240000,
        skipWhenBlockingQuotaExhausted: true,
      },
    },
  },
}));

vi.mock("open-sse/providers/shared.js", () => ({
  CLAUDE_CLI_SPOOF_HEADERS: { "anthropic-version": "2023-06-01" },
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/services/usage/claude.js", () => ({
  getClaudeUsage: vi.fn(),
}));

vi.mock("open-sse/services/usage/codex.js", () => ({
  getCodexUsage: vi.fn(),
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(),
}));

describe("quota auto-ping", () => {
  let runQuotaAutoPingTick;
  let configureQuotaAutoPing;
  let deps;
  let state;
  let getCodexUsage;
  let getClaudeUsage;
  let activated;

  const codexUsage = (active = false) => ({
    plan: "Plus", quotas: { session: { used: active ? 1 : 0, total: 100, remaining: active ? 99 : 100,
      resetAt: new Date(Date.now() + (active ? 5 * 3600000 : -60000)).toISOString() } },
  });
  const completedResponse = () => ({ response: new Response('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n') });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete global.__quotaAutoPing;

    ({ getCodexUsage } = await import("open-sse/services/usage/codex.js"));
    ({ getClaudeUsage } = await import("open-sse/services/usage/claude.js"));
    ({ runQuotaAutoPingTick, configureQuotaAutoPing } = await import("../../src/shared/services/quotaAutoPing.js"));

    activated = new Set();
    getCodexUsage.mockImplementation(async (token) => codexUsage(activated.has(token)));

    deps = {
      getSettings: vi.fn(),
      getProviderConnections: vi.fn(),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      proxyAwareFetch: vi.fn().mockResolvedValue({ ok: true }),
      getExecutor: vi.fn(() => ({
        execute: vi.fn(async ({ credentials }) => { activated.add(credentials.accessToken); return completedResponse(); }),
      })),
    };
    state = { running: false, resetCache: {}, scheduleCache: {}, failureCache: {} };
  });

  it.each([6, 11, 16, 21])("pings every Codex OAuth connection at %sh local time", async (hour) => {
    const utcHour = (hour + 24 - 7) % 24;
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, utcHour, 2)));
    deps.getSettings.mockResolvedValue({});
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [
          { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token-1" },
          { id: "codex-2", provider: "codex", authType: "oauth", accessToken: "token-2" },
          { id: "codex-api", provider: "codex", authType: "apikey", accessToken: "token-3" },
        ]
        : []
    ));

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).toHaveBeenCalledTimes(2);
    expect(deps.getExecutor.mock.results[0].value.execute).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-6-luna",
      body: expect.objectContaining({
        model: "gpt-6-luna",
        reasoning: { effort: "low", summary: "auto" },
      }),
    }));
    expect(deps.updateProviderConnection).toHaveBeenCalledTimes(4);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastAutoPingSlot: expect.stringContaining("T"),
    }));
  });

  it("skips Codex accounts that are not Plus", async () => {
    vi.setSystemTime(new Date("2026-01-01T23:02:00.000Z"));
    deps.getSettings.mockResolvedValue({});
    deps.getProviderConnections.mockResolvedValue([
      { id: "codex-free", provider: "codex", authType: "oauth", accessToken: "token" },
    ]);
    getCodexUsage.mockResolvedValue({ plan: "Free", quotas: { session: { remaining: 99, total: 100 } } });

    const summary = await runQuotaAutoPingTick(deps, state);

    expect(summary).toMatchObject({ attempted: 1, sent: 0, skipped: 1, failed: 0 });
    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("retries usage and ping failures before succeeding", async () => {
    vi.setSystemTime(new Date("2026-01-01T23:02:00.000Z"));
    deps.getSettings.mockResolvedValue({});
    deps.getProviderConnections.mockResolvedValue([
      { id: "codex-plus", provider: "codex", authType: "oauth", accessToken: "token" },
    ]);
    getCodexUsage
      .mockResolvedValueOnce({ message: "token expired" })
      .mockResolvedValueOnce(codexUsage());
    const execute = vi.fn()
      .mockResolvedValueOnce({ response: { ok: false, body: { cancel: vi.fn() } } })
      .mockImplementationOnce(async ({ credentials }) => { activated.add(credentials.accessToken); return completedResponse(); });
    deps.getExecutor.mockReturnValue({ execute });

    const summary = await runQuotaAutoPingTick(deps, state);

    expect(getCodexUsage).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ attempted: 1, sent: 1, failed: 0, retries: 2 });
  });

  it("does not ping when usage stays unavailable", async () => {
    vi.setSystemTime(new Date("2026-01-01T23:02:00.000Z"));
    deps.getSettings.mockResolvedValue({});
    deps.getProviderConnections.mockResolvedValue([
      { id: "codex-plus", provider: "codex", authType: "oauth", accessToken: "token" },
    ]);
    getCodexUsage.mockResolvedValue({ message: "Codex usage temporarily unavailable" });

    const summary = await runQuotaAutoPingTick(deps, state);

    expect(summary).toMatchObject({ attempted: 1, sent: 0, failed: 1 });
    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it("does not repeat a connection inside the same scheduled slot", async () => {
    vi.setSystemTime(new Date("2026-01-01T23:02:00.000Z"));
    deps.getSettings.mockResolvedValue({});
    deps.getProviderConnections.mockResolvedValue([
      { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" },
    ]);

    await runQuotaAutoPingTick(deps, state);
    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledTimes(3);
  });

  it("catches up the latest Codex slot after its five-minute window", async () => {
    vi.setSystemTime(new Date("2026-01-02T05:16:00.000Z")); // 12:16 in Vietnam, after the 11:00 slot
    deps.getSettings.mockResolvedValue({});
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }]
        : []
    ));

    const first = await runQuotaAutoPingTick(deps, state, { codexCatchUp: true });
    const second = await runQuotaAutoPingTick(deps, state, { codexCatchUp: true });

    expect(first).toMatchObject({ attempted: 1, sent: 1, failed: 0 });
    expect(second).toMatchObject({ attempted: 1, sent: 0, skipped: 1 });
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastAutoPingSlot: "2026-01-02T11:00",
    }));
    expect(deps.getExecutor).toHaveBeenCalledOnce();
    expect(getClaudeUsage).not.toHaveBeenCalled();
  });

  it("allows an explicit false setting to disable one Codex connection", async () => {
    vi.setSystemTime(new Date("2026-01-01T23:02:00.000Z"));
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": false } } });
    deps.getProviderConnections.mockResolvedValue([
      { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" },
    ]);

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it("starts Codex auto-ping by default and stops only when globally disabled", () => {
    vi.useFakeTimers();

    configureQuotaAutoPing({});
    expect(vi.getTimerCount()).toBe(1);

    configureQuotaAutoPing({ codexAutoPing: { enabled: false } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps Claude reset-based behavior", async () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    deps.getSettings.mockResolvedValue({ claudeAutoPing: { connections: { "claude-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "claude" ? [{ id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token" }] : []
    ));
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { resetAt: "2026-01-01T11:59:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(deps.proxyAwareFetch.mock.calls[0][1].body)).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  function onePlusConnection(extra = {}) {
    const conn = { id: "plus", provider: "codex", authType: "oauth", accessToken: "token", ...extra };
    deps.getSettings.mockResolvedValue({});
    deps.getProviderConnections.mockImplementation(async ({ provider }) => provider === "codex" ? [conn] : []);
    deps.updateProviderConnection.mockImplementation(async (_, patch) => Object.assign(conn, patch));
    return conn;
  }

  it.each([6, 11, 16, 21])("verifies and retries full quota at %s:05 despite the old completed marker", async (hour) => {
    const utcHour = (hour + 24 - 7) % 24;
    const started = Date.UTC(2026, 0, 1, utcHour);
    vi.setSystemTime(started);
    const conn = onePlusConnection();
    getCodexUsage.mockImplementation(async () => codexUsage());

    const first = await runQuotaAutoPingTick(deps, state);
    expect(first).toMatchObject({ sent: 1, verified: 0, pending: 1 });
    expect(conn.lastAutoPingSlot).toBeUndefined();

    // A marker written by the old implementation must not suppress verification/recovery.
    conn.lastAutoPingSlot = `${hour === 6 ? "2026-01-02" : "2026-01-01"}T${String(hour).padStart(2, "0")}:00`;
    vi.setSystemTime(started + 5 * 60000);
    getCodexUsage.mockImplementation(async (token) => codexUsage(activated.has(token)));
    activated.clear();
    const recovery = await runQuotaAutoPingTick(deps, state);
    expect(recovery).toMatchObject({ sent: 1, verified: 1, pending: 0 });
    expect(deps.getExecutor).toHaveBeenCalledTimes(2);
  });

  it.each([11, 16, 21])("waits for the previous window to expire and activates the %sh slot", async (hour) => {
    const start = Date.UTC(2026, 0, 1, hour - 7, 0);
    vi.setSystemTime(start);
    onePlusConnection();
    const oldUsage = { plan: "Plus", quotas: { session: {
      used: 1, remaining: 99, resetAt: new Date(start + 60000).toISOString(),
    } } };
    getCodexUsage.mockResolvedValue(oldUsage);
    expect(await runQuotaAutoPingTick(deps, state)).toMatchObject({ sent: 0, verified: 0, pending: 1 });
    expect(deps.getExecutor).not.toHaveBeenCalled();

    vi.setSystemTime(start + 5 * 60000);
    getCodexUsage.mockImplementation(async (token) => activated.has(token) ? codexUsage(true) : oldUsage);
    expect(await runQuotaAutoPingTick(deps, state)).toMatchObject({ sent: 1, verified: 1, pending: 0 });
  });

  it("does not mistake HTTP 200 with an SSE error for a completed ping", async () => {
    vi.setSystemTime(new Date("2026-01-01T04:00:00Z"));
    const conn = onePlusConnection();
    deps.getExecutor.mockReturnValue({ execute: vi.fn(async () => ({
      response: new Response('data: {"type":"response.failed","response":{"status":"failed","error":{"message":"quota denied"}}}\n\n'),
    })) });
    const summary = await runQuotaAutoPingTick(deps, state);
    expect(summary).toMatchObject({ sent: 0, verified: 0, failed: 1 });
    expect(summary.accounts[0].reason).toBe("quota denied");
    expect(conn.lastAutoPingSlot).toBeUndefined();
  });

  it("does not accept an empty or truncated stream", async () => {
    vi.setSystemTime(new Date("2026-01-01T04:00:00Z"));
    onePlusConnection();
    deps.getExecutor.mockReturnValue({ execute: vi.fn(async () => ({ response: new Response('data: {"type":"response.created"}\n\n') })) });
    expect(await runQuotaAutoPingTick(deps, state)).toMatchObject({ sent: 0, failed: 1 });
  });

  it("ignores exhausted review/Spark quotas and supplies the account identity for usage", async () => {
    vi.setSystemTime(new Date("2026-01-01T04:00:00Z"));
    const conn = onePlusConnection({ providerSpecificData: { accountId: "account-plus" } });
    getCodexUsage.mockImplementation(async (token) => ({ ...codexUsage(activated.has(token)), quotas: {
      ...codexUsage(activated.has(token)).quotas,
      review_weekly: { remaining: 0 }, spark_weekly: { remaining: 0 },
    } }));
    expect(await runQuotaAutoPingTick(deps, state)).toMatchObject({ sent: 1, verified: 1 });
    expect(getCodexUsage).toHaveBeenCalledWith("token", expect.objectContaining({ strictProxy: false }), conn.providerSpecificData, expect.any(AbortSignal));
  });

  it("processes other Plus accounts while one account hangs and retries failures after five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T04:00:00Z"));
    onePlusConnection();
    deps.getProviderConnections.mockImplementation(async ({ provider }) => provider === "codex" ? [
      { id: "hung", authType: "oauth", accessToken: "hung" },
      { id: "healthy", authType: "oauth", accessToken: "healthy" },
    ] : []);
    getCodexUsage.mockImplementation(async (token) => token === "hung" ? new Promise(() => {}) : codexUsage(activated.has(token)));
    const tick = runQuotaAutoPingTick(deps, state);
    await vi.advanceTimersByTimeAsync(25000);
    expect(await tick).toMatchObject({ attempted: 2, sent: 1, verified: 1, failed: 1 });
    expect(deps.getExecutor).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300000);
    getCodexUsage.mockImplementation(async (token) => codexUsage(activated.has(token)));
    expect(await runQuotaAutoPingTick(deps, state)).toMatchObject({ attempted: 2, sent: 1, verified: 2, failed: 0 });
    vi.useRealTimers();
  });

  it("leaves Appwrite cron in control instead of starting an SSR background timer", () => {
    vi.useFakeTimers();
    vi.stubEnv("QUOTA_AUTOPING_EXTERNAL_SCHEDULER", "true");
    configureQuotaAutoPing({});
    expect(vi.getTimerCount()).toBe(0);
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("does not mark a slot verified when its weekly quota blocks activation", async () => {
    vi.setSystemTime(new Date("2026-01-01T04:00:00Z"));
    const conn = onePlusConnection();
    getCodexUsage.mockResolvedValue({ ...codexUsage(), quotas: {
      ...codexUsage().quotas, weekly: { used: 100, remaining: 0, resetAt: "2026-01-03T04:00:00Z" },
    } });
    const summary = await runQuotaAutoPingTick(deps, state);
    expect(summary).toMatchObject({ sent: 0, verified: 0, pending: 1 });
    expect(summary.accounts[0].reason).toBe("weekly-exhausted");
    expect(conn.lastAutoPingSlot).toBeUndefined();
  });

  it.each([6, 11, 16, 21])("confirms a fixed reset at %s:05 when a tiny request still rounds to full quota", async (hour) => {
    const start = Date.UTC(2026, 0, 1, (hour + 24 - 7) % 24);
    vi.setSystemTime(start);
    const conn = onePlusConnection();
    const resetAt = new Date(start + 5 * 3600000).toISOString();
    getCodexUsage.mockResolvedValue({ plan: "Plus", quotas: { session: { used: 0, remaining: 100, resetAt } } });
    expect(await runQuotaAutoPingTick(deps, state)).toMatchObject({ sent: 1, verified: 0, pending: 1 });
    expect(conn.lastAutoPingSlot).toBeUndefined();

    vi.setSystemTime(start + 5 * 60000);
    const checked = await runQuotaAutoPingTick(deps, state);
    expect(checked).toMatchObject({ sent: 0, verified: 1, pending: 0 });
    expect(checked.accounts[0].reason).toBe("window-reset-fixed");
    expect(deps.getExecutor).toHaveBeenCalledOnce();
    expect(conn.lastAutoPingSlot).toBeTruthy();
  });

  it("retries an idle full window whose reset deadline keeps sliding", async () => {
    const start = Date.parse("2026-01-01T04:00:00Z");
    vi.setSystemTime(start);
    const conn = onePlusConnection();
    getCodexUsage.mockImplementation(async () => ({ plan: "Plus", quotas: { session: {
      used: 0, remaining: 100, resetAt: new Date(Date.now() + 5 * 3600000).toISOString(),
    } } }));
    expect(await runQuotaAutoPingTick(deps, state)).toMatchObject({ sent: 1, verified: 0, pending: 1 });
    vi.setSystemTime(start + 5 * 60000);
    expect(await runQuotaAutoPingTick(deps, state)).toMatchObject({ sent: 1, verified: 0, pending: 1 });
    expect(conn.lastAutoPingSlot).toBeUndefined();
    expect(deps.getExecutor).toHaveBeenCalledTimes(2);
  });

  it("continues the 11h recovery after an exhausted account resets at 14:18", async () => {
    vi.setSystemTime(new Date("2026-01-01T04:00:00Z"));
    onePlusConnection();
    const resetAt = "2026-01-01T07:18:00Z";
    getCodexUsage.mockResolvedValue({ plan: "Plus", quotas: { session: { used: 100, remaining: 0, resetAt } } });
    expect(await runQuotaAutoPingTick(deps, state)).toMatchObject({ sent: 0, pending: 1 });
    vi.setSystemTime(new Date("2026-01-01T07:20:00Z"));
    getCodexUsage.mockImplementation(async (token) => activated.has(token) ? codexUsage(true) : {
      plan: "Plus", quotas: { session: { used: 100, remaining: 0, resetAt } },
    });
    const recovered = await runQuotaAutoPingTick(deps, state);
    expect(recovered).toMatchObject({ sent: 1, verified: 1, pending: 0 });
    expect(recovered.accounts[0].slot).toBe("2026-01-01T11:00");
  });

  it("recovers the previous day's 21h slot after midnight and stops calls after confirmation", async () => {
    vi.setSystemTime(new Date("2026-01-01T17:25:00Z")); // 00:25 on Jan 2 in Vietnam
    const conn = onePlusConnection();
    const first = await runQuotaAutoPingTick(deps, state);
    expect(first).toMatchObject({ sent: 1, verified: 1 });
    expect(conn.lastAutoPingSlot).toBe("2026-01-01T21:00");
    expect(conn.lastAutoPingVerifiedAt).toBeTruthy();
    getCodexUsage.mockClear();
    deps.getExecutor.mockClear();
    const second = await runQuotaAutoPingTick(deps, state);
    expect(second).toMatchObject({ sent: 0, verified: 1, pending: 0 });
    expect(getCodexUsage).not.toHaveBeenCalled();
    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it("waits for the old fixed window even when its usage rounds to zero", async () => {
    vi.setSystemTime(new Date("2026-01-02T04:00:00Z"));
    onePlusConnection({ lastPingAt: "2026-01-01T23:01:00Z" });
    getCodexUsage.mockResolvedValue({ plan: "Plus", quotas: { session: {
      used: 0, remaining: 100, resetAt: "2026-01-02T04:01:00Z",
    } } });
    const summary = await runQuotaAutoPingTick(deps, state);
    expect(summary).toMatchObject({ sent: 0, verified: 0, pending: 1 });
    expect(summary.accounts[0].reason).toBe("waiting-for-session-reset");
    expect(deps.getExecutor).not.toHaveBeenCalled();
  });
});
