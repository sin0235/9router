import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const awsMock = vi.hoisted(() => ({
  send: vi.fn(),
  commands: [],
}));

const dbMock = vi.hoisted(() => ({
  exportDb: vi.fn(),
  importDb: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class HeadObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class GetObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class PutObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class S3Client {
    send(command, options) {
      awsMock.commands.push(command.constructor.name);
      return awsMock.send(command, options);
    }
  }
  return { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client };
});

vi.mock("@/lib/db/index.js", () => dbMock);

const originalEnv = { ...process.env };
const localPath = "/tmp/9router-test.sqlite";

function setR2Env(extra = {}) {
  process.env.R2_ACCOUNT_ID = "account";
  process.env.R2_ACCESS_KEY_ID = "access";
  process.env.R2_SECRET_ACCESS_KEY = "secret";
  process.env.R2_BUCKET = "bucket";
  process.env.R2_DB_KEY = "db.json";
  delete process.env.DB_ENCRYPTION_KEY;
  Object.assign(process.env, extra);
}

function streamJson(payload) {
  return Readable.from([Buffer.from(JSON.stringify(payload))]);
}

async function importFreshSync() {
  vi.resetModules();
  return import("@/lib/r2DbSync.js");
}

beforeEach(() => {
  process.env = { ...originalEnv };
  setR2Env();
  awsMock.send.mockReset();
  awsMock.commands.length = 0;
  dbMock.exportDb.mockReset();
  dbMock.importDb.mockReset();
  dbMock.exportDb.mockResolvedValue({ settings: { cloudEnabled: true } });
  dbMock.importDb.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("R2 DB sync", () => {
  it("giữ pending upload sau lỗi và retry khi remote object chưa tồn tại", async () => {
    const { uploadDbToR2, syncR2WithLocal } = await importFreshSync();

    awsMock.send
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce({ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } })
      .mockResolvedValueOnce({ ETag: "etag-1" });

    await expect(uploadDbToR2(localPath)).rejects.toThrow("network down");
    await syncR2WithLocal(localPath);

    expect(awsMock.commands).toEqual(["PutObjectCommand", "HeadObjectCommand", "PutObjectCommand"]);
    expect(dbMock.exportDb).toHaveBeenCalledTimes(2);
  });

  it("defer upload khi remote mới hơn, pull xong mới upload pending", async () => {
    const { uploadDbToR2, syncR2WithLocal } = await importFreshSync();

    awsMock.send
      .mockResolvedValueOnce({ ETag: "etag-1" })
      .mockResolvedValueOnce({ ETag: "etag-2" })
      .mockResolvedValueOnce({ ETag: "etag-2" })
      .mockResolvedValueOnce({ ETag: "etag-2", Body: streamJson({ settings: { cloudEnabled: true } }) })
      .mockResolvedValueOnce({ ETag: "etag-2" })
      .mockResolvedValueOnce({ ETag: "etag-3" });

    await uploadDbToR2(localPath);
    await uploadDbToR2(localPath);
    await syncR2WithLocal(localPath);

    expect(awsMock.commands).toEqual([
      "PutObjectCommand",
      "HeadObjectCommand",
      "HeadObjectCommand",
      "GetObjectCommand",
      "HeadObjectCommand",
      "PutObjectCommand",
    ]);
    expect(dbMock.importDb).toHaveBeenCalledWith(
      { settings: { cloudEnabled: true } },
      { source: "sync" }
    );
  });

  it("không mark ETag là đã sync khi thiếu DB_ENCRYPTION_KEY", async () => {
    const { syncR2WithLocal } = await importFreshSync();
    const encryptedPayload = {
      format: "9router-db-v1",
      iv: "AAAAAAAAAAAAAAAA",
      tag: "AAAAAAAAAAAAAAAAAAAAAA==",
      data: "AAAA",
    };

    awsMock.send
      .mockResolvedValueOnce({ ETag: "encrypted-1" })
      .mockResolvedValueOnce({ ETag: "encrypted-1", Body: streamJson(encryptedPayload) })
      .mockResolvedValueOnce({ ETag: "encrypted-1" })
      .mockResolvedValueOnce({ ETag: "encrypted-1", Body: streamJson(encryptedPayload) });

    await syncR2WithLocal(localPath);
    await syncR2WithLocal(localPath);

    expect(awsMock.commands).toEqual([
      "HeadObjectCommand",
      "GetObjectCommand",
      "HeadObjectCommand",
      "GetObjectCommand",
    ]);
    expect(dbMock.importDb).not.toHaveBeenCalled();
  });
});
