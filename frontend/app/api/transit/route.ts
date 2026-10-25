import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const TRANSITOUS = process.env.TRANSITOUS_BASE_URL?.trim() || "https://api.transitous.org/api/v6/plan";
const USER_AGENT = "SmileDirections/1.0 (+https://smilefromhereto.work/map)";

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): value is JsonRecord => Boolean(value && typeof value === "object" && !Array.isArray(value));

function coordinate(value: string | null): [number, number] | null {
  const parts = String(value ?? "").split(",").map(Number);
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
    modes: Array.isArray(source.modes) ? source.modes.filter((mode): mode is string => typeof mode === "string") : [],
  };
}

function leg(value: unknown) {
  const source = record(value) ? value : {};
  const rawGeometry = record(source.legGeometry) ? source.legGeometry : null;
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
    geometry: rawGeometry ? {
      points: text(rawGeometry.points),
      precision: number(rawGeometry.precision) ?? 6,
      length: number(rawGeometry.length),
    } : null,
  };
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
    withFares: "true",
    numItineraries: "4",
    maxTransfers: "5",
    detailedTransfers: "true",
    realtimeMode: "REALTIME",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${TRANSITOUS}?${params}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      cache: "no-store",
    });
    if (!response.ok) return NextResponse.json({ error: `Transit service returned ${response.status}.` }, { status: 502 });
    const payload: unknown = await response.json();
    const source = record(payload) ? payload : {};
    const itineraries = (Array.isArray(source.itineraries) ? source.itineraries : []).slice(0, 4).map((value) => {
      const itinerary = record(value) ? value : {};
      return {
        duration: number(itinerary.duration),
        startTime: text(itinerary.startTime),
        endTime: text(itinerary.endTime),
        transfers: number(itinerary.transfers),
        legs: (Array.isArray(itinerary.legs) ? itinerary.legs : []).map(leg).filter((item) => !item.cancelled),
      };
    });
    return NextResponse.json(
      { itineraries, source: "Transitous public GTFS and GTFS-Realtime" },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error && error.name === "AbortError" ? "Transit routing timed out." : "Transit routing is temporarily unavailable." },
      { status: 504 },
    );
  } finally {
    clearTimeout(timer);
  }
}
