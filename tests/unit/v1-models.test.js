import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;
const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-v1-models-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  global.fetch = vi.fn(async (url) => {
    if (String(url) === "https://opencode.ai/zen/v1/models") {
      return Response.json({
        data: [
          { id: "model-a-free" },
          { id: "model-b-free" },
          { id: "model-c" },
        ],
      });
    }
    return Response.json({ data: [] });
  });
});

afterEach(async () => {
  const { closeAdapterForTests } = await import("@/lib/db/driver.js");
  closeAdapterForTests();
  global.fetch = originalFetch;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("/api/v1/models", () => {
  it("includes OpenCode models fetched from its public models API", async () => {
    const { buildModelsList } = await import("@/app/api/v1/models/route.js");

    const models = await buildModelsList(["llm"]);
    const ids = models.map((model) => model.id);

    expect(ids).toContain("oc/model-a-free");
    expect(ids).toContain("oc/model-b-free");
    expect(ids).not.toContain("oc/model-c");
  });
});
