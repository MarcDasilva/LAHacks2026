import type { NextConfig } from "next";

const BRIDGE_UPSTREAM_HOST = process.env.BRIDGE_UPSTREAM_HOST ?? "100.85.113.12";
const BRIDGE_UPSTREAM_PORT = process.env.BRIDGE_UPSTREAM_PORT ?? "8001";

const nextConfig: NextConfig = {
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/bridge/:path*",
        destination: `http://${BRIDGE_UPSTREAM_HOST}:${BRIDGE_UPSTREAM_PORT}/:path*`,
      },
    ];
  },
};

export default nextConfig;
