import "./env";
import { fmt, runEval } from "../src/index";

const r = await runEval();
const t = r.totals;
console.log(`\nS'mile Desk — backlog eval (${r.ranAt})\n`);
for (const c of r.cases.filter((c) => !c.plant.startsWith("(clean)") || !(c.codeOk && c.payOk && c.needsHumanOk))) {
  const ok = c.codeOk && c.payOk && c.needsHumanOk;
  console.log(`${ok ? "✓" : "✗"} ${c.tripId}  expected ${c.expected.padEnd(26)} got ${c.got.padEnd(26)} pay ${fmt(c.gotPay).padStart(8)}  ${c.plant}`);
}
console.log(`\nPlanted errors caught: ${t.plantedCaught}/${t.planted}`);
console.log(`Clean trips passed straight through: ${t.cleanPassedThrough}/${t.clean}`);
console.log(`Exact (code + amount + escalation): ${t.exact}/${t.cases}`);
console.log(`Escalated to a person: ${t.escalations}\n`);
for (const c of r.controls) console.log(`${c.ok ? "✓" : "✗"} control: ${c.name} — ${c.detail}`);
console.log(`\nControls held: ${t.controlsHeld}/${t.controls}`);
if (t.exact !== t.cases || t.controlsHeld !== t.controls) process.exit(1);
