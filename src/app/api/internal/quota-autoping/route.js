import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runQuotaAutoPingTick } from "@/shared/services/quotaAutoPing";

export const dynamic = "force-dynamic";

function matchesSecret(expected, received) {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received || "");
  return expectedBytes.length === receivedBytes.length
    && timingSafeEqual(expectedBytes, receivedBytes);
}

export async function POST(request) {
  const expectedSecret = process.env.QUOTA_AUTOPING_SECRET?.trim();
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: "Auto-ping secret is not configured" }, { status: 503 });
  }

  const authorization = request.headers.get("authorization") || "";
  const receivedSecret = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]
    || request.headers.get("x-quota-autoping-secret")
    || "";
  if (!matchesSecret(expectedSecret, receivedSecret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();
  try {
    await runQuotaAutoPingTick();
    const finishedAt = new Date().toISOString();
    console.log(`[AutoPing] Function trigger completed at ${finishedAt}`);
    return NextResponse.json({ ok: true, startedAt, finishedAt });
  } catch (error) {
    console.error(`[AutoPing] Function trigger failed: ${error.message}`);
    return NextResponse.json({ ok: false, error: "Auto-ping failed" }, { status: 500 });
  }
}
