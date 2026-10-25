import "./env";
import { discoverEvents } from "../src/index";

const [zip = "95616", radius = "150", ...q] = process.argv.slice(2);
const r = await discoverEvents({ zip, radiusMiles: Number(radius), query: q.join(" ") || undefined });
console.log(`Near ${r.origin.label} (${zip}), within ${r.radiusMiles} mi — classified by ${r.classifiedBy}, snapshots in ${r.store}${r.storeNote ? ` (${r.storeNote})` : ""}`);
for (const s of r.sources) console.log(`  source ${s.source}: ${s.status} via ${s.via}, ${s.count} listings, ${s.ms} ms${s.note ? ` — ${s.note}` : ""}`);
for (const e of r.events) console.log(`  ${e.startsAt?.slice(0, 10)}  ${String(e.distanceMiles).padStart(4)} mi  [${e.kind}] ${e.name} — ${e.city ?? e.venue ?? ""} (${e.source}${e.alsoOn ? ` + ${e.alsoOn.join(", ")}` : ""}${e.locationPrecision === "city" ? ", city-level" : ""})${e.change ? `  ⚠ ${e.change}` : ""}`);
if (r.unplaced.length) console.log(`  + ${r.unplaced.length} matching event(s) with no trusted location`);
