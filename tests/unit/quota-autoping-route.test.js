import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runQuotaAutoPingTick } = vi.hoisted(() => ({
  runQuotaAutoPingTick: vi.fn(),
}));

vi.mock("@/shared/services/quotaAutoPing", () => ({ runQuotaAutoPingTick }));

const { POST } = await import("@/app/api/internal/quota-autoping/route.js");

describe("quota auto-ping trigger route", () => {
  const originalSecret = process.env.QUOTA_AUTOPING_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.QUOTA_AUTOPING_SECRET = "test-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.QUOTA_AUTOPING_SECRET;
    else process.env.QUOTA_AUTOPING_SECRET = originalSecret;
  });

  it("rejects a request with an invalid secret", async () => {
    const response = await POST(new Request("http://localhost/api/internal/quota-autoping", {
      method: "POST",
      headers: { authorization: "Bearer wrong-secret" },
    }));

    expect(response.status).toBe(401);
    expect(runQuotaAutoPingTick).not.toHaveBeenCalled();
  });

  it("runs the existing auto-ping tick for a valid Function request", async () => {
    const response = await POST(new Request("http://localhost/api/internal/quota-autoping", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(runQuotaAutoPingTick).toHaveBeenCalledOnce();
  });

  it("runs a requested Codex catch-up tick and reports when nothing was sent", async () => {
    runQuotaAutoPingTick.mockResolvedValueOnce({ attempted: 1, sent: 0, skipped: 1, failed: 0 });

    const response = await POST(new Request("http://localhost/api/internal/quota-autoping?catchUp=codex", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, summary: { sent: 0 } });
    expect(runQuotaAutoPingTick).toHaveBeenCalledWith(undefined, undefined, { codexCatchUp: true });
  });

  it("fails closed when the shared secret is not configured", async () => {
    delete process.env.QUOTA_AUTOPING_SECRET;

    const response = await POST(new Request("http://localhost/api/internal/quota-autoping", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }));

    expect(response.status).toBe(503);
    expect(runQuotaAutoPingTick).not.toHaveBeenCalled();
  });

  it("returns an error when the tick fails", async () => {
    runQuotaAutoPingTick.mockRejectedValueOnce(new Error("provider unavailable"));

    const response = await POST(new Request("http://localhost/api/internal/quota-autoping", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("returns an error when an account fails inside the tick", async () => {
    runQuotaAutoPingTick.mockResolvedValueOnce({ attempted: 1, sent: 0, skipped: 0, failed: 1, retries: 1 });

    const response = await POST(new Request("http://localhost/api/internal/quota-autoping", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, summary: { failed: 1 } });
  });

  it("does not acknowledge a trigger when another tick is already running", async () => {
    runQuotaAutoPingTick.mockResolvedValueOnce({ attempted: 0, sent: 0, skipped: 0, failed: 0, retries: 0, busy: true });

    const response = await POST(new Request("http://localhost/api/internal/quota-autoping", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, summary: { busy: true } });
  });
});
