import "./env";

type Check = { name: string; ready: boolean; detail: string };
const set = (name: string) => Boolean(process.env[name]?.trim());

const payTo = set("X402_PAY_TO") || set("PAY_TO");
const cdpKeys = set("CDP_API_KEY_ID") && set("CDP_API_KEY_SECRET");
const brightDataReady = set("BRIGHTDATA_API_TOKEN") || set("BRIGHTDATA_API_KEY");
const coinbaseSellerReady = cdpKeys && (payTo || set("CDP_WALLET_SECRET"));
const checks: Check[] = [
  { name: "Anthropic / Claude", ready: set("ANTHROPIC_API_KEY") || set("ANTHROPIC_AUTH_TOKEN"), detail: "event and receipt extraction, explanations, audit defense" },
  { name: "Bright Data", ready: brightDataReady, detail: "live public event pages, fares, and stops" },
  { name: "TigerData", ready: set("TIGER_DATABASE_URL"), detail: "time-series event snapshots and change detection" },
  { name: "Coinbase x402 buyer", ready: cdpKeys && set("CDP_WALLET_SECRET"), detail: "agent purchases with Base Sepolia test USDC" },
  { name: "Coinbase x402 seller", ready: coinbaseSellerReady, detail: "paid S'mile evidence-pack endpoint" },
  { name: "Photon 2.0", ready: set("PHOTON_PROJECT_ID") && set("PHOTON_API_KEY") && set("SMILE_WEB_URL") && set("PHOTON_BRIDGE_SECRET"), detail: "@smile iMessage transport" },
];

console.log("S'mile sponsor integration readiness (values are never printed)\n");
for (const check of checks) console.log(`${check.ready ? "READY" : "NEEDS INPUT"}  ${check.name} — ${check.detail}`);

if (!set("BRIGHTDATA_ZONE") && brightDataReady) console.log("\nBright Data zone: auto-discover the first active Web Unlocker zone.");
if (!payTo && coinbaseSellerReady) console.log("Coinbase seller receiver: CDP will provision/reuse a testnet receiver wallet.");
