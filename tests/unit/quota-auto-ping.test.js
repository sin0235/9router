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
    scheduleWindowMinutes: 5,
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

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete global.__quotaAutoPing;

    ({ getCodexUsage } = await import("open-sse/services/usage/codex.js"));
    ({ getClaudeUsage } = await import("open-sse/services/usage/claude.js"));
    ({ runQuotaAutoPingTick, configureQuotaAutoPing } = await import("../../src/shared/services/quotaAutoPing.js"));

    deps = {
      getSettings: vi.fn(),
      getProviderConnections: vi.fn(),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      proxyAwareFetch: vi.fn().mockResolvedValue({ ok: true }),
      getExecutor: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue({ response: { ok: true, text: vi.fn().mockResolvedValue("") } }),
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
    getCodexUsage.mockResolvedValue({ plan: "Plus", quotas: { session: { used: 1, total: 100, remaining: 99 } } });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).toHaveBeenCalledTimes(2);
    expect(deps.getExecutor.mock.results[0].value.execute).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-6-luna",
      body: expect.objectContaining({
        model: "gpt-6-luna",
        reasoning: { effort: "low", summary: "auto" },
      }),
    }));
    expect(deps.updateProviderConnection).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce({ plan: "Plus", quotas: { session: { remaining: 99, total: 100 } } });
    const execute = vi.fn()
      .mockResolvedValueOnce({ response: { ok: false, body: { cancel: vi.fn() } } })
      .mockResolvedValueOnce({ response: { ok: true, text: vi.fn().mockResolvedValue("") } });
    deps.getExecutor.mockReturnValue({ execute });

    const summary = await runQuotaAutoPingTick(deps, state);

    expect(getCodexUsage).toHaveBeenCalledTimes(2);
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
    getCodexUsage.mockResolvedValue({ plan: "Plus", quotas: { session: { remaining: 99, total: 100 } } });

    await runQuotaAutoPingTick(deps, state);
    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledTimes(1);
  });

  it("catches up the latest Codex slot after its five-minute window", async () => {
    vi.setSystemTime(new Date("2026-01-02T05:16:00.000Z")); // 12:16 in Vietnam, after the 11:00 slot
    deps.getSettings.mockResolvedValue({});
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }]
        : []
    ));
    getCodexUsage.mockResolvedValue({ plan: "Plus", quotas: { session: { used: 1, total: 100, remaining: 99 } } });

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
});
