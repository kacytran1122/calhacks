import { z } from "zod";
import { authorize } from "../permissions";
import type { State } from "../store";
import { newId } from "../store";
import type { Evidence } from "../types";
import { serp, type SerpOrganic } from "../integrations/brightdata";
import { haversineMiles, zipToPoint } from "../integrations/geo";
import { weatherAt } from "../integrations/nws";
import { payAndFetch } from "../integrations/x402";
import { postEntry } from "../ledger";
import { llmAvailable, structured } from "../llm";
import type { EventFacts } from "./scout";

const agent = { kind: "agent" as const, id: "evidence" as const };

function push(state: State, e: Omit<Evidence, "id" | "fetchedAt" | "provenance"> & { provenance?: Evidence["provenance"] }): Evidence {
  const full: Evidence = { id: newId(`EV-${e.kind}`), fetchedAt: new Date().toISOString(), provenance: "live", ...e };
  state.evidence.push(full);
  return full;
}

const FareCandidates = z.object({
  fares: z.array(
    z.object({
      mode: z.enum(["train", "bus", "rideshare", "flight"]),
      amountUsd: z.number(),
      link: z.string().describe("the result link the fare came from, copied exactly"),
      quote: z.string().describe("the exact snippet text that states the fare"),
    }),
  ),
});

function faresByRules(results: SerpOrganic[]) {
  const out: { mode: "train" | "bus"; amountUsd: number; link: string; quote: string }[] = [];
  for (const r of results) {
    const text = `${r.title} ${r.description ?? ""}`;
    if (!/fare|ticket|one[- ]way/i.test(text)) continue;
    const m = text.match(/\$(\d{1,3}(?:\.\d{2})?)/);
    if (m) out.push({ mode: /bus|greyhound|flixbus/i.test(text) ? "bus" : "train", amountUsd: Number(m[1]), link: r.link, quote: m[0] });
  }
  return out;
}

export async function gatherEvidence(state: State, args: { tripId: string; homeZip: string; event: EventFacts & { city?: string } }) {
  const { tripId, homeZip, event } = args;
  const out: Evidence[] = [];

  authorize(state, agent, "feeds.read", tripId);
  const home = await zipToPoint(homeZip);
  out.push(push(state, { tripId, kind: "geocode", source: home.source, url: home.url, status: home.status, data: { zip: homeZip, lat: home.lat, lon: home.lon, label: home.label }, note: home.error }));

  let miles: number | undefined;
  if (home.status === "ok" && event.lat !== undefined && event.lon !== undefined) miles = Math.round(haversineMiles({ lat: home.lat!, lon: home.lon! }, { lat: event.lat, lon: event.lon }));

  if (event.lat !== undefined && event.lon !== undefined && event.startsAt) {
    const w = await weatherAt(event.lat, event.lon, event.startsAt);
    out.push(push(state, { tripId, kind: "weather", source: "National Weather Service (api.weather.gov)", url: w.url, status: w.status, data: { summary: w.summary, tempF: w.tempF, precipPct: w.precipPct }, note: w.note }));
  }

  authorize(state, agent, "web.read", tripId);
  const venueQ = [event.venue, event.address ?? event.city].filter(Boolean).join(", ");
  const fromCity = home.label ?? homeZip;
  const [stops, fareSerp] = await Promise.all([
    venueQ ? serp(`breakfast coffee near ${venueQ}`) : Promise.resolve(null),
    serp(`${fromCity} to ${event.address ?? event.city ?? event.venue} train bus one way fare`),
  ]);

  if (stops) {
    const top = (stops.body ?? []).slice(0, 3).map((r) => ({ title: r.title, link: r.link }));
    out.push(push(state, { tripId, kind: "stop", source: "Bright Data SERP API → Google", status: stops.status, data: { query: venueQ, results: top, attempts: stops.attempts, ms: stops.ms }, note: stops.error ?? (stops.errorCode ? `x-brd-error-code=${stops.errorCode}` : undefined) }));
  }

  let fares: { mode: string; amountUsd: number; link: string; quote: string }[] = [];
  let extractedBy = "none";
  if (fareSerp.status === "ok" && fareSerp.body) {
    const results = fareSerp.body.slice(0, 8);
    const links = new Set(results.map((r) => r.link));
    const corpus = results.map((r) => `${r.title} ${r.description ?? ""}`).join("\n").toLowerCase();
    if (llmAvailable()) {
      try {
        const c = await structured(FareCandidates, {
          model: "extract",
          system: "From these search results, list one-way fares that are explicitly stated for this trip. Copy the link and the exact snippet text. Skip anything that is not an explicit dollar fare.",
          user: JSON.stringify({ from: fromCity, to: event.address ?? event.city, results }),
          effort: "low",
        });
        fares = c.fares.filter((f) => links.has(f.link) && corpus.includes(f.quote.toLowerCase()) && f.amountUsd > 0 && f.amountUsd < 1000);
        extractedBy = "claude (quotes verified against snippets)";
      } catch {
        fares = faresByRules(results);
        extractedBy = "rules";
      }
    } else {
      fares = faresByRules(results);
      extractedBy = "rules";
    }
  }
  out.push(
    push(state, {
      tripId,
      kind: "fare",
      source: "Bright Data SERP API → Google",
      status: fareSerp.status === "ok" && fares.length === 0 ? "empty" : fareSerp.status,
      data: { fares, extractedBy, attempts: fareSerp.attempts, ms: fareSerp.ms },
      note: fareSerp.error ?? (fares.length === 0 && fareSerp.status === "ok" ? "Results came back, but none stated an explicit fare. Route Analyst will fall back to the drive estimate." : undefined),
    }),
  );

  return { evidence: out, miles, homeLabel: home.label, fares };
}

export async function buyWithX402(state: State, tripId: string, url: string, priceCents = 1): Promise<Evidence> {
  authorize(state, agent, "x402.pay", tripId);
  const r = await payAndFetch(url);
  const e = push(state, {
    tripId,
    kind: "x402_purchase",
    source: `x402 → ${url}`,
    url,
    status: r.ok ? "ok" : r.reason === "spend_control" ? "blocked" : "error",
    provenance: "testnet",
    data: r.ok ? { payer: r.payer, httpStatus: r.status, body: r.body } : { reason: r.reason },
    note: r.ok ? "Paid on Base Sepolia (testnet USDC)." : r.detail,
  });
  if (r.ok) {
    postEntry(state, {
      date: new Date().toISOString().slice(0, 10),
      period: state.company.openPeriod,
      memo: `x402 data purchase for ${tripId} (testnet)`,
      lines: [
        { account: "5200", debit: priceCents, credit: 0 },
        { account: "1050", debit: 0, credit: priceCents },
      ],
      refs: [e.id, tripId],
      postedBy: { kind: "agent", id: "reconciler" }, // the Evidence agent can't post (least privilege)
    });
  }
  return e;
}
