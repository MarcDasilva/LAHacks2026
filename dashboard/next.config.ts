import type { NextConfig } from "next";

const BRIDGE_UPSTREAM_HOST = process.env.BRIDGE_UPSTREAM_HOST ?? "100.85.113.12";
const BRIDGE_UPSTREAM_PORT = process.env.BRIDGE_UPSTREAM_PORT ?? "8001";
const VISER_UPSTREAM_PORT = process.env.VISER_UPSTREAM_PORT ?? "8890";
const FRAME_STREAM_PORT = process.env.FRAME_STREAM_PORT ?? "8787";

const nextConfig: NextConfig = {
  devIndicators: false,
  // ngrok-fronted dashboards use rotating *.ngrok-free.app hostnames.
  // Without this Next refuses HMR cross-origin requests in dev.
  allowedDevOrigins: [
    "*.ngrok-free.app",
    "*.ngrok-free.dev",
    "*.ngrok.app",
    "*.ngrok.io",
  ],
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
      // Frame-relay WS server (server/frame-stream-server.mjs) runs on the
      // same laptop as Next.js. Routing it under the dashboard origin means
      // iOS connects to wss://<ngrok>/frame-stream instead of needing its
      // own tunnel.
      {
        source: "/frame-stream/:path*",
        destination: `http://localhost:${FRAME_STREAM_PORT}/:path*`,
      },
      {
        source: "/frame-stream",
        destination: `http://localhost:${FRAME_STREAM_PORT}/`,
      },
    ];
  },
};

export default nextConfig;
