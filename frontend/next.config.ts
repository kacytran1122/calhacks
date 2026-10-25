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
  async rewrites() {
    const fallback = backendOrigin
      ? [
          { source: "/api/:path*", destination: `${backendOrigin}/api/:path*` },
        ]
      : [];
    return { beforeFiles: [], afterFiles: [], fallback };
  },
};

export default config;
