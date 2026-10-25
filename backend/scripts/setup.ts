import "./env";

type Check = { name: string; ready: boolean; detail: string };
const set = (name: string) => Boolean(process.env[name]?.trim());

const brightDataReady = set("BRIGHTDATA_API_TOKEN") || set("BRIGHTDATA_API_KEY");
const checks: Check[] = [
  { name: "Anthropic / Claude", ready: set("ANTHROPIC_API_KEY") || set("ANTHROPIC_AUTH_TOKEN"), detail: "event and receipt extraction, explanations, audit defense" },
  { name: "Bright Data", ready: brightDataReady, detail: "live public event pages, fares, and stops" },
  { name: "TigerData", ready: set("TIGER_DATABASE_URL"), detail: "time-series event snapshots and change detection" },
  { name: "Photon 2.0", ready: set("PHOTON_PROJECT_ID") && set("PHOTON_API_KEY") && set("SMILE_WEB_URL") && set("PHOTON_BRIDGE_SECRET"), detail: "@smile iMessage transport" },
];

console.log("S'mile sponsor integration readiness (values are never printed)\n");
for (const check of checks) console.log(`${check.ready ? "READY" : "NEEDS INPUT"}  ${check.name} — ${check.detail}`);

if (!set("BRIGHTDATA_UNLOCKER_ZONE") && brightDataReady) console.log("\nBright Data Web Unlocker zone: auto-discover the first active matching API.");
if (!set("BRIGHTDATA_SERP_ZONE") && brightDataReady) console.log("Bright Data SERP zone: auto-discover the first active matching API.");
