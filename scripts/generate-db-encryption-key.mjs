import crypto from "node:crypto";

const key = crypto.randomBytes(32).toString("base64");

console.log("DB_ENCRYPTION_KEY=" + key);
