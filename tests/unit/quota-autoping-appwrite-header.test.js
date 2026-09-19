import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runQuotaAutoPingTick } = vi.hoisted(() => ({
  runQuotaAutoPingTick: vi.fn(),
}));

vi.mock("@/shared/services/quotaAutoPing", () => ({ runQuotaAutoPingTick }));

const { POST } = await import("@/app/api/internal/quota-autoping/route.js");
import { handleQuotaAutoPing } from "../../appwrite/functions/quota-autoping/index.js";

describe("Appwrite-safe quota auto-ping header", () => {
  const originalTarget = process.env.QUOTA_AUTOPING_TARGET_URL;
  const originalSecret = process.env.QUOTA_AUTOPING_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.QUOTA_AUTOPING_TARGET_URL = "https://api-9router.sin-studio.tech";
    process.env.QUOTA_AUTOPING_SECRET = "test-secret";
  });

  afterEach(() => {
    if (originalTarget === undefined) delete process.env.QUOTA_AUTOPING_TARGET_URL;
    else process.env.QUOTA_AUTOPING_TARGET_URL = originalTarget;
    if (originalSecret === undefined) delete process.env.QUOTA_AUTOPING_SECRET;
    else process.env.QUOTA_AUTOPING_SECRET = originalSecret;
  });

  it("allows the Site route to authenticate with the Appwrite-safe header", async () => {
    const response = await POST(new Request("http://localhost/api/internal/quota-autoping", {
      method: "POST",
      headers: { "x-quota-autoping-secret": "test-secret" },
    }));

    expect(response.status).toBe(200);
    expect(runQuotaAutoPingTick).toHaveBeenCalledOnce();
  });

  it("sends the Appwrite-safe header from the Function", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const response = { json: vi.fn((body, status = 200) => ({ body, status })) };

    await handleQuotaAutoPing({ res: response, log: vi.fn(), error: vi.fn() });

    expect(fetch).toHaveBeenCalledWith(
      "https://api-9router.sin-studio.tech/api/internal/quota-autoping",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-quota-autoping-secret": "test-secret" }),
      }),
    );
  });
});
