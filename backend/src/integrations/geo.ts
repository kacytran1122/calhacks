import type { FetchStatus } from "../types";

export interface GeoResult {
  status: FetchStatus;
  lat?: number;
  lon?: number;
  label?: string;
  postalCode?: string;
  source: string;
  url: string;
  error?: string;
}

async function getJson(url: string, timeoutMs = 12_000): Promise<{ ok: boolean; status: number; json?: unknown; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": `smile-desk (${process.env.NWS_CONTACT ?? "hackathon"})` } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, json: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

export async function zipToPoint(zip: string): Promise<GeoResult> {
  const url = `https://api.zippopotam.us/us/${encodeURIComponent(zip)}`;
  const source = "Zippopotam.us ZIP lookup";
  if (!/^\d{5}$/.test(zip)) return { status: "error", source, url, error: "ZIP must be 5 digits" };
  const r = await getJson(url);
  if (!r.ok) return { status: r.status === 404 ? "empty" : r.error === "timeout" ? "timeout" : "error", source, url, error: r.error ?? `HTTP ${r.status}` };
  const place = (r.json as { places?: { latitude: string; longitude: string; "place name": string; "state abbreviation": string }[] }).places?.[0];
  if (!place) return { status: "empty", source, url };
  return { status: "ok", lat: Number(place.latitude), lon: Number(place.longitude), label: `${place["place name"]}, ${place["state abbreviation"]}`, postalCode: zip, source, url };
}

export async function addressToPoint(address: string): Promise<GeoResult> {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
  const source = "U.S. Census Bureau geocoder";
  const r = await getJson(url, 15_000);
  if (!r.ok) return { status: r.error === "timeout" ? "timeout" : "error", source, url, error: r.error ?? `HTTP ${r.status}` };
  const m = (r.json as { result?: { addressMatches?: { coordinates: { x: number; y: number }; matchedAddress: string }[] } }).result?.addressMatches?.[0];
  if (!m) return { status: "empty", source, url, error: "no address match" };
  return { status: "ok", lat: m.coordinates.y, lon: m.coordinates.x, label: m.matchedAddress, source, url };
}

export function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export { getJson };

const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

const cityCache = new Map<string, GeoResult>();

export async function cityToPoint(location: string): Promise<GeoResult> {
  const key = location.trim().toLowerCase();
  const cached = cityCache.get(key);
  if (cached) return cached;
  const [cityRaw, stateRaw] = location.split(",").map((x) => x.trim());
  const st = stateRaw ? (stateRaw.length === 2 ? stateRaw.toUpperCase() : STATES[stateRaw.toLowerCase()]) : undefined;
  const source = "Zippopotam.us city lookup";
  if (!cityRaw || !st) {
    const r: GeoResult = { status: "empty", source, url: "", error: "not a U.S. city, state" };
    cityCache.set(key, r);
    return r;
  }
  const url = `https://api.zippopotam.us/us/${st.toLowerCase()}/${encodeURIComponent(cityRaw.toLowerCase())}`;
  const r = await getJson(url);
  type P = { "place name": string; latitude: string; longitude: string; "post code": string };
  const places = r.ok ? ((r.json as { places?: P[] }).places ?? []) : [];
  const exact = places.find((p) => p["place name"].toLowerCase() === cityRaw.toLowerCase()) ?? places[0];
  const out: GeoResult = exact
    ? { status: "ok", lat: Number(exact.latitude), lon: Number(exact.longitude), label: `${exact["place name"]}, ${st}`, postalCode: exact["post code"], source, url }
    : { status: r.ok ? "empty" : "error", source, url, error: r.error ?? (r.ok ? "no such city" : `HTTP ${r.status}`) };
  cityCache.set(key, out);
  return out;
}
