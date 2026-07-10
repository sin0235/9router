import { GetObjectCommand, PutObjectCommand, S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer.js";

initConsoleLogCapture();

const DEFAULT_DB_KEY = "db.json";
const ENCRYPTED_DB_PREFIX = "9router-db-v1";
const R2_RETRY_COOLDOWN_MS = 30000;
const SYNC_STATE = {
  lastRemoteETag: null,
  isPulling: false,
  pendingUpload: false,
  nextUploadRetryAt: 0,
};

let client = null;
const initPromises = new Map();
let syncQueue = Promise.resolve();
let lastQueueError = null;

function getErrorMessage(error) {
  return error?.message || error?.Code || error?.name || String(error);
}

function hasExplicitKey() {
  return Boolean(process.env.R2_DB_KEY || process.env.R2_OBJECT_KEY);
}

function defaultKeyForPath(_localPath) {
  return DEFAULT_DB_KEY;
}

function getConfig(localPath) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  const key = process.env.R2_DB_KEY || process.env.R2_OBJECT_KEY || defaultKeyForPath(localPath);
  const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

  return { accountId, accessKeyId, secretAccessKey, bucket, key, endpoint };
}

function isR2SyncModeEnabled() {
  return process.env.R2_DB_SYNC_ENABLED === "true";
}

export function isR2DbEnabled(localPath) {
  if (!isR2SyncModeEnabled()) return false;
  const { accountId, accessKeyId, secretAccessKey, bucket, key, endpoint } = getConfig(localPath);
  return Boolean(accountId && accessKeyId && secretAccessKey && bucket && key && endpoint);
}

function getClient() {
  if (!client) {
    const { accessKeyId, secretAccessKey, endpoint } = getConfig();
    client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isMissingObjectError(error) {
  return error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404;
}

function getEncryptionKey() {
  const rawKey = process.env.DB_ENCRYPTION_KEY;
  if (!rawKey) return null;

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(rawKey)) {
    const decoded = Buffer.from(rawKey, "base64");
    if (decoded.length === 32) return decoded;
  }

  if (/^[a-fA-F0-9]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, "hex");
  }

  return crypto.createHash("sha256").update(rawKey).digest();
}

function encryptDb(buffer) {
  const key = getEncryptionKey();
  if (!key) return buffer;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);

  return Buffer.from(JSON.stringify({
    format: ENCRYPTED_DB_PREFIX,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  }));
}

function decryptDb(buffer) {
  const text = buffer.toString("utf8");
  let payload;

  try {
    payload = JSON.parse(text);
  } catch (_) {
    return buffer;
  }

  if (payload?.format !== ENCRYPTED_DB_PREFIX) return buffer;

  const key = getEncryptionKey();
  if (!key) {
    throw new Error("DB_ENCRYPTION_KEY is required to decrypt R2 db");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);
}

function validateDownloadedDb(_localPath, body) {
  JSON.parse(body.toString("utf8"));
}

function getContentType() {
  return "application/json";
}

export function hasExplicitR2DbKey() {
  return hasExplicitKey();
}

export async function initR2Db(localPath) {
  if (!isR2DbEnabled(localPath)) return;
  const { bucket, key } = getConfig(localPath);
  const initKey = `${bucket}/${key}->${localPath}`;
  if (!initPromises.has(initKey)) initPromises.set(initKey, downloadDbFromR2(localPath));
  await initPromises.get(initKey);
}

async function downloadDbFromR2(localPath) {
  const { bucket, key } = getConfig(localPath);

  try {
    const response = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = decryptDb(await streamToBuffer(response.Body));
    validateDownloadedDb(localPath, body);

    if (localPath?.endsWith(".sqlite")) {
      // Write to legacy json path so migrate.js can find it if the DB is fresh.
      const jsonPath = localPath.replace(".sqlite", ".json").replace(path.join("db", "data"), "db");
      await fs.mkdir(path.dirname(jsonPath), { recursive: true });
      await fs.writeFile(jsonPath, body);
      // Track ETag so uploadDbFile can detect if remote changes before our next upload
      SYNC_STATE.lastRemoteETag = response.ETag;
      console.log(`[R2 DB] Downloaded ${bucket}/${key} to portable backup ${jsonPath}`);
      return;
    }

    SYNC_STATE.lastRemoteETag = response.ETag;
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, body);
    console.log(`[R2 DB] Downloaded ${bucket}/${key} to local backup json`);
  } catch (error) {
    if (isMissingObjectError(error)) {
      console.warn(`[R2 DB] Object ${bucket}/${key} not found; using local db`);
      return;
    }
    console.warn(`[R2 DB] Download failed for ${bucket}/${key}: ${getErrorMessage(error)}`);
  }
}

export async function uploadDbToR2(localPath) {
  if (!isR2DbEnabled(localPath)) return;

  syncQueue = syncQueue
    .catch((error) => {
      const message = getErrorMessage(error);
      if (message !== lastQueueError) {
        console.warn(`[R2 DB] Previous sync task failed: ${message}`);
        lastQueueError = message;
      }
    })
    .then(() => {
      if (SYNC_STATE.isPulling) {
        SYNC_STATE.pendingUpload = true;
        console.warn("[R2 DB] Upload deferred: pull in progress. Will upload after pull.");
        return;
      }
      if (SYNC_STATE.pendingUpload && Date.now() < SYNC_STATE.nextUploadRetryAt) return;
      return uploadDbFile(localPath);
    });

  return syncQueue;
}

async function uploadDbFile(localPath) {
  const { bucket, key } = getConfig(localPath);

  try {
    // Guard: if remote has newer data than we've seen, defer upload to avoid overwriting it.
    // The sync pull will happen on the next interval; pendingUpload ensures we re-upload afterward.
    if (SYNC_STATE.lastRemoteETag !== null) {
      const remoteHead = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key })).catch(e => {
        if (isMissingObjectError(e)) return null;
        throw e;
      });
      if (remoteHead?.ETag && remoteHead.ETag !== SYNC_STATE.lastRemoteETag) {
        SYNC_STATE.pendingUpload = true;
        console.warn(`[R2 DB] Upload deferred: remote has newer data (${remoteHead.ETag}). Will upload after pull.`);
        return;
      }
    }

    let payload;
    if (localPath?.endsWith(".sqlite")) {
      const { exportDb } = await import("@/lib/db/index.js");
      payload = Buffer.from(JSON.stringify(await exportDb()));
    } else {
      payload = await fs.readFile(localPath);
    }

    const body = encryptDb(payload);
    const response = await getClient().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: getContentType(),
      Metadata: getEncryptionKey() ? { encrypted: ENCRYPTED_DB_PREFIX } : undefined,
    }));

    SYNC_STATE.lastRemoteETag = response.ETag;
    SYNC_STATE.pendingUpload = false;
    SYNC_STATE.nextUploadRetryAt = 0;
    lastQueueError = null;
    console.log(`[R2 DB] Uploaded portable backup to ${bucket}/${key}`);
  } catch (error) {
    SYNC_STATE.pendingUpload = true;
    SYNC_STATE.nextUploadRetryAt = Date.now() + R2_RETRY_COOLDOWN_MS;
    console.warn(`[R2 DB] Upload failed for ${bucket}/${key}: ${getErrorMessage(error)}`);
    throw error;
  }
}

/**
 * Real-time sync: Pull updates from R2 if remote ETag has changed.
 */
export async function syncR2WithLocal(localPath) {
  if (!isR2DbEnabled(localPath)) return;

  syncQueue = syncQueue
    .catch((error) => {
      const message = getErrorMessage(error);
      if (message !== lastQueueError) {
        console.warn(`[R2 DB] Previous sync task failed: ${message}`);
        lastQueueError = message;
      }
    })
    .then(async () => {
      if (SYNC_STATE.isPulling) return;
      const { bucket, key } = getConfig(localPath);

      try {
        SYNC_STATE.isPulling = true;

        // 1. Check metadata for ETag change
        const head = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key })).catch(e => {
          if (isMissingObjectError(e)) return null;
          throw e;
        });

        if (!head) {
          if (SYNC_STATE.pendingUpload) await uploadDbFile(localPath);
          return;
        }

        if (head.ETag === SYNC_STATE.lastRemoteETag) {
          if (SYNC_STATE.pendingUpload) await uploadDbFile(localPath);
          return;
        }

        console.log(`[R2 DB] Remote change detected (${head.ETag}), pulling...`);

        // 2. Download and decrypt
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), 30000);

        try {
          const response = await getClient().send(
            new GetObjectCommand({ Bucket: bucket, Key: key }),
            { abortSignal: abortController.signal }
          );

          let body;
          try {
            body = decryptDb(await streamToBuffer(response.Body));
          } catch (decryptError) {
            if (decryptError.message.includes("DB_ENCRYPTION_KEY")) {
              console.error(`[R2 DB] CRITICAL: Remote data at ${bucket}/${key} is encrypted, but DB_ENCRYPTION_KEY is not set on this machine. Sync paused to prevent data loss.`);
              return;
            }
            if (
              decryptError.message.includes("Unsupported state or unable to authenticate data") ||
              decryptError.message.includes("unable to authenticate data")
            ) {
              console.error(`[R2 DB] Decryption failed for ${bucket}/${key}: auth tag mismatch. DB_ENCRYPTION_KEY mismatch or data corrupted. Sync remains paused until key is fixed or remote data changes.`);
              return;
            }
            throw decryptError;
          }

          validateDownloadedDb(localPath, body);
          const payload = JSON.parse(body.toString("utf8"));

          // Sanity check: Ensure payload is a valid 9router DB export
          if (!payload.settings && !payload.providerConnections && !payload.modelAliases) {
            console.warn(`[R2 DB] Pull aborted: Downloaded payload from ${bucket}/${key} seems empty or invalid`);
            return;
          }

          // 3. Import into local DB (handles merging/overwriting)
          if (localPath?.endsWith(".sqlite")) {
            const { importDb } = await import("@/lib/db/index.js");
            await importDb(payload, { source: "sync" });
          }

          SYNC_STATE.lastRemoteETag = response.ETag;
          console.log(`[R2 DB] Real-time sync complete: Pulled from ${bucket}/${key}`);

          // If an upload was deferred while waiting for this pull, send it now
          if (SYNC_STATE.pendingUpload) await uploadDbFile(localPath);
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        if (!isMissingObjectError(error)) {
          console.warn(`[R2 DB] Real-time sync pull failed: ${getErrorMessage(error)}`);
        }
        throw error;
      } finally {
        SYNC_STATE.isPulling = false;
      }
    });

  return syncQueue;
}
