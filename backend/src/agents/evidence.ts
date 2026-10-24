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

const RouteGuideCandidates = z.object({
  options: z.array(
    z.object({
      mode: z.enum(["train", "bus", "rideshare", "flight"]),
      title: z.string().min(1).max(120),
      durationText: z.string().max(80).nullable(),
      sourceUrl: z.string(),
      sourceQuote: z.string().min(1).max(300),
      steps: z.array(z.object({ instruction: z.string().min(1).max(220), detail: z.string().max(300).nullable() })).min(1).max(8),
    }),
  ).max(4),
});

export type RouteGuide = z.infer<typeof RouteGuideCandidates>["options"][number];

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

async function extractFares(results: SerpOrganic[], from: string, to: string) {
  const links = new Set(results.map((result) => result.link));
  const corpus = results.map((result) => `${result.title} ${result.description ?? ""}`).join("\n").toLowerCase();
  if (!llmAvailable()) return { fares: faresByRules(results), extractedBy: "rules" };
  try {
    const candidates = await structured(FareCandidates, {
      model: "extract",
      system: "From these live search results, list total travel fares that are explicitly stated for this exact trip. Copy the link and the exact snippet text. Never estimate or invent a price. Skip anything that is not an explicit dollar fare.",
      user: JSON.stringify({ from, to, results }),
      effort: "low",
    });
    return {
      fares: candidates.fares.filter((fare) => links.has(fare.link) && corpus.includes(fare.quote.toLowerCase()) && fare.amountUsd > 0 && fare.amountUsd < 1000),
      extractedBy: "claude (quotes verified against live snippets)",
    };
  } catch {
    return { fares: faresByRules(results), extractedBy: "rules" };
  }
}

async function extractRouteGuides(results: SerpOrganic[], from: string, to: string, requirement?: string) {
  if (!llmAvailable()) return { guides: [] as RouteGuide[], extractedBy: "unavailable" };
  const links = new Set(results.map((result) => result.link));
  const corpus = results.map((result) => `${result.title} ${result.description ?? ""}`).join("\n").toLowerCase();
  try {
    const candidates = await structured(RouteGuideCandidates, {
      model: "extract",
      system: "Build concise door-to-door travel instructions using only the supplied live search-result titles and descriptions. Produce the best supported train, bus, rideshare, or flight options. Preserve an exact transit line, stop, transfer, duration, or schedule only when it appears in the evidence. Never invent route details. When the evidence omits a detail, tell the traveler to confirm that part in the linked live directions. sourceQuote must be one exact contiguous quote from the supplied result for sourceUrl.",
      user: JSON.stringify({ from, to, requirement, results }),
      effort: "low",
    });
    const guides = candidates.options.filter((option) => links.has(option.sourceUrl) && corpus.includes(option.sourceQuote.toLowerCase()));
    return { guides, extractedBy: "claude (routes grounded in live search snippets)" };
  } catch {
    return { guides: [] as RouteGuide[], extractedBy: "unavailable" };
  }
}

export async function gatherEvidence(state: State, args: { tripId: string; homeZip: string; originText?: string; event: EventFacts & { city?: string }; travelConstraintSummary?: string }) {
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
  const fromCity = args.originText?.trim() || home.label || homeZip;
  const destination = event.address ?? event.venue ?? event.city ?? event.name ?? "event venue";
  const [stops, fareSerp, directionsSerp] = await Promise.all([
    venueQ ? serp(`breakfast coffee near ${venueQ}`, 1) : Promise.resolve(null),
    serp(`${fromCity} to ${destination} train bus rideshare flight total fare cost${args.travelConstraintSummary ? ` ${args.travelConstraintSummary}` : ""}`, 1),
    serp(`${fromCity} to ${destination} public transit directions route stops transfers duration${args.travelConstraintSummary ? ` ${args.travelConstraintSummary}` : ""}`, 1),
  ]);

  if (stops) {
    const top = (stops.body ?? []).slice(0, 3).map((r) => ({ title: r.title, link: r.link }));
    out.push(push(state, { tripId, kind: "stop", source: "Bright Data SERP API → Google", status: stops.status, data: { query: venueQ, results: top, attempts: stops.attempts, ms: stops.ms }, note: stops.error ?? (stops.errorCode ? `x-brd-error-code=${stops.errorCode}` : undefined) }));
  }

  const fareResults = fareSerp.status === "ok" && fareSerp.body ? fareSerp.body.slice(0, 8) : [];
  const directionResults = directionsSerp.status === "ok" && directionsSerp.body ? directionsSerp.body.slice(0, 8) : [];
  const [fareExtraction, guideExtraction] = await Promise.all([
    fareResults.length ? extractFares(fareResults, fromCity, destination) : Promise.resolve({ fares: [] as { mode: string; amountUsd: number; link: string; quote: string }[], extractedBy: "none" }),
    directionResults.length ? extractRouteGuides(directionResults, fromCity, destination, args.travelConstraintSummary) : Promise.resolve({ guides: [] as RouteGuide[], extractedBy: "none" }),
  ]);
  const fares = fareExtraction.fares;
  out.push(
    push(state, {
      tripId,
      kind: "fare",
      source: "Bright Data SERP API → Google",
      status: fareSerp.status === "ok" && fares.length === 0 ? "empty" : fareSerp.status,
      data: { fares, extractedBy: fareExtraction.extractedBy, attempts: fareSerp.attempts, ms: fareSerp.ms },
      note: fareSerp.error ?? (fares.length === 0 && fareSerp.status === "ok" ? "Results came back, but none stated an explicit fare. Route Analyst will fall back to the drive estimate." : undefined),
    }),
  );

  out.push(
    push(state, {
      tripId,
      kind: "route_guide",
      source: "Bright Data SERP API → Google → Claude",
      status: directionsSerp.status === "ok" && guideExtraction.guides.length === 0 ? "empty" : directionsSerp.status,
      data: { from: fromCity, to: destination, options: guideExtraction.guides, extractedBy: guideExtraction.extractedBy, attempts: directionsSerp.attempts, ms: directionsSerp.ms },
      note: directionsSerp.error ?? (directionsSerp.status === "ok" && guideExtraction.guides.length === 0 ? "Live results did not contain enough grounded detail for step-by-step instructions." : undefined),
    }),
  );

  return { evidence: out, miles, homeLabel: fromCity, fares, routeGuides: guideExtraction.guides };
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
