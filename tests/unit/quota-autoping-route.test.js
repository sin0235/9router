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
});
