import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_DB_KEY = "db.json";
const ENCRYPTED_DB_PREFIX = "9router-db-v1";

let client = null;
const initPromises = new Map();
let uploadQueue = Promise.resolve();

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

export function isR2DbEnabled(localPath) {
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
      console.log(`[R2 DB] Portable backup ${bucket}/${key} available; SQLite overwrite skipped`);
      return;
    }

    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, body);
    console.log(`[R2 DB] Downloaded ${bucket}/${key} to local backup json`);
  } catch (error) {
    if (isMissingObjectError(error)) {
      console.warn(`[R2 DB] Object ${bucket}/${key} not found; using local db`);
      return;
    }
    console.warn(`[R2 DB] Download failed for ${bucket}/${key}: ${error.message}`);
  }
}

export async function uploadDbToR2(localPath) {
  if (!isR2DbEnabled(localPath)) return;

  uploadQueue = uploadQueue
    .catch(() => {})
    .then(() => uploadDbFile(localPath));

  await uploadQueue;
}

async function uploadDbFile(localPath) {
  const { bucket, key } = getConfig(localPath);

  try {
    let payload;
    if (localPath?.endsWith(".sqlite")) {
      const { exportDb } = await import("@/lib/db/index.js");
      payload = Buffer.from(JSON.stringify(await exportDb()));
    } else {
      payload = await fs.readFile(localPath);
    }

    const body = encryptDb(payload);
    await getClient().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: getContentType(),
      Metadata: getEncryptionKey() ? { encrypted: ENCRYPTED_DB_PREFIX } : undefined,
    }));
    console.log(`[R2 DB] Uploaded portable backup to ${bucket}/${key}`);
  } catch (error) {
    console.warn(`[R2 DB] Upload failed for ${bucket}/${key}: ${error.message}`);
  }
}
