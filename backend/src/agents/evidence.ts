import { z } from "zod";
import { authorize } from "../permissions";
import type { State } from "../store";
import { newId } from "../store";
import type { Evidence } from "../types";
import { serp, type SerpOrganic } from "../integrations/brightdata";
import { haversineMiles, placeToPoint, zipToPoint } from "../integrations/geo";
import { weatherAt } from "../integrations/nws";
import { payAndFetch } from "../integrations/x402";
import { postEntry } from "../ledger";
import { llmAvailable, structured } from "../llm";
import { planPublicTransit, type TransitOption } from "../integrations/transitous";
import { currentOfficialFares } from "../integrations/official-fares";
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

function quoteStatesAmount(quote: string, amountUsd: number) {
  const exact = amountUsd.toFixed(2);
  const short = exact.replace(/\.00$/, "");
  return quote.includes(`$${exact}`) || quote.includes(`$${short}`);
}

async function extractFares(results: SerpOrganic[], from: string, to: string, routeContext?: string) {
  const links = new Set(results.map((result) => result.link));
  const corpus = results.map((result) => `${result.title} ${result.description ?? ""}`).join("\n").toLowerCase();
  if (!llmAvailable()) return { fares: faresByRules(results), extractedBy: "rules" };
  try {
    const candidates = await structured(FareCandidates, {
      model: "extract",
      system: "From these live search results, list current adult fares that cover the supplied live itinerary. Copy the link and the exact snippet text. Never estimate or invent a price. A current Metrolink SoCal Day Pass can be the trip total when the itinerary uses Metrolink and the evidence says it includes the local connections. A single-agency local route can use that agency's published regular fare when its transfer rule covers the itinerary. Otherwise, accept only an explicitly stated total for the exact origin and destination. Prefer the newest official agency page and skip superseded prices.",
      user: JSON.stringify({ from, to, routeContext, results }),
      effort: "low",
    });
    return {
      fares: candidates.fares.filter((fare) => links.has(fare.link) && corpus.includes(fare.quote.toLowerCase()) && quoteStatesAmount(fare.quote, fare.amountUsd) && fare.amountUsd > 0 && fare.amountUsd < 1000),
      extractedBy: "claude (quotes verified against live snippets)",
    };
  } catch {
    return { fares: faresByRules(results), extractedBy: "rules" };
  }
}

function officialFareQuery(options: TransitOption[], startsAt?: string) {
  const agencies = [...new Set(options.flatMap((option) => option.agencies))];
  if (!agencies.length) return undefined;
  const travelDate = startsAt ? new Date(startsAt) : new Date();
  const weekend = travelDate.getDay() === 0 || travelDate.getDay() === 6;
  if (agencies.some((agency) => /metrolink/i.test(agency))) {
    return `site:metrolinktrains.com/fare-change-2026 ${weekend ? "Weekend Holiday" : "Weekday"} SoCal Day Pass current price free local transit transfers`;
  }
  if (agencies.every((agency) => /metro.*los angeles/i.test(agency))) {
    return `site:metro.net/fares current regular fare one way free transfers within 2 hours`;
  }
  if (agencies.every((agency) => /orange county transportation|octa/i.test(agency))) {
    return `site:octa.net/getting-around/bus/oc-bus/fares-and-passes/overview current regular one way fare free transfer`;
  }
  return `${agencies.join(" ")} current adult fare official`;
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

export async function gatherEvidence(state: State, args: { tripId: string; homeZip: string; originText?: string; originCoordinates?: { lat: number; lon: number }; event: EventFacts & { city?: string }; travelConstraintSummary?: string }) {
  const { tripId, homeZip, event } = args;
  const out: Evidence[] = [];

  authorize(state, agent, "feeds.read", tripId);
  const enteredPlace = args.originText?.trim() && args.originText.trim() !== homeZip ? await placeToPoint(args.originText.trim()) : undefined;
  const zipPoint = await zipToPoint(homeZip);
  const home = args.originCoordinates
    ? { ...zipPoint, status: "ok" as const, lat: args.originCoordinates.lat, lon: args.originCoordinates.lon, label: args.originText?.trim() || zipPoint.label, source: "Browser geolocation", url: undefined }
    : enteredPlace?.status === "ok" ? enteredPlace : zipPoint;
  out.push(push(state, { tripId, kind: "geocode", source: home.source, url: home.url, status: home.status, data: args.originCoordinates ? { zip: homeZip, label: home.label, preciseLocationRetained: false } : { zip: homeZip, lat: home.lat, lon: home.lon, label: home.label }, note: home.error }));

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
  const transitPromise = home.status === "ok" && home.lat !== undefined && home.lon !== undefined && event.lat !== undefined && event.lon !== undefined
    ? planPublicTransit({ from: { lat: home.lat, lon: home.lon }, to: { lat: event.lat, lon: event.lon }, startsAt: event.startsAt })
    : Promise.resolve({ status: "empty" as const, url: "https://transitous.org/sources/", options: [] as TransitOption[], ms: 0, error: "Coordinates were unavailable for live transit routing." });
  const [stops, transit] = await Promise.all([
    venueQ ? serp(`breakfast coffee near ${venueQ}`, 1, 6_000) : Promise.resolve(null),
    transitPromise,
  ]);

  if (stops) {
    const top = (stops.body ?? []).slice(0, 3).map((r) => ({ title: r.title, link: r.link }));
    out.push(push(state, { tripId, kind: "stop", source: "Bright Data SERP API → Google", status: stops.status, data: { query: venueQ, results: top, attempts: stops.attempts, ms: stops.ms }, note: stops.error ?? (stops.errorCode ? `x-brd-error-code=${stops.errorCode}` : undefined) }));
  }

  const targetedQuery = officialFareQuery(transit.options, event.startsAt);
  const officialFares = await currentOfficialFares(transit.options, event.startsAt);
  const needSearchFallback = officialFares.length === 0 && transit.options.every((option) => option.amountUsd === undefined);
  const [fareSerp, directionsSerp, targetedFareSerp] = await Promise.all([
    needSearchFallback ? serp(`${fromCity} to ${destination} train bus rideshare flight total fare cost${args.travelConstraintSummary ? ` ${args.travelConstraintSummary}` : ""}`, 1, 6_000) : Promise.resolve({ status: "empty" as const, body: undefined, attempts: 0, ms: 0, error: undefined }),
    transit.options.length ? Promise.resolve({ status: "empty" as const, body: undefined, attempts: 0, ms: 0, error: undefined }) : serp(`${fromCity} to ${destination} public transit directions route stops transfers duration${args.travelConstraintSummary ? ` ${args.travelConstraintSummary}` : ""}`, 1, 6_000),
    needSearchFallback && targetedQuery ? serp(targetedQuery, 1, 6_000) : Promise.resolve(null),
  ]);
  const fareResults = [
    ...(targetedFareSerp?.status === "ok" && targetedFareSerp.body ? targetedFareSerp.body.slice(0, 8) : []),
    ...(fareSerp.status === "ok" && fareSerp.body ? fareSerp.body.slice(0, 8) : []),
  ];
  const directionResults = directionsSerp.status === "ok" && directionsSerp.body ? directionsSerp.body.slice(0, 8) : [];
  const routeContext = transit.options.length
    ? [`travel date: ${event.startsAt ?? "not provided"}`, ...transit.options.map((option) => `${option.title}; ${option.durationText}; agencies: ${option.agencies.join(", ")}`)].join("\n")
    : undefined;
  const [fareExtraction, guideExtraction] = await Promise.all([
    fareResults.length ? extractFares(fareResults, fromCity, destination, routeContext) : Promise.resolve({ fares: [] as { mode: string; amountUsd: number; link: string; quote: string }[], extractedBy: "none" }),
    directionResults.length ? extractRouteGuides(directionResults, fromCity, destination, args.travelConstraintSummary) : Promise.resolve({ guides: [] as RouteGuide[], extractedBy: "none" }),
  ]);
  const transitFares = transit.options.flatMap((option) => option.amountUsd && option.fareQuote ? [{ mode: option.mode, amountUsd: option.amountUsd, link: option.sourceUrl, quote: option.fareQuote }] : []);
  const fares = [...officialFares, ...transitFares, ...fareExtraction.fares].filter((fare, index, all) => all.findIndex((candidate) => candidate.mode === fare.mode && candidate.amountUsd === fare.amountUsd) === index);
  const fareStatus = fares.length ? "ok" : targetedFareSerp?.status === "error" ? targetedFareSerp.status : fareSerp.status === "ok" ? "empty" : fareSerp.status;
  out.push(
    push(state, {
      tripId,
      kind: "fare",
      source: "Official operator fares + Transitous GTFS fares + Bright Data SERP API",
      status: fareStatus,
      data: { fares, extractedBy: officialFares.length ? "current official operator page" : transitFares.length ? "GTFS fare products and/or Claude with verified public-web quotes" : fareExtraction.extractedBy, attempts: fareSerp.attempts + (targetedFareSerp?.attempts ?? 0), ms: fareSerp.ms + (targetedFareSerp?.ms ?? 0), query: targetedQuery },
      note: targetedFareSerp?.error ?? fareSerp.error ?? (fares.length === 0 ? "Current route data was found, but no source stated an auditable total fare. S’mile will not invent one." : undefined),
    }),
  );

  const routeGuides: RouteGuide[] = transit.options.length
    ? transit.options.map((option) => ({ mode: option.mode, title: option.title, durationText: option.durationText, sourceUrl: option.sourceUrl, sourceQuote: option.sourceQuote, steps: option.steps }))
    : guideExtraction.guides;
  out.push(
    push(state, {
      tripId,
      kind: "route_guide",
      source: transit.options.length ? "Transitous MOTIS → public GTFS and GTFS-Realtime" : "Bright Data SERP API → Google → Claude",
      url: transit.options.length ? "https://transitous.org/sources/" : undefined,
      status: transit.options.length ? "ok" : directionsSerp.status === "ok" && guideExtraction.guides.length === 0 ? "empty" : directionsSerp.status,
      data: { from: fromCity, to: destination, options: routeGuides, extractedBy: transit.options.length ? "MOTIS live public-transit routing" : guideExtraction.extractedBy, attempts: directionsSerp.attempts, ms: transit.options.length ? transit.ms : directionsSerp.ms },
      note: transit.options.length ? "Uses public GTFS schedules and GTFS-Realtime where agencies publish it; verify the linked live directions before departure." : transit.error ?? directionsSerp.error ?? (directionsSerp.status === "ok" && guideExtraction.guides.length === 0 ? "Live results did not contain enough grounded detail for step-by-step instructions." : undefined),
    }),
  );

  return { evidence: out, miles, homeLabel: fromCity, fares, routeGuides };
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
      postedBy: { kind: "agent", id: "reconciler" },
    });
  }
  return e;
}
