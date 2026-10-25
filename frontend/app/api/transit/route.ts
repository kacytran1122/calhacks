import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const TRANSITOUS = process.env.TRANSITOUS_BASE_URL?.trim() || "https://api.transitous.org/api/v6/plan";
const USER_AGENT = "SmileDirections/1.0 (+https://smilefromhereto.work/map)";

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): value is JsonRecord => Boolean(value && typeof value === "object" && !Array.isArray(value));

function coordinate(value: string | null): [number, number] | null {
  const tokens = String(value ?? "").split(",");
  if (tokens.some((token) => !token.trim())) return null;
  const parts = tokens.map(Number);
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  if (Math.abs(parts[0]) > 90 || Math.abs(parts[1]) > 180) return null;
  return [parts[0], parts[1]];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function place(value: unknown) {
  const source = record(value) ? value : {};
  return {
    name: text(source.name),
    lat: number(source.lat),
    lon: number(source.lon),
    tz: text(source.tz),
    stopId: text(source.stopId),
    stopCode: text(source.stopCode),
    cancelled: Boolean(source.cancelled),
    modes: Array.isArray(source.modes) ? source.modes.filter((mode): mode is string => typeof mode === "string") : [],
  };
}

function leg(value: unknown) {
  const source = record(value) ? value : {};
  const rawGeometry = record(source.legGeometry) ? source.legGeometry : record(source.geometry) ? source.geometry : null;
  return {
    mode: text(source.mode),
    from: place(source.from),
    to: place(source.to),
    duration: number(source.duration),
    distance: number(source.distance),
    startTime: text(source.startTime),
    endTime: text(source.endTime),
    realTime: Boolean(source.realTime),
    cancelled: Boolean(source.cancelled),
    headsign: text(source.headsign),
    routeShortName: text(source.routeShortName),
    routeLongName: text(source.routeLongName),
    displayName: text(source.displayName),
    agencyName: text(source.agencyName),
    routeColor: text(source.routeColor),
    tripId: text(source.tripId),
    routeId: text(source.routeId),
    geometry: rawGeometry ? {
      points: text(rawGeometry.points),
      precision: number(rawGeometry.precision) ?? 6,
      length: number(rawGeometry.length),
    } : null,
  };
}

function routePattern(itinerary: { legs: ReturnType<typeof leg>[] }) {
  return JSON.stringify(itinerary.legs.filter((item) => !["WALK", "BIKE"].includes(item.mode || "")).map((item) => [item.mode, item.agencyName, item.displayName || item.routeShortName || item.routeLongName, item.from.stopId || item.from.name, item.to.stopId || item.to.name]));
}

function usableItineraries(payload: unknown) {
  const source = record(payload) ? payload : {};
  const seen = new Set<string>();
  const candidates = (Array.isArray(source.itineraries) ? source.itineraries : []).flatMap((value) => {
    if (!record(value) || !Array.isArray(value.legs) || !value.legs.length || value.legs.some((item) => !record(item) || !record(item.from) || !record(item.to))) return [];
    const legs = value.legs.map(leg);
    if (legs.some((item) => item.cancelled || item.from.cancelled || item.to.cancelled || !item.mode || /^(?:CAR(?:_.*)?|HGV)$/.test(item.mode))) return [];
    if (!legs.some((item) => !["WALK", "BIKE"].includes(item.mode || ""))) return [];
    const startTime = text(value.startTime);
    const endTime = text(value.endTime);
    const elapsed = (Date.parse(endTime || "") - Date.parse(startTime || "")) / 1000;
    const duration = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : number(value.duration);
    if (duration === null || duration <= 0) return [];
    const itinerary = { duration, startTime, endTime, transfers: number(value.transfers), legs };
    const key = JSON.stringify([startTime, endTime, legs.map((item) => [item.mode, item.from.stopId || item.from.name, item.to.stopId || item.to.name, item.startTime, item.endTime, item.displayName || item.routeShortName || item.routeLongName, item.agencyName, item.tripId, item.routeId])]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [itinerary];
  }).sort((a, b) => a.duration - b.duration);
  const patterns = new Set<string>();
  const varied = candidates.filter((item) => {
    const pattern = routePattern(item);
    if (patterns.has(pattern)) return false;
    patterns.add(pattern);
    return true;
  });
  return [...varied, ...candidates.filter((item) => !varied.includes(item))].slice(0, 4).sort((a, b) => a.duration - b.duration);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const from = coordinate(url.searchParams.get("from"));
  const to = coordinate(url.searchParams.get("to"));
  if (!from || !to) return NextResponse.json({ error: "Valid from and to coordinates are required." }, { status: 400 });

  const requested = new Date(url.searchParams.get("time") || Date.now());
  const time = Number.isFinite(requested.getTime()) ? requested : new Date();
  const params = new URLSearchParams({
    fromPlace: `${from[0]},${from[1]}`,
    toPlace: `${to[0]},${to[1]}`,
    time: time.toISOString(),
    arriveBy: "false",
    withFares: "false",
    numItineraries: "6",
    maxTransfers: "5",
    detailedTransfers: "true",
    realtimeMode: "REALTIME",
    timetableView: "true",
    transitModes: "TRANSIT",
    directModes: "",
    preTransitModes: "WALK",
    postTransitModes: "WALK",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9_000);
  let itineraries: ReturnType<typeof usableItineraries> = [];
  const reply = (note?: string) => NextResponse.json(
    { itineraries, source: "Transitous public GTFS and GTFS-Realtime", ...(note ? { note } : {}) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
  try {
    const response = await fetch(`${TRANSITOUS}?${params}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      cache: "no-store",
    });
    if (!response.ok) return NextResponse.json({ error: `Transit service returned ${response.status}.` }, { status: 502 });
    const payload: unknown = await response.json();
    itineraries = usableItineraries(payload);
    if (new Set(itineraries.map(routePattern)).size < 2 && !controller.signal.aborted) {
      const alternativeParams = new URLSearchParams(params);
      alternativeParams.set("transitModes", "BUS,COACH");
      const alternative = await fetch(`${TRANSITOUS}?${alternativeParams}`, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": USER_AGENT }, cache: "no-store" });
      if (alternative.ok) {
        const additional = usableItineraries(await alternative.json());
        itineraries = usableItineraries({ itineraries: [...itineraries, ...additional] });
      } else if (itineraries.length) return reply("Available transit routes are shown, but the additional bus and coach search could not be completed.");
    }
    return reply();
  } catch (error) {
    if (itineraries.length) return reply("Available transit routes are shown, but the additional bus and coach search reached its time limit or was unavailable.");
    return NextResponse.json(
      { error: error instanceof Error && error.name === "AbortError" ? "Transit routing timed out." : "Transit routing is temporarily unavailable." },
      { status: 504 },
    );
  } finally {
    clearTimeout(timer);
  }
}
