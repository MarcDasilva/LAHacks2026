import type { NextConfig } from "next";

const BRIDGE_UPSTREAM_HOST = process.env.BRIDGE_UPSTREAM_HOST ?? "100.85.113.12";
const BRIDGE_UPSTREAM_PORT = process.env.BRIDGE_UPSTREAM_PORT ?? "8001";
const VISER_UPSTREAM_PORT = process.env.VISER_UPSTREAM_PORT ?? "8890";

const nextConfig: NextConfig = {
  devIndicators: false,
  // ngrok-fronted dashboards use rotating *.ngrok-free.app hostnames.
  // Without this Next refuses HMR cross-origin requests in dev.
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok.app", "*.ngrok.io"],
  async rewrites() {
    return [
      {
        source: "/bridge/:path*",
        destination: `http://${BRIDGE_UPSTREAM_HOST}:${BRIDGE_UPSTREAM_PORT}/:path*`,
      },
      // Viser HTTP + WebSocket. The browser hits /viser/... on the dashboard
      // origin (single ngrok tunnel) and Next forwards over Tailscale to the
      // GX10's viser server. Next's rewriter proxies WS upgrade requests too,
      // which is what we need for viser's live scene updates.
      {
        source: "/viser/:path*",
        destination: `http://${BRIDGE_UPSTREAM_HOST}:${VISER_UPSTREAM_PORT}/:path*`,
      },
    ];
  },
};

export default nextConfig;
