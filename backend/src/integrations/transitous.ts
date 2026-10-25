import type { FetchStatus } from "../types";

const API = "https://api.transitous.org/api/v6/plan";
const ATTRIBUTION_URL = "https://transitous.org/sources/";
const USER_AGENT = "Smile/0.1 (+https://github.com/kacytran1122/calhacks)";

type Place = { name?: string; tz?: string };
type Leg = {
  mode: string;
  from: Place;
  to: Place;
  duration: number;
  startTime: string;
  endTime: string;
  realTime: boolean;
  cancelled?: boolean;
  headsign?: string;
  tripTo?: Place;
  displayName?: string;
  routeShortName?: string;
  agencyName?: string;
};

type FareProduct = { name: string; amount: number; currency: string; riderCategory?: { isDefaultFareCategory?: boolean } };
type FareTransfer = { transferProducts?: FareProduct[]; effectiveFareLegProducts?: FareProduct[][] };
type Itinerary = {
  duration: number;
  startTime: string;
  endTime: string;
  transfers: number;
  legs: Leg[];
  fareTransfers?: FareTransfer[];
};

export type TransitPlanPayload = { itineraries?: Itinerary[] };

export interface TransitStep {
  instruction: string;
  detail: string | null;
}

export interface TransitOption {
  mode: "train" | "bus";
  title: string;
  durationMinutes: number;
  durationText: string;
  sourceUrl: string;
  sourceQuote: string;
  steps: TransitStep[];
  agencies: string[];
  amountUsd?: number;
  fareQuote?: string;
}

export interface TransitPlanResult {
  status: FetchStatus;
  url: string;
  options: TransitOption[];
  ms: number;
  error?: string;
}

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

function durationText(seconds: number) {
  const mins = minutes(seconds);
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return hours ? `${hours} hr${hours === 1 ? "" : "s"}${rest ? ` ${rest} min` : ""}` : `${rest} min`;
}

function timeText(value: string, timeZone?: string) {
  try {
    return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timeZone || "America/Los_Angeles" });
  } catch {
    return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
}

function lineName(leg: Leg) {
  return leg.displayName || leg.routeShortName || leg.mode.toLowerCase().replace(/_/g, " ");
}

function fareTotal(itinerary: Itinerary) {
  const products = (itinerary.fareTransfers ?? []).flatMap((transfer) => [
    ...(transfer.transferProducts ?? []),
    ...(transfer.effectiveFareLegProducts ?? []).flatMap((choices) => {
      const defaults = choices.filter((product) => product.riderCategory?.isDefaultFareCategory !== false);
      const pool = defaults.length ? defaults : choices;
      return pool.length ? [pool.reduce((best, product) => product.amount < best.amount ? product : best)] : [];
    }),
  ]);
  const usd = products.filter((product) => product.currency === "USD");
  if (!usd.length) return undefined;
  const total = usd.reduce((sum, product) => sum + product.amount, 0);
  return total > 0 ? Math.round(total * 100) / 100 : undefined;
}

function toOption(itinerary: Itinerary): TransitOption | null {
  const usable = itinerary.legs.filter((leg) => !leg.cancelled);
  const transit = usable.filter((leg) => !["WALK", "BIKE", "CAR"].includes(leg.mode));
  if (!transit.length) return null;
  const agencies = [...new Set(transit.map((leg) => leg.agencyName).filter((name): name is string => Boolean(name)))];
  const lines = [...new Set(transit.map(lineName))];
  const intercityRail = transit.some((leg) => /RAIL|TRAIN/.test(leg.mode));
  const coach = transit.some((leg) => leg.mode === "COACH");
  const rail = intercityRail || (!coach && transit.some((leg) => /SUBWAY|TRAM/.test(leg.mode)));
  const realtime = transit.filter((leg) => leg.realTime).length;
  const steps = usable.slice(0, 12).map((leg, index, legs) => {
    const from = leg.from.name || "your current stop";
    const to = leg.to.name || "the next stop";
    const zone = leg.from.tz || leg.to.tz;
    const timing = `${timeText(leg.startTime, zone)}–${timeText(leg.endTime, zone)}`;
    const nextLeg = legs[index + 1];
    if (leg.mode === "WALK") {
      const nextAction = nextLeg && !["WALK", "BIKE", "CAR"].includes(nextLeg.mode)
        ? ` When you arrive, look for ${lineName(nextLeg)} toward ${nextLeg.headsign || nextLeg.tripTo?.name || nextLeg.to.name || "your destination"}.`
        : "";
      return { instruction: `Walk from ${from} to ${to}.${nextAction}`, detail: `Allow ${durationText(leg.duration)} · leave about ${timeText(leg.startTime, zone)} · arrive about ${timeText(leg.endTime, zone)}` };
    }
    const toward = leg.headsign || leg.tripTo?.name || to;
    const agency = leg.agencyName ? ` operated by ${leg.agencyName}` : "";
    const transfer = index > 0 ? `At ${from}, follow station signs for ${lineName(leg)}. ` : "";
    const finish = index === legs.length - 1 ? ` Get off at ${to}; from there, follow local signs toward the event.` : ` Stay aboard until ${to}, then get off for your next connection.`;
    return {
      instruction: `${transfer}Board ${lineName(leg)}${agency} at ${from}, in the direction of ${toward}.${finish}`,
      detail: `Board about ${timeText(leg.startTime, zone)} · get off about ${timeText(leg.endTime, zone)} · ${leg.realTime ? "live timing" : "scheduled timing"}`,
    };
  });
  const total = fareTotal(itinerary);
  return {
    mode: rail ? "train" : "bus",
    title: `Public transit via ${lines.slice(0, 4).join(" + ")}`.slice(0, 120),
    durationMinutes: minutes(itinerary.duration),
    durationText: `${durationText(itinerary.duration)} · ${itinerary.transfers} transfer${itinerary.transfers === 1 ? "" : "s"}`,
    sourceUrl: ATTRIBUTION_URL,
    sourceQuote: `Live GTFS itinerary with ${realtime} real-time transit leg${realtime === 1 ? "" : "s"}; remaining times are scheduled.`,
    steps,
    agencies,
    amountUsd: total,
    fareQuote: total ? `Transitous GTFS fare products total $${total.toFixed(2)}.` : undefined,
  };
}

export function transitOptionsFrom(body: TransitPlanPayload) {
  const seen = new Set<string>();
  return (body.itineraries ?? [])
    .sort((a, b) => a.duration - b.duration)
    .map(toOption)
    .filter((option): option is TransitOption => Boolean(option))
    .filter((option) => {
      const signature = option.steps.map((step) => step.instruction).join("|");
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    })
    .slice(0, 4);
}

export async function planPublicTransit(args: { from: { lat: number; lon: number }; to: { lat: number; lon: number }; startsAt?: string; includeFares?: boolean }): Promise<TransitPlanResult> {
  const now = new Date();
  const kickoff = args.startsAt ? new Date(args.startsAt) : undefined;
  const futureKickoff = kickoff && Number.isFinite(kickoff.getTime()) && kickoff.getTime() > now.getTime() + 45 * 60_000;
  const targetTime = futureKickoff ? new Date(kickoff!.getTime() - 30 * 60_000) : now;
  const params = new URLSearchParams({
    fromPlace: `${args.from.lat},${args.from.lon}`,
    toPlace: `${args.to.lat},${args.to.lon}`,
    time: targetTime.toISOString(),
    arriveBy: String(Boolean(futureKickoff)),
    withFares: String(args.includeFares !== false),
    numItineraries: "6",
    maxTransfers: "5",
    detailedTransfers: "true",
    realtimeMode: "REALTIME",
  });
  const url = `${API}?${params}`;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9_000);
  try {
    const response = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (!response.ok) return { status: "error", url, options: [], ms: Date.now() - t0, error: `Transitous returned HTTP ${response.status}` };
    const body = (await response.json()) as TransitPlanPayload;
    const options = transitOptionsFrom(body);
    return { status: options.length ? "ok" : "empty", url, options, ms: Date.now() - t0, error: options.length ? undefined : "No public-transit itinerary was returned for this time." };
  } catch (error) {
    const timedOut = (error as Error).name === "AbortError" || (error as Error).name === "TimeoutError";
    return { status: timedOut ? "timeout" : "error", url, options: [], ms: Date.now() - t0, error: timedOut ? "Live public-transit routing took longer than 9 seconds." : (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
