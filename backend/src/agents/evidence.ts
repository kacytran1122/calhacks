import { z } from "zod";
import { authorize } from "../permissions";
import type { State } from "../store";
import { newId } from "../store";
import type { Evidence } from "../types";
import { serp, type SerpOrganic } from "../integrations/brightdata";
import { haversineMiles, placeToPoint, stateCodeFromLabel, zipToPoint } from "../integrations/geo";
import { dayBefore, googleFlightsUrl } from "../integrations/googleFlights";
import { weatherAt } from "../integrations/nws";
import { llmAvailable, structured } from "../llm";
import { planPublicTransit, type TransitOption } from "../integrations/transitous";
import { currentOfficialFares } from "../integrations/official-fares";
import { planDrivingRoutes, type DrivePlanResult } from "../integrations/osrm";
import { estimateAirfare } from "../ml/price";
import type { EventFacts } from "./scout";

const agent = { kind: "agent" as const, id: "evidence" as const };
const LIVE_SEARCH_TIMEOUT_MS = 10_000;

export function usefulStopResults(results: SerpOrganic[]) {
  return results.filter((result) => {
    let url: URL;
    try {
      url = new URL(result.link);
    } catch {
      return false;
    }
    const genericPage = /\/(search|find|browse)(?:\/|$)/i.test(url.pathname)
      || /(?:^|[?&])(find_desc|find_loc|q|query)=/i.test(url.search)
      || /\b(?:top \d+ best|best .+ in|nearby .+|search results?)\b/i.test(result.title);
    return !genericPage;
  });
}

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
      provider: z.string().min(1).max(80),
      priceScope: z.enum(["route_total", "published_ticket", "day_pass"]),
      fees: z.enum(["included", "not_applicable", "not_stated"]),
    }),
  ),
});

const RouteGuideCandidates = z.object({
  options: z.array(
    z.object({
      mode: z.enum(["train", "bus", "rideshare", "flight", "drive"]),
      title: z.string().min(1).max(120),
      durationText: z.string().max(80).nullable(),
      durationMinutes: z.number().positive().nullable().optional(),
      sourceUrl: z.string(),
      sourceQuote: z.string().min(1).max(300),
      steps: z.array(z.object({ instruction: z.string().min(1).max(220), detail: z.string().max(300).nullable() })).min(1).max(8),
    }),
  ).max(4),
});

export type RouteGuide = z.infer<typeof RouteGuideCandidates>["options"][number];

function faresByRules(results: SerpOrganic[]) {
  const out: { mode: "train" | "bus"; amountUsd: number; link: string; quote: string; provider: string; priceScope: "published_ticket"; fees: "not_applicable" }[] = [];
  for (const r of results) {
    const text = `${r.title} ${r.description ?? ""}`;
    if (!/fare|ticket|one[- ]way/i.test(text)) continue;
    const m = text.match(/\$(\d{1,3}(?:\.\d{2})?)/);
    if (m) out.push({ mode: /bus|greyhound|flixbus/i.test(text) ? "bus" : "train", amountUsd: Number(m[1]), link: r.link, quote: m[0], provider: new URL(r.link).hostname.replace(/^www\./, ""), priceScope: "published_ticket", fees: "not_applicable" });
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
      system: "From these live public search results, return only current adult prices supported by an exact quoted amount. Copy the link and exact contiguous snippet. Never estimate, infer, or invent a price. For flights or rideshare, accept only the total for the exact origin, destination, and travel date when the snippet explicitly says taxes and mandatory fees are included. For train or bus, an official published ticket price or day pass is acceptable only when it covers the itinerary and its required transfers. A current Metrolink SoCal Day Pass can be the trip total when the evidence says it includes the local connections. Prefer the operator's official page, identify the provider, and skip old or superseded prices.",
      user: JSON.stringify({ from, to, routeContext, results }),
      effort: "low",
    });
    return {
      fares: candidates.fares.filter((fare) => links.has(fare.link) && corpus.includes(fare.quote.toLowerCase()) && quoteStatesAmount(fare.quote, fare.amountUsd) && fare.amountUsd > 0 && fare.amountUsd < 1000 && (!["flight", "rideshare"].includes(fare.mode) || (fare.priceScope === "route_total" && fare.fees === "included"))),
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
      system: "Build concise door-to-door travel instructions using only the supplied live search-result titles and descriptions. Produce the best supported train, bus, rideshare, or flight options. Preserve an exact transit line, stop, transfer, duration, or schedule only when it appears in the evidence. Set durationMinutes only when the evidence states an exact duration; otherwise omit it. Never invent route details. When the evidence omits a detail, tell the traveler to confirm that part in the linked live directions. sourceQuote must be one exact contiguous quote from the supplied result for sourceUrl.",
      user: JSON.stringify({ from, to, requirement, results }),
      effort: "low",
    });
    const guides = candidates.options.filter((option) => links.has(option.sourceUrl) && corpus.includes(option.sourceQuote.toLowerCase()));
    return { guides, extractedBy: "claude (routes grounded in live search snippets)" };
  } catch {
    return { guides: [] as RouteGuide[], extractedBy: "unavailable" };
  }
}

export async function gatherEvidence(state: State, args: { tripId: string; homeZip: string; originText?: string; originCoordinates?: { lat: number; lon: number }; event: EventFacts & { city?: string }; travelConstraintSummary?: string; includeSelfDrive?: boolean }) {
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
  const enteredOrigin = args.originText?.trim();
  const fromCity = enteredOrigin && enteredOrigin !== homeZip ? enteredOrigin : home.label || homeZip;
  const destination = [...new Set([event.address, event.venue, event.city].filter((value): value is string => Boolean(value)))].join(", ") || event.name || "event venue";
  const homePoint = home.status === "ok" && home.lat !== undefined && home.lon !== undefined ? { lat: home.lat, lon: home.lon } : undefined;
  const venuePoint = event.lat !== undefined && event.lon !== undefined ? { lat: event.lat, lon: event.lon } : undefined;
  const fromState = stateCodeFromLabel(home.label) ?? stateCodeFromLabel(fromCity) ?? stateCodeFromLabel(zipPoint.label);
  const toState = stateCodeFromLabel(event.city) ?? stateCodeFromLabel(event.address);
  const domesticInterstate = Boolean(fromState && toState && fromState !== toState);
  const airfare = domesticInterstate && homePoint && venuePoint && event.startsAt ? estimateAirfare({ from: homePoint, to: venuePoint, when: event.startsAt }) : null;
  const transitPromise = home.status === "ok" && home.lat !== undefined && home.lon !== undefined && event.lat !== undefined && event.lon !== undefined
    ? planPublicTransit({ from: { lat: home.lat, lon: home.lon }, to: { lat: event.lat, lon: event.lon }, startsAt: event.startsAt })
    : Promise.resolve({ status: "empty" as const, url: "https://transitous.org/sources/", options: [] as TransitOption[], ms: 0, error: "Coordinates were unavailable for live transit routing." });
  const travelDate = event.startsAt?.slice(0, 10) ?? "";
  const fareModes = domesticInterstate || (miles !== undefined && miles >= 150) ? "train bus flight" : "train bus";
  const fareQuery = `${fromCity} to ${destination} ${travelDate} official adult ${fareModes} ticket fare${args.travelConstraintSummary ? ` ${args.travelConstraintSummary}` : ""}`;
  const directionsQuery = `${fromCity} to ${destination} public transit directions route stops transfers duration${args.travelConstraintSummary ? ` ${args.travelConstraintSummary}` : ""}`;
  const [stops, transit, road, genericFareSerp, genericDirectionsSerp] = await Promise.all([
    venueQ ? serp(`coffee shop near ${venueQ} official location`, 1, LIVE_SEARCH_TIMEOUT_MS) : Promise.resolve(null),
    transitPromise,
    homePoint && venuePoint ? planDrivingRoutes({ from: homePoint, to: venuePoint }) : Promise.resolve<DrivePlanResult | null>(null),
    serp(fareQuery, 1, LIVE_SEARCH_TIMEOUT_MS),
    serp(directionsQuery, 1, LIVE_SEARCH_TIMEOUT_MS),
  ]);

  if (stops) {
    const top = usefulStopResults(stops.body ?? []).slice(0, 3).map((r) => ({ title: r.title, link: r.link }));
    const stopStatus = stops.status === "ok" && top.length === 0 ? "empty" : stops.status;
    out.push(push(state, { tripId, kind: "stop", source: "Bright Data SERP API → Google", status: stopStatus, data: { query: venueQ, results: top, attempts: stops.attempts, ms: stops.ms }, note: stops.error ?? (stops.errorCode ? `x-brd-error-code=${stops.errorCode}` : top.length === 0 && stops.status === "ok" ? "Live search returned only general search pages, so S’mile did not present them as specific places." : undefined) }));
  }

  const targetedQuery = officialFareQuery(transit.options, event.startsAt);
  const officialFares = await currentOfficialFares(transit.options, event.startsAt);
  const needSearchFallback = officialFares.length === 0 && transit.options.every((option) => option.amountUsd === undefined);
  const fareSerp = needSearchFallback ? genericFareSerp : { status: "empty" as const, body: undefined, attempts: 0, ms: 0, error: undefined };
  const directionsSerp = transit.options.length ? { status: "empty" as const, body: undefined, attempts: 0, ms: 0, error: undefined } : genericDirectionsSerp;
  const targetedFareSerp = needSearchFallback && targetedQuery ? await serp(targetedQuery, 1, LIVE_SEARCH_TIMEOUT_MS) : null;
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
  const transitFares = transit.options.flatMap((option) => option.amountUsd && option.fareQuote ? [{ mode: option.mode, amountUsd: option.amountUsd, link: option.sourceUrl, quote: option.fareQuote, routeTitle: option.title, provider: option.agencies.join(" + ") || "public transit operator", priceScope: "route_total" as const, fees: "not_applicable" as const }] : []);
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

  const transitGuides: RouteGuide[] = transit.options.map((option) => ({ mode: option.mode, title: option.title, durationText: option.durationText, durationMinutes: option.durationMinutes, sourceUrl: option.sourceUrl, sourceQuote: option.sourceQuote, steps: option.steps }));
  const roadGuides: RouteGuide[] = args.includeSelfDrive === false
    ? []
    : (road?.routes ?? []).map((route) => ({ mode: "drive", title: route.title, durationText: route.durationText, durationMinutes: route.durationMinutes, sourceUrl: route.sourceUrl, sourceQuote: route.sourceQuote, steps: route.steps }));
  const flightMinutes = airfare ? 150 + Math.max(45, Math.round((airfare.miles / 500) * 60)) : undefined;
  const flightDepartDate = event.startsAt ? dayBefore(event.startsAt) : undefined;
  const flightDatePassed = Boolean(flightDepartDate && flightDepartDate < new Date().toISOString().slice(0, 10));
  const flightGuide: RouteGuide[] = airfare && flightMinutes && event.startsAt
    ? [{
        mode: "flight",
        title: `Fly ${airfare.from.code} → ${airfare.to.code}`,
        durationText: `About ${Math.floor(flightMinutes / 60)} hr ${flightMinutes % 60} min door to door`,
        durationMinutes: flightMinutes,
        sourceUrl: flightDatePassed || !flightDepartDate ? "https://www.google.com/travel/flights/" : googleFlightsUrl(airfare.from.code, airfare.to.code, flightDepartDate),
        sourceQuote: flightDatePassed
          ? "Estimated door-to-door time includes airport buffers. The event's departure date has passed, so no current fare is claimed; choose a new date in Google Flights."
          : "Estimated door-to-door time includes a 90-minute airport arrival buffer and 60 minutes of combined airport transfers; verify the current itinerary in Google Flights.",
        steps: [
          { instruction: `Travel from ${fromCity} to ${airfare.from.code}.`, detail: "Allow enough time for the airport transfer and security." },
          { instruction: `Fly ${airfare.from.code} to ${airfare.to.code}.`, detail: flightDatePassed ? "The event date has passed. Choose a new departure date before checking a live fare." : "Open Google Flights for the current schedule and verified live fare." },
          { instruction: `Continue from ${airfare.to.code} to ${destination}.`, detail: "Check live road or transit conditions for the final transfer." },
        ],
      }]
    : [];
  const routeGuides = [...transitGuides, ...flightGuide, ...roadGuides, ...guideExtraction.guides]
    .filter((guide, index, all) => all.findIndex((candidate) => candidate.mode === guide.mode && candidate.title === guide.title) === index)
    .slice(0, 10);
  out.push(
    push(state, {
      tripId,
      kind: "route_guide",
      source: "Transitous + OSRM + Google Flights + grounded public search",
      url: transit.options.length ? "https://transitous.org/sources/" : road?.routes[0]?.sourceUrl,
      status: routeGuides.length ? "ok" : directionsSerp.status === "ok" && guideExtraction.guides.length === 0 ? "empty" : directionsSerp.status,
      data: { from: fromCity, to: destination, options: routeGuides, extractedBy: "live routing services plus grounded public sources", attempts: directionsSerp.attempts, ms: transit.ms + (road?.ms ?? 0) + directionsSerp.ms },
      note: routeGuides.length
        ? flightDatePassed
          ? "Transit and road routes use live routing services. Flight duration is a clearly labeled estimate; the event date has passed, so no current flight fare is claimed."
          : "Transit and road routes use live routing services. Flight duration is a clearly labeled door-to-door estimate; Google Flights supplies the current schedule and fare."
        : transit.error ?? road?.error ?? directionsSerp.error ?? (directionsSerp.status === "ok" && guideExtraction.guides.length === 0 ? "Live results did not contain enough grounded detail for step-by-step instructions." : undefined),
    }),
  );

  // Door-to-door times for comparing routes: the fastest live itinerary per mode.
  const minutes: Partial<Record<"train" | "bus" | "drive" | "rideshare" | "flight", { minutes: number; source: string }>> = {};
  for (const option of transit.options) if (!minutes[option.mode] || option.durationMinutes < minutes[option.mode]!.minutes) minutes[option.mode] = { minutes: option.durationMinutes, source: "Transitous live public-transit itinerary" };
  const drive = road?.routes[0];
  if (drive) {
    if (args.includeSelfDrive !== false) minutes.drive = { minutes: drive.durationMinutes, source: "OSRM live road route" };
    minutes.rideshare = { minutes: drive.durationMinutes, source: "OSRM live road route (pickup wait not included)" };
  }
  if (flightMinutes) minutes.flight = { minutes: flightMinutes, source: "Estimated door-to-door flight time using airport buffers and route distance" };

  return { evidence: out, miles, homeLabel: fromCity, fares, routeGuides, roadMiles: drive?.distanceMiles, minutes, homePoint, venuePoint };
}
