import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleQuotaAutoPing } from "../../appwrite/functions/quota-autoping/index.js";

describe("Appwrite quota auto-ping Function", () => {
  const originalTarget = process.env.QUOTA_AUTOPING_TARGET_URL;
  const originalSecret = process.env.QUOTA_AUTOPING_SECRET;

  beforeEach(() => {
    process.env.QUOTA_AUTOPING_TARGET_URL = "https://sin-studio.tech/";
    process.env.QUOTA_AUTOPING_SECRET = "test-secret";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalTarget === undefined) delete process.env.QUOTA_AUTOPING_TARGET_URL;
    else process.env.QUOTA_AUTOPING_TARGET_URL = originalTarget;
    if (originalSecret === undefined) delete process.env.QUOTA_AUTOPING_SECRET;
    else process.env.QUOTA_AUTOPING_SECRET = originalSecret;
  });

  it("calls the protected Site endpoint and reports the sent count", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = { json: vi.fn((body, status = 200) => ({ body, status })) };

    const result = await handleQuotaAutoPing({
      req: {},
      res: response,
      log: vi.fn(),
      error: vi.fn(),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sin-studio.tech/api/internal/quota-autoping",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-quota-autoping-secret": "test-secret" }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), 200);
  });

  it("forwards an authorized Codex catch-up request to the Site", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      summary: { attempted: 1, sent: 1, failed: 0 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = { json: vi.fn((body, status = 200) => ({ body, status })) };

    const result = await handleQuotaAutoPing({
      req: { headers: { "x-quota-autoping-catch-up": "codex" } },
      res: response,
      log: vi.fn(),
      error: vi.fn(),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sin-studio.tech/api/internal/quota-autoping?catchUp=codex",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toMatchObject({ status: 200, body: { ok: true, sent: 1 } });
  });

  it("fails closed when Function variables are missing", async () => {
    delete process.env.QUOTA_AUTOPING_SECRET;
    const response = { json: vi.fn((body, status = 200) => ({ body, status })) };

    const result = await handleQuotaAutoPing({ req: {}, res: response, log: vi.fn(), error: vi.fn() });

    expect(result.status).toBe(500);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }), 500);
  });

  it("maps a Site failure to a Function failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("failed", { status: 500 })));
    const response = { json: vi.fn((body, status = 200) => ({ body, status })) };

    const result = await handleQuotaAutoPing({ req: {}, res: response, log: vi.fn(), error: vi.fn() });

    expect(result.status).toBe(502);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }), 502);
  });

  it("retries a failed Site trigger and accepts a later success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = { json: vi.fn((body, status = 200) => ({ body, status })) };

    const result = await handleQuotaAutoPing({ res: response, log: vi.fn(), error: vi.fn() });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 200 });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, attempts: 2 }), 200);
  });
});
