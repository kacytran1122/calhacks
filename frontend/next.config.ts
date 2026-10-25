import path from "node:path";
import type { NextConfig } from "next";

const rootEnv = path.resolve(process.cwd(), "../backend/.env");
try {
  process.loadEnvFile(rootEnv);
} catch {}

const backendOrigin = process.env.SMILE_BACKEND_ORIGIN?.replace(/\/$/, "");

const config: NextConfig = {
  agentRules: false,
  outputFileTracingRoot: path.resolve(process.cwd(), ".."),
  turbopack: { root: path.resolve(process.cwd(), "..") },
  transpilePackages: ["@smile/core"],
  async headers() {
    return [
      {
        source: "/map",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/3d-tour/index.html",
        destination: "/tour",
        permanent: true,
      },
    ];
  },
  async rewrites() {
    const apiProxy = backendOrigin
      ? [
          { source: "/api/:path*", destination: `${backendOrigin}/api/:path*` },
        ]
      : [];
    return { beforeFiles: apiProxy, afterFiles: [], fallback: [] };
  },
};

export default config;
