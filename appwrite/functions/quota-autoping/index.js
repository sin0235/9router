function getConfig() {
  const targetUrl = process.env.QUOTA_AUTOPING_TARGET_URL?.trim().replace(/\/+$/, "");
  const secret = (process.env.QUOTA_AUTOPING_SECRET_V2 || process.env.QUOTA_AUTOPING_SECRET)?.trim();
  if (!targetUrl || !secret) throw new Error("Function variables are not configured");

  const parsedUrl = new URL(targetUrl);
  if (parsedUrl.protocol !== "https:") throw new Error("Target URL must use HTTPS");
  return { targetUrl, secret };
}

const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleQuotaAutoPing({ req, res, log = () => {}, error = () => {} }) {
  let config;
  try {
    config = getConfig();
  } catch (cause) {
    error(cause.message);
    return res.json({ ok: false, error: cause.message }, 500);
  }

  const codexCatchUp = req?.bodyJson?.catchUp === "codex"
    || req?.headers?.["x-quota-autoping-catch-up"] === "codex";
  const endpoint = `${config.targetUrl}/api/internal/quota-autoping${codexCatchUp ? "?catchUp=codex" : ""}`;
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-quota-autoping-secret": config.secret,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(55000),
      });
      let payload = null;
      try { payload = await response.json(); } catch { /* empty response */ }

      if (response.ok && payload?.ok === true) {
        const sent = Number.isInteger(payload?.summary?.sent) ? payload.summary.sent : null;
        log(`Site auto-ping trigger completed with HTTP ${response.status}; ${sent ?? "unknown"} ping(s) sent (attempt ${attempt})`);
        return res.json({ ok: true, status: response.status, attempts: attempt, sent }, 200);
      }

      lastError = new Error(payload?.error || `Site returned HTTP ${response.status}`);
    } catch (cause) {
      lastError = cause;
    }

    if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  error(`Site trigger failed after ${RETRY_ATTEMPTS} attempts: ${lastError?.message || "unknown error"}`);
  return res.json({ ok: false, error: "Site trigger failed" }, 502);
}

export default handleQuotaAutoPing;
