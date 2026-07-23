import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Safe{Wallet} fetches /manifest.json and its icon cross-origin (from
  // app.safe.global) when adding this as a custom Safe App — without CORS
  // headers here that fetch is blocked and Safe reports "The app doesn't
  // support Safe App functionality" even though the file itself is fine.
  async headers() {
    return [
      {
        source: "/manifest.json",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET" },
          { key: "Access-Control-Allow-Headers", value: "X-Requested-With, content-type, Authorization" },
        ],
      },
      {
        source: "/logo.svg",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
};

export default nextConfig;
