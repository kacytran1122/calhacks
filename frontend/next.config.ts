import path from "node:path";
import { BlockList, isIP } from "node:net";
import type { NextConfig } from "next";

const rootEnv = path.resolve(process.cwd(), "../backend/.env");
try {
  process.loadEnvFile(rootEnv);
} catch {}

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("0.0.0.0", "ipv4");
loopbackAddresses.addAddress("::", "ipv6");
loopbackAddresses.addAddress("::1", "ipv6");
loopbackAddresses.addAddress("::ffff:0.0.0.0", "ipv6");
loopbackAddresses.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

function localHostname(value: string): boolean {
  const dotted = value.toLowerCase().replace(/\.+$/u, "");
  const hostname = dotted.startsWith("[") && dotted.endsWith("]") ? dotted.slice(1, -1) : dotted;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  const family = isIP(hostname);
  return family === 4 ? loopbackAddresses.check(hostname, "ipv4") : family === 6 ? loopbackAddresses.check(hostname, "ipv6") : false;
}

export function validatedBackendOrigin(value: string | undefined): string | undefined {
  const configured = value?.trim();
  if (!configured) return undefined;
  const url = new URL(configured);
  if (url.protocol !== "https:" || localHostname(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SMILE_BACKEND_ORIGIN must be a public HTTPS origin without a path, query, credentials, or fragment.");
  }
  return url.origin;
}

const configuredBackendOrigin = validatedBackendOrigin(process.env.SMILE_BACKEND_ORIGIN);

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
    const apiProxy = configuredBackendOrigin
      ? [
          { source: "/api/:path*", destination: `${configuredBackendOrigin}/api/:path*` },
        ]
      : [];
    return { beforeFiles: apiProxy, afterFiles: [], fallback: [] };
  },
};

export default config;
