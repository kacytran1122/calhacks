import path from "node:path";
import type { NextConfig } from "next";

// One server-only file configures the web app, agents, and CLI without exposing secrets.
const rootEnv = path.resolve(process.cwd(), "../backend/.env");
try {
  process.loadEnvFile(rootEnv);
} catch {
  /* no .env yet — every integration reports "not configured" instead of faking data */
}

const config: NextConfig = {
  outputFileTracingRoot: path.resolve(process.cwd(), ".."),
  turbopack: { root: path.resolve(process.cwd(), "..") },
  transpilePackages: ["@smile/core"],
  serverExternalPackages: ["@coinbase/cdp-sdk", "@x402/fetch", "@x402/core", "@x402/evm", "@x402/next"],
};

export default config;
