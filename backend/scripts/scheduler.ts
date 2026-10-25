import "./env";
import { hasState, JOBS, runDue, type JobId } from "../src/index";

// npm run scheduler            wake every SCHEDULER_INTERVAL_MINUTES (default 5) and run due jobs
// npm run scheduler -- --once  one pass, then exit
// npm run scheduler -- --once price_watch event_watch   run these jobs now, due or not
const args = process.argv.slice(2);
const once = args.includes("--once");
const only = args.filter((a): a is JobId => a in JOBS);
const every = Math.max(1, Number(process.env.SCHEDULER_INTERVAL_MINUTES ?? 5) || 5);

async function pass() {
  if (!hasState()) {
    console.log("scheduler: no books yet; run `npm run seed` or open the app once");
    return;
  }
  const results = await runDue({}, only.length ? only : undefined);
  const stamp = new Date().toISOString();
  if (!results.length) console.log(`${stamp} nothing due`);
  for (const r of results) console.log(`${stamp} ${r.job}: ${"error" in r ? `failed: ${r.error}` : r.summary}`);
}

await pass();
if (!once) {
  console.log(`scheduler: waking every ${every} min (${Object.entries(JOBS).map(([id, j]) => `${id} every ${j.everyMinutes} min`).join(", ")})`);
  setInterval(() => void pass().catch((e) => console.error(`scheduler pass failed: ${(e as Error).message}`)), every * 60_000);
}
