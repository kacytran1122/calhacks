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
  serverExternalPackages: ["@coinbase/cdp-sdk", "@x402/fetch", "@x402/core", "@x402/evm", "@x402/next"],
  async rewrites() {
    const beforeFiles = backendOrigin
      ? [
          { source: "/api/:path*", destination: `${backendOrigin}/api/:path*` },
          { source: "/desk/:path*", destination: `${backendOrigin}/desk/:path*` },
        ]
      : [];
    return { beforeFiles, afterFiles: [], fallback: [] };
  },
};

export default config;
