import "./env";
import { buildSeed, scoutEvent } from "../src/index";

const url = process.argv[2];
if (!url) {
  console.error("usage: npm run scout -- <public event page url>");
  process.exit(2);
}
const { state } = buildSeed();
const r = await scoutEvent(state, url);
console.log(JSON.stringify({ status: r.evidence.status, facts: r.facts, note: r.evidence.note }, null, 2));
