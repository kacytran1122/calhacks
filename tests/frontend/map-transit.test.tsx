import { afterEach, expect, test, vi } from "vitest";
import { GET } from "../../frontend/app/api/transit/route";
import { itineraryDurationSeconds, onwardTransitTime, usableTransitItineraries } from "../../frontend/public/map-assets/route-utils.js";

const request = () => new Request("https://smilefromhereto.work/api/transit?from=34.07,-118.44&to=33.64,-117.84&time=2027-01-16T17:00:00Z");
const json = (itineraries: unknown[]) => new Response(JSON.stringify({ itineraries }), { status: 200, headers: { "Content-Type": "application/json" } });

function itinerary(mode = "RAIL", line = "Regional train", offsetMinutes = 0) {
  const startTime = new Date(Date.parse("2027-01-16T17:00:00Z") + offsetMinutes * 60_000).toISOString();
  const endTime = new Date(Date.parse(startTime) + 7_200_000).toISOString();
  return { duration: 7200, startTime, endTime, transfers: 0, legs: [{ mode, displayName: line, agencyName: "Public operator", from: { name: "Origin Station", lat: 34.07, lon: -118.44 }, to: { name: "Venue Station", lat: 33.64, lon: -117.84 }, duration: 7200, startTime, endTime, realTime: false, legGeometry: { points: "_p~iF~ps|U_ulLnnqC_mqNvxq`@", precision: 5 } }] };
}

afterEach(() => vi.useRealTimers());

test("the map API searches real bus alternatives with one shared non-driving time budget", async () => {
  const calls: { url: URL; signal?: AbortSignal | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), signal: init?.signal });
    return json([calls.length === 1 ? itinerary() : itinerary("COACH", "Intercity coach", 15)]);
  }));
  const response = await GET(request());
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(2);
  expect(calls[0].signal).toBe(calls[1].signal);
  expect(calls[0].url.searchParams.get("transitModes")).toBe("TRANSIT");
  expect(calls[1].url.searchParams.get("transitModes")).toBe("BUS,COACH");
  for (const call of calls) {
    expect(call.url.searchParams.get("preTransitModes")).toBe("WALK");
    expect(call.url.searchParams.get("postTransitModes")).toBe("WALK");
    expect(call.url.searchParams.get("directModes")).toBe("");
    expect(call.url.searchParams.get("timetableView")).toBe("true");
    expect(call.url.searchParams.get("withFares")).toBe("false");
  }
  expect(body.itineraries.map((item: { legs: { mode: string }[] }) => item.legs[0].mode)).toEqual(["RAIL", "COACH"]);
  expect(body.itineraries[0].legs[0].geometry.points).toBeTruthy();
  expect(response.headers.get("cache-control")).toContain("no-store");
});

test("the map retains distinct departures but does not duplicate an identical result", async () => {
  const first = itinerary();
  const later = itinerary("RAIL", "Regional train", 30);
  const fetcher = vi.fn(async () => json([first, first, later]));
  vi.stubGlobal("fetch", fetcher);
  const body = await (await GET(request())).json();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(body.itineraries).toHaveLength(2);
  expect(body.itineraries[0].startTime).not.toBe(body.itineraries[1].startTime);
  expect(usableTransitItineraries([first, first, later])).toHaveLength(2);
});

test("multiple real route patterns avoid a redundant bus search", async () => {
  const fetcher = vi.fn(async () => json([itinerary(), itinerary("BUS", "Express bus")]));
  vi.stubGlobal("fetch", fetcher);
  const body = await (await GET(request())).json();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(body.itineraries).toHaveLength(2);
});

test("an empty timetable search can still return a real coach alternative", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => json(++calls === 1 ? [] : [itinerary("COACH", "Intercity coach")])));
  const body = await (await GET(request())).json();
  expect(calls).toBe(2);
  expect(body.itineraries).toHaveLength(1);
  expect(body.itineraries[0].legs[0].mode).toBe("COACH");
});

test("mode diversity survives the result limit without adding invented routes", async () => {
  let calls = 0;
  const departures = [0, 15, 30, 45].map((offset) => itinerary("RAIL", "Regional train", offset));
  vi.stubGlobal("fetch", vi.fn(async () => json(++calls === 1 ? departures : [itinerary("COACH", "Intercity coach")])));
  const body = await (await GET(request())).json();
  expect(calls).toBe(2);
  expect(body.itineraries).toHaveLength(4);
  expect(body.itineraries.some((item: { legs: { mode: string }[] }) => item.legs[0].mode === "COACH")).toBe(true);
});

test("cancelled and self-drive legs invalidate the whole map itinerary without creating gaps", async () => {
  const base = itinerary();
  const cancelled = { ...base, legs: [...base.legs, { ...base.legs[0], cancelled: true }] };
  const closedStop = { ...base, legs: [{ ...base.legs[0], from: { ...base.legs[0].from, cancelled: true } }] };
  const car = { ...base, legs: [{ ...base.legs[0], mode: "CAR_PARKING" }, ...base.legs] };
  const fetcher = vi.fn(async () => json([cancelled, closedStop, car, base]));
  vi.stubGlobal("fetch", fetcher);
  const body = await (await GET(request())).json();
  expect(body.itineraries).toHaveLength(1);
  expect(body.itineraries[0].legs).toHaveLength(1);
  expect(body.itineraries[0].legs[0].mode).toBe("RAIL");
  expect(usableTransitItineraries([cancelled, closedStop, car])).toEqual([]);
});

test("a slow secondary search keeps the verified first map route within nine seconds", async () => {
  vi.useFakeTimers();
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) return json([itinerary()]);
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  }));
  const pending = GET(request());
  await vi.advanceTimersByTimeAsync(9_001);
  const response = await pending;
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(calls).toBe(2);
  expect(body.itineraries).toHaveLength(1);
  expect(body.note).toMatch(/time limit|unavailable/i);
});

test("map elapsed times include waits and onward searches start after the actual arrival", () => {
  const route = { startTime: "2027-01-16T17:00:00Z", endTime: "2027-01-16T19:00:00Z", duration: 3600, segments: [{ duration: 1800 }, { duration: 1800 }] };
  expect(itineraryDurationSeconds(route)).toBe(7200);
  expect(onwardTransitTime(route, new Date(route.startTime)).toISOString()).toBe("2027-01-16T19:05:00.000Z");
  expect(itineraryDurationSeconds({ duration: 300, segments: [{ duration: 180 }] })).toBe(300);
});

test("blank coordinates are rejected before any upstream request", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const response = await GET(new Request("https://smilefromhereto.work/api/transit?from=,&to=33,-117"));
  expect(response.status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
