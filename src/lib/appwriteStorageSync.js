import crypto from "node:crypto";
import fs from "node:fs/promises";

const DEFAULT_FILE_PREFIX = "9router-db-";
const FORMAT = "9router-appwrite-db-v1";
const RETRY_COOLDOWN_MS = 30000;

const state = {
  remoteUpdatedAt: null,
  remoteFileId: null,
  isPulling: false,
  isImporting: false,
  pendingUpload: false,
  uploadGeneration: 0,
  uploadPath: null,
  uploadScheduled: false,
  nextUploadRetryAt: 0,
};

let syncQueue = Promise.resolve();
let lastQueueError = null;

function getConfig() {
  return {
    endpoint: process.env.APPWRITE_ENDPOINT?.replace(/\/$/, ""),
    projectId: process.env.APPWRITE_PROJECT_ID,
    apiKey: process.env.APPWRITE_API_KEY,
    bucketId: process.env.APPWRITE_STORAGE_BUCKET_ID,
    filePrefix: process.env.APPWRITE_DB_FILE_PREFIX || DEFAULT_FILE_PREFIX,
    encryptionKey: process.env.APPWRITE_DB_ENCRYPTION_KEY,
  };
}

export function isAppwriteStorageEnabled() {
  if (process.env.NEXT_PHASE === "phase-production-build") return false;
  const { endpoint, projectId, apiKey, bucketId, filePrefix, encryptionKey } = getConfig();
  return process.env.APPWRITE_DB_SYNC_ENABLED === "true"
    && Boolean(endpoint && projectId && apiKey && bucketId && filePrefix && encryptionKey);
}

function getHeaders() {
  const { projectId, apiKey } = getConfig();
  return {
    "X-Appwrite-Project": projectId,
    "X-Appwrite-Key": apiKey,
  };
}

function filesUrl() {
  const { endpoint, bucketId } = getConfig();
  return `${endpoint}/storage/buckets/${encodeURIComponent(bucketId)}/files`;
}

function fileUrl(fileId, suffix = "") {
  return `${filesUrl()}/${encodeURIComponent(fileId)}${suffix}`;
}

async function getLatestFileMetadata() {
  const { filePrefix } = getConfig();
  const query = new URLSearchParams({
    limit: "100",
    "sortDesc[]": "$updatedAt",
  });
  const response = await fetch(`${filesUrl()}?${query}`, { headers: getHeaders() });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Appwrite file list request failed: ${response.status}`);
  const files = (await response.json()).files || [];
  return files
    .filter((file) => file.$id?.startsWith(filePrefix))
    .sort((a, b) => String(b.$updatedAt || b.$createdAt).localeCompare(String(a.$updatedAt || a.$createdAt)))[0] || null;
}

async function downloadFile(fileId) {
  const response = await fetch(fileUrl(fileId, "/download"), { headers: getHeaders() });
  if (!response.ok) throw new Error(`Appwrite download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function getEncryptionKey() {
  const rawKey = getConfig().encryptionKey;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(rawKey)) {
    const decoded = Buffer.from(rawKey, "base64");
    if (decoded.length === 32) return decoded;
  }
  if (/^[a-fA-F0-9]{64}$/.test(rawKey)) return Buffer.from(rawKey, "hex");
  return crypto.createHash("sha256").update(rawKey).digest();
}

function encryptDb(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.from(JSON.stringify({
    format: FORMAT,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  }));
}

function decryptDb(buffer) {
  const payload = JSON.parse(buffer.toString("utf8"));
  if (payload?.format !== FORMAT) throw new Error("Unsupported Appwrite DB payload");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);
}

function parsePayload(buffer) {
  const payload = JSON.parse(buffer.toString("utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid Appwrite DB payload");
  }
  if (!payload.settings && !payload.providerConnections && !payload.modelAliases) {
    throw new Error("Empty Appwrite DB payload");
  }
  return payload;
}

async function readLocalPayload(localPath) {
  if (localPath?.endsWith(".sqlite")) {
    const { exportDb } = await import("@/lib/db/index.js");
    return Buffer.from(JSON.stringify(await exportDb()));
  }
  return fs.readFile(localPath);
}

async function pullFile(localPath, fileId) {
  const payload = parsePayload(decryptDb(await downloadFile(fileId)));
  if (localPath?.endsWith(".sqlite")) {
    const { importDb } = await import("@/lib/db/index.js");
    state.isImporting = true;
    try {
      await importDb(payload, { source: "sync" });
    } finally {
      state.isImporting = false;
    }
  }
  return payload;
}

async function uploadFile(localPath, generation = state.uploadGeneration) {
  const metadata = await getLatestFileMetadata();
  if (metadata && (
    !state.remoteFileId
    || !state.remoteUpdatedAt
    || metadata.$id !== state.remoteFileId
    || metadata.$updatedAt !== state.remoteUpdatedAt
  )) {
    console.warn(`[Appwrite DB] Upload deferred: remote file changed (${metadata.$updatedAt})`);
    state.pendingUpload = true;
    return false;
  }

  const form = new FormData();
  const { filePrefix } = getConfig();
  const fileId = `${filePrefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  form.append("file", new Blob([encryptDb(await readLocalPayload(localPath))], { type: "application/json" }), "db.json");

  form.append("fileId", fileId);
  const response = await fetch(filesUrl(), {
    method: "POST",
    headers: getHeaders(),
    body: form,
  });
  if (!response.ok) throw new Error(`Appwrite upload failed: ${response.status}`);

  const result = await response.json();
  state.remoteUpdatedAt = result.$updatedAt || new Date().toISOString();
  state.remoteFileId = result.$id || fileId;
  if (generation === state.uploadGeneration) state.pendingUpload = false;
  state.nextUploadRetryAt = 0;
  lastQueueError = null;
  if (metadata && metadata.$id !== state.remoteFileId) {
    const cleanup = await fetch(fileUrl(metadata.$id), { method: "DELETE", headers: getHeaders() });
    if (!cleanup.ok) console.warn(`[Appwrite DB] Old file cleanup failed: ${cleanup.status}`);
  }
  console.log(`[Appwrite DB] Uploaded ${state.remoteFileId}`);
  return true;
}

function queueError(error) {
  const message = error?.message || String(error);
  if (message !== lastQueueError) {
    console.warn(`[Appwrite DB] Previous sync task failed: ${message}`);
    lastQueueError = message;
  }
}

export async function uploadDbToAppwrite(localPath) {
  if (!isAppwriteStorageEnabled()) return;
  if (state.isImporting) return;
  state.pendingUpload = true;
  state.uploadGeneration += 1;
  state.uploadPath = localPath;
  if (state.uploadScheduled) return syncQueue;
  state.uploadScheduled = true;
  syncQueue = syncQueue.catch(queueError).then(async () => {
    while (state.pendingUpload && !state.isPulling) {
      if (Date.now() < state.nextUploadRetryAt) return;
      try {
        const uploaded = await uploadFile(state.uploadPath, state.uploadGeneration);
        if (!uploaded) return;
      } catch (error) {
        state.nextUploadRetryAt = Date.now() + RETRY_COOLDOWN_MS;
        throw error;
      }
    }
  }).finally(() => {
    state.uploadScheduled = false;
  });
  return syncQueue;
}

export async function syncAppwriteWithLocal(localPath) {
  if (!isAppwriteStorageEnabled()) return;
  syncQueue = syncQueue.catch(queueError).then(async () => {
    if (state.isPulling) return;
    state.isPulling = true;
    try {
      const metadata = await getLatestFileMetadata();
      if (!metadata) {
        state.remoteUpdatedAt = null;
        state.remoteFileId = null;
        if (state.pendingUpload) await uploadFile(localPath, state.uploadGeneration);
        return;
      }
      const remoteChanged = metadata.$id !== state.remoteFileId
        || metadata.$updatedAt !== state.remoteUpdatedAt;
      if (remoteChanged) {
        await pullFile(localPath, metadata.$id);
        state.remoteUpdatedAt = metadata.$updatedAt || null;
        state.remoteFileId = metadata.$id;
        state.pendingUpload = false;
        return;
      }
      if (state.pendingUpload) await uploadFile(localPath, state.uploadGeneration);
    } finally {
      state.isPulling = false;
    }
  });
  return syncQueue;
}
