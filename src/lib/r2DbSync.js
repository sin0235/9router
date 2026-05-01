import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_DB_KEY = "db.json";

let client = null;
let initPromise = null;
let uploadQueue = Promise.resolve();

function getConfig() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  const key = process.env.R2_DB_KEY || DEFAULT_DB_KEY;
  const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

  return { accountId, accessKeyId, secretAccessKey, bucket, key, endpoint };
}

export function isR2DbEnabled() {
  const { accountId, accessKeyId, secretAccessKey, bucket, key, endpoint } = getConfig();
  return Boolean(accountId && accessKeyId && secretAccessKey && bucket && key && endpoint);
}

function getClient() {
  if (!client) {
    const { accessKeyId, secretAccessKey, endpoint } = getConfig();
    client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
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

export async function initR2Db(localPath) {
  if (!isR2DbEnabled()) return;
  if (!initPromise) initPromise = downloadDbFromR2(localPath);
  await initPromise;
}

async function downloadDbFromR2(localPath) {
  const { bucket, key } = getConfig();

  try {
    const response = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await streamToBuffer(response.Body);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, body);
    console.log(`[R2 DB] Downloaded ${bucket}/${key} to local db`);
  } catch (error) {
    if (isMissingObjectError(error)) {
      console.warn(`[R2 DB] Object ${bucket}/${key} not found; using local db`);
      return;
    }
    console.warn(`[R2 DB] Download failed for ${bucket}/${key}: ${error.message}`);
  }
}

export async function uploadDbToR2(localPath) {
  if (!isR2DbEnabled()) return;

  uploadQueue = uploadQueue
    .catch(() => {})
    .then(() => uploadDbFile(localPath));

  await uploadQueue;
}

async function uploadDbFile(localPath) {
  const { bucket, key } = getConfig();

  try {
    const body = await fs.readFile(localPath);
    await getClient().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
    }));
    console.log(`[R2 DB] Uploaded local db to ${bucket}/${key}`);
  } catch (error) {
    console.warn(`[R2 DB] Upload failed for ${bucket}/${key}: ${error.message}`);
  }
}
