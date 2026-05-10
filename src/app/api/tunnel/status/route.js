import { NextResponse } from "next/server";

const DISABLED_STATUS = {
  enabled: false,
  settingsEnabled: false,
  tunnelUrl: "",
  shortId: "",
  publicUrl: "",
  running: false,
  reachable: false
};

const DISABLED_TAILSCALE_STATUS = {
  enabled: false,
  settingsEnabled: false,
  tunnelUrl: "",
  running: false,
  loggedIn: false,
  reachable: false
};

export async function GET() {
  if (process.env.DYNO) {
    return NextResponse.json({
      tunnel: DISABLED_STATUS,
      tailscale: DISABLED_TAILSCALE_STATUS,
      download: { downloading: false, progress: 0 }
    });
  }

  try {
    const [{ getTunnelStatus, getTailscaleStatus }, { getDownloadStatus }] = await Promise.all([
      import("@/lib/tunnel/tunnelManager"),
      import("@/lib/tunnel/cloudflared")
    ]);
    const [tunnel, tailscale] = await Promise.all([getTunnelStatus(), getTailscaleStatus()]);
    const download = getDownloadStatus();
    return NextResponse.json({ tunnel, tailscale, download });
  } catch (error) {
    console.error("Tunnel status error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
