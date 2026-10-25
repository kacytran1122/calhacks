const TRANSITOUS = "https://api.transitous.org/api/v6/plan";
const USER_AGENT = "LiveDirections/1.0 (+https://github.com/kacytran1122/calhacks)";

function coordinate(value) {
  const parts = String(value || "").split(",").map(Number);
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  if (Math.abs(parts[0]) > 90 || Math.abs(parts[1]) > 180) return null;
  return parts;
}

function place(place = {}) {
  return {
    name: place.name || null,
    lat: place.lat,
    lon: place.lon,
    tz: place.tz || null,
    stopId: place.stopId || null,
    stopCode: place.stopCode || null,
    modes: place.modes || [],
  };
}

function leg(leg = {}) {
  return {
    mode: leg.mode,
    from: place(leg.from),
    to: place(leg.to),
    duration: leg.duration,
    distance: leg.distance || null,
    startTime: leg.startTime,
    endTime: leg.endTime,
    realTime: Boolean(leg.realTime),
    cancelled: Boolean(leg.cancelled),
    headsign: leg.headsign || null,
    routeShortName: leg.routeShortName || null,
    routeLongName: leg.routeLongName || null,
    displayName: leg.displayName || null,
    agencyName: leg.agencyName || null,
    routeColor: leg.routeColor || null,
    geometry: leg.legGeometry ? {
      points: leg.legGeometry.points,
      precision: leg.legGeometry.precision || 6,
      length: leg.legGeometry.length || null,
    } : null,
  };
}

export async function transitResponse(requestUrl, method = "GET") {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (method === "OPTIONS") return { status: 204, headers: cors, body: "" };
  if (method !== "GET") return { status: 405, headers: cors, body: JSON.stringify({ error: "GET required" }) };
  const url = new URL(requestUrl, "http://localhost");
  const from = coordinate(url.searchParams.get("from"));
  const to = coordinate(url.searchParams.get("to"));
  if (!from || !to) return { status: 400, headers: cors, body: JSON.stringify({ error: "Valid from and to coordinates are required." }) };
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
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${TRANSITOUS}?${params}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      return { status: 502, headers: cors, body: JSON.stringify({ error: `Transit service returned ${response.status}.` }) };
    }
    const payload = await response.json();
    const itineraries = (payload.itineraries || []).slice(0, 4).map((itinerary) => ({
      duration: itinerary.duration,
      startTime: itinerary.startTime,
      endTime: itinerary.endTime,
      transfers: itinerary.transfers,
      legs: (itinerary.legs || []).filter((item) => !item.cancelled).map(leg),
    }));
    return {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
      body: JSON.stringify({ itineraries, source: "Transitous public GTFS and GTFS-Realtime" }),
    };
  } catch (error) {
    const message = error?.name === "AbortError" ? "Transit routing timed out." : "Transit routing is temporarily unavailable.";
    return { status: 504, headers: cors, body: JSON.stringify({ error: message }) };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(request, response) {
  const result = await transitResponse(request.url, request.method);
  Object.entries(result.headers).forEach(([key, value]) => response.setHeader(key, value));
  response.status(result.status).send(result.body);
}
