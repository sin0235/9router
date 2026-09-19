function getConfig() {
  const targetUrl = process.env.QUOTA_AUTOPING_TARGET_URL?.trim().replace(/\/+$/, "");
  const secret = (process.env.QUOTA_AUTOPING_SECRET_V2 || process.env.QUOTA_AUTOPING_SECRET)?.trim();
  if (!targetUrl || !secret) throw new Error("Function variables are not configured");

  const parsedUrl = new URL(targetUrl);
  if (parsedUrl.protocol !== "https:") throw new Error("Target URL must use HTTPS");
  return { targetUrl, secret };
}

export async function handleQuotaAutoPing({ res, log = () => {}, error = () => {} }) {
  let config;
  try {
    config = getConfig();
  } catch (cause) {
    error(cause.message);
    return res.json({ ok: false, error: cause.message }, 500);
  }

  const endpoint = `${config.targetUrl}/api/internal/quota-autoping`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-quota-autoping-secret": config.secret,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(55000),
    });

    if (!response.ok) {
      error(`Site returned HTTP ${response.status}`);
      return res.json({ ok: false, error: "Site trigger failed", status: response.status }, 502);
    }

    log(`Site auto-ping trigger accepted with HTTP ${response.status}`);
    return res.json({ ok: true, status: response.status }, 200);
  } catch (cause) {
    error(`Site trigger request failed: ${cause.message}`);
    return res.json({ ok: false, error: "Site trigger request failed" }, 502);
  }
}

export default handleQuotaAutoPing;
