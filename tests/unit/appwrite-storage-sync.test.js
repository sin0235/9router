import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const dbMock = vi.hoisted(() => ({
  exportDb: vi.fn(),
  importDb: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => dbMock);

const originalEnv = { ...process.env };

function setAppwriteEnv(extra = {}) {
  process.env.APPWRITE_DB_SYNC_ENABLED = "true";
  process.env.APPWRITE_ENDPOINT = "https://sgp.cloud.appwrite.io/v1";
  process.env.APPWRITE_PROJECT_ID = "9router";
  process.env.APPWRITE_API_KEY = "server-key";
  process.env.APPWRITE_STORAGE_BUCKET_ID = "database_9router";
  process.env.APPWRITE_DB_FILE_PREFIX = "9router-db-";
  process.env.APPWRITE_DB_ENCRYPTION_KEY = "appwrite-only-key";
  delete process.env.R2_DB_SYNC_ENABLED;
  Object.assign(process.env, extra);
}

async function importFreshSync() {
  vi.resetModules();
  return import("@/lib/appwriteStorageSync.js");
}

function encryptedPayload(payload) {
  const key = crypto.createHash("sha256").update("appwrite-only-key").digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return JSON.stringify({
    format: "9router-appwrite-db-v1",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  });
}

beforeEach(() => {
  process.env = { ...originalEnv };
  setAppwriteEnv();
  dbMock.exportDb.mockReset();
  dbMock.importDb.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("Appwrite Storage DB sync", () => {
  it("chỉ bật bằng cấu hình Appwrite đầy đủ, không phụ thuộc R2", async () => {
    const { isAppwriteStorageEnabled } = await importFreshSync();

    expect(isAppwriteStorageEnabled("/tmp/data.sqlite")).toBe(true);
    delete process.env.APPWRITE_API_KEY;
    expect(isAppwriteStorageEnabled("/tmp/data.sqlite")).toBe(false);
  });

  it("tạo file mới bằng payload DB mã hóa trong Appwrite Storage", async () => {
    dbMock.exportDb.mockResolvedValue({ settings: { cloudEnabled: true } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        $id: "9router-db-1234567890abcdef12345678",
        $updatedAt: "2026-09-19T00:00:00.000+00:00",
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const { uploadDbToAppwrite } = await importFreshSync();
    await uploadDbToAppwrite("/tmp/data.sqlite");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://sgp.cloud.appwrite.io/v1/storage/buckets/database_9router/files");
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      "X-Appwrite-Project": "9router",
      "X-Appwrite-Key": "server-key",
    });
    const form = fetchMock.mock.calls[1][1].body;
    expect(form.get("fileId")).toMatch(/^9router-db-[a-z0-9]{24}$/);
    expect(await form.get("file").text()).not.toContain("cloudEnabled");
  });

  it("kéo file mới và import vào DB cục bộ", async () => {
    const remotePayload = encryptedPayload({
      settings: { cloudEnabled: false },
      providerConnections: [],
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [{
          $id: "9router-db-1234567890abcdef12345678",
          $updatedAt: "2026-09-19T00:00:00.000+00:00",
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(remotePayload, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { syncAppwriteWithLocal } = await importFreshSync();
    await syncAppwriteWithLocal("/tmp/data.sqlite");

    expect(dbMock.importDb).toHaveBeenCalledWith(
      { settings: { cloudEnabled: false }, providerConnections: [] },
      { source: "sync" }
    );
  });
});
