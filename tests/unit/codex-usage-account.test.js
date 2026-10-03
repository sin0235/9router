import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";

describe("Codex usage account identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ plan_type: "plus", rate_limit: {
      primary_window: { used_percent: 1, reset_at: 1800000000 },
    } })));
  });

  it("uses the same workspace precedence as the Codex executor and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    const usage = await getCodexUsage("token", null, { workspaceId: "workspace", accountId: "personal" }, signal);
    expect(proxyAwareFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      signal, headers: expect.objectContaining({ "ChatGPT-Account-ID": "workspace" }),
    }), null);
    expect(usage).toMatchObject({ plan: "plus", quotas: { session: { used: 1, remaining: 99 } } });
  });

  it("preserves calls without account metadata", async () => {
    await getCodexUsage("token");
    expect(proxyAwareFetch.mock.calls[0][1].headers).not.toHaveProperty("ChatGPT-Account-ID");
  });
});
