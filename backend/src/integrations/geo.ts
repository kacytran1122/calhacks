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

const zipCache = new Map<string, GeoResult>();

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
  const cached = zipCache.get(zip);
  if (cached) return cached;
  const r = await getJson(url, 4_000);
  if (!r.ok) return { status: r.status === 404 ? "empty" : r.error === "timeout" ? "timeout" : "error", source, url, error: r.error ?? `HTTP ${r.status}` };
  const place = (r.json as { places?: { latitude: string; longitude: string; "place name": string; "state abbreviation": string }[] }).places?.[0];
  if (!place) return { status: "empty", source, url };
  const result = { status: "ok" as const, lat: Number(place.latitude), lon: Number(place.longitude), label: `${place["place name"]}, ${place["state abbreviation"]}`, postalCode: zip, source, url };
  zipCache.set(zip, result);
  return result;
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

export async function coordinatesToPoint(lat: number, lon: number): Promise<GeoResult> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=16&addressdetails=1`;
  const source = "OpenStreetMap reverse geocoder";
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { status: "error", source, url, error: "invalid coordinates" };
  }
  const r = await getJson(url, 15_000);
  if (!r.ok) return coordinatesToPointFallback(lat, lon);
  type Address = { postcode?: string; city?: string; town?: string; village?: string; municipality?: string; county?: string; state?: string; "ISO3166-2-lvl4"?: string; country_code?: string };
  const address = (r.json as { address?: Address }).address;
  const postalCode = address?.postcode?.match(/\b\d{5}\b/)?.[0];
  if (!address || address.country_code?.toLowerCase() !== "us") {
    return coordinatesToPointFallback(lat, lon);
  }
  const city = address.city ?? address.town ?? address.village ?? address.municipality ?? address.county;
  const state = address["ISO3166-2-lvl4"]?.replace(/^US-/, "") ?? address.state;
  return { status: "ok", lat, lon, postalCode, label: [city, state].filter(Boolean).join(", ") || postalCode || "GPS location", source, url };
}

async function coordinatesToPointFallback(lat: number, lon: number): Promise<GeoResult> {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&localityLanguage=en`;
  const source = "BigDataCloud reverse geocoder";
  const r = await getJson(url, 5_000);
  if (!r.ok) return { status: r.error === "timeout" ? "timeout" : "error", source, url, error: r.error ?? `HTTP ${r.status}` };
  type Place = { locality?: string; city?: string; principalSubdivision?: string; principalSubdivisionCode?: string; postcode?: string; countryCode?: string };
  const place = r.json as Place;
  if (place.countryCode?.toUpperCase() !== "US") return { status: "empty", source, url, error: "no U.S. location found at these coordinates" };
  const city = place.locality ?? place.city;
  const state = place.principalSubdivisionCode?.replace(/^US-/, "") ?? place.principalSubdivision;
  const postalCode = place.postcode?.match(/\b\d{5}\b/)?.[0];
  return { status: "ok", lat, lon, postalCode, label: [city, state].filter(Boolean).join(", ") || postalCode || "GPS location", source, url };
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

const STATE_ANCHORS: Record<string, [string, string]> = {
  AL: ["Montgomery", "36104"], AK: ["Juneau", "99801"], AZ: ["Phoenix", "85003"], AR: ["Little Rock", "72201"], CA: ["Sacramento", "95814"],
  CO: ["Denver", "80202"], CT: ["Hartford", "06103"], DE: ["Dover", "19901"], DC: ["Washington", "20001"], FL: ["Tallahassee", "32301"],
  GA: ["Atlanta", "30303"], HI: ["Honolulu", "96813"], ID: ["Boise", "83702"], IL: ["Springfield", "62701"], IN: ["Indianapolis", "46204"],
  IA: ["Des Moines", "50309"], KS: ["Topeka", "66603"], KY: ["Frankfort", "40601"], LA: ["Baton Rouge", "70802"], ME: ["Augusta", "04330"],
  MD: ["Annapolis", "21401"], MA: ["Boston", "02108"], MI: ["Lansing", "48933"], MN: ["Saint Paul", "55101"], MS: ["Jackson", "39201"],
  MO: ["Jefferson City", "65101"], MT: ["Helena", "59601"], NE: ["Lincoln", "68508"], NV: ["Carson City", "89701"], NH: ["Concord", "03301"],
  NJ: ["Trenton", "08608"], NM: ["Santa Fe", "87501"], NY: ["Albany", "12207"], NC: ["Raleigh", "27601"], ND: ["Bismarck", "58501"],
  OH: ["Columbus", "43215"], OK: ["Oklahoma City", "73102"], OR: ["Salem", "97301"], PA: ["Harrisburg", "17101"], RI: ["Providence", "02903"],
  SC: ["Columbia", "29201"], SD: ["Pierre", "57501"], TN: ["Nashville", "37219"], TX: ["Austin", "78701"], UT: ["Salt Lake City", "84111"],
  VT: ["Montpelier", "05602"], VA: ["Richmond", "23219"], WA: ["Olympia", "98501"], WV: ["Charleston", "25301"], WI: ["Madison", "53703"], WY: ["Cheyenne", "82001"],
};

export function isLikelyUsLocation(location: string): boolean {
  const region = location.split(",").at(-1)?.trim().toLowerCase() ?? "";
  return Boolean(STATES[region] || (region.length === 2 && STATE_ANCHORS[region.toUpperCase()]));
}

const cityCache = new Map<string, GeoResult>();
const placeCache = new Map<string, GeoResult>();
const globalPlaceCache = new Map<string, GeoResult>();

export async function globalPlaceToPoint(location: string): Promise<GeoResult> {
  const key = location.trim().toLowerCase();
  if (/^\d{5}$/.test(key)) return zipToPoint(key);
  const cached = globalPlaceCache.get(key);
  if (cached) return cached;
  const source = "OpenStreetMap place lookup";
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(location)}`;
  if (key.length < 2) return { status: "empty", source, url, error: "location is too short" };
  const r = await getJson(url, 5_000);
  type Place = { lat: string; lon: string; display_name: string; address?: { postcode?: string } };
  const places = r.ok && Array.isArray(r.json) ? r.json as Place[] : [];
  const place = places.find((candidate) => Number.isFinite(Number(candidate.lat)) && Number.isFinite(Number(candidate.lon)));
  const out: GeoResult = place
    ? { status: "ok", lat: Number(place.lat), lon: Number(place.lon), label: place.display_name, postalCode: place.address?.postcode, source, url }
    : { status: r.ok ? "empty" : r.error === "timeout" ? "timeout" : "error", source, url, error: r.error ?? (r.ok ? "no matching place" : `HTTP ${r.status}`) };
  globalPlaceCache.set(key, out);
  return out;
}

async function arcGisPlaceToPoint(location: string): Promise<GeoResult> {
  const source = "ArcGIS World Geocoding service";
  const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?SingleLine=${encodeURIComponent(location)}&countryCode=USA&maxLocations=5&outFields=Addr_type,City,Region,Postal,CountryCode&f=json`;
  const r = await getJson(url, 5_000);
  type Candidate = { address: string; score: number; location: { x: number; y: number }; attributes?: { Postal?: string; CountryCode?: string } };
  const candidates = r.ok ? ((r.json as { candidates?: Candidate[] }).candidates ?? []) : [];
  const candidate = candidates.find((item) => item.score >= 70 && Number.isFinite(item.location?.x) && Number.isFinite(item.location?.y));
  return candidate
    ? { status: "ok", lat: candidate.location.y, lon: candidate.location.x, label: candidate.address, postalCode: candidate.attributes?.Postal?.match(/\b\d{5}\b/)?.[0], source, url }
    : { status: r.ok ? "empty" : r.error === "timeout" ? "timeout" : "error", source, url, error: r.error ?? (r.ok ? "no such U.S. place" : `HTTP ${r.status}`) };
}

export async function placeToPoint(location: string): Promise<GeoResult> {
  const key = location.trim().toLowerCase();
  const cached = placeCache.get(key);
  if (cached) return cached;
  const source = "OpenStreetMap U.S. place lookup";
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=us&addressdetails=1&limit=5&q=${encodeURIComponent(location)}`;
  if (key.length < 2) return { status: "empty", source, url, error: "location is too short" };
  const r = await getJson(url, 5_000);
  type Place = { lat: string; lon: string; display_name: string; address?: { postcode?: string; country_code?: string } };
  const places = r.ok && Array.isArray(r.json) ? r.json as Place[] : [];
  const place = places.find((candidate) => candidate.address?.country_code?.toLowerCase() === "us") ?? places[0];
  const out: GeoResult = place
    ? { status: "ok", lat: Number(place.lat), lon: Number(place.lon), label: place.display_name, postalCode: place.address?.postcode?.match(/\b\d{5}\b/)?.[0], source, url }
    : await arcGisPlaceToPoint(location);
  placeCache.set(key, out);
  return out;
}

async function cityInState(city: string, state: string): Promise<GeoResult> {
  const url = `https://api.zippopotam.us/us/${state.toLowerCase()}/${encodeURIComponent(city.toLowerCase())}`;
  const source = "Zippopotam.us city lookup";
  const r = await getJson(url, 3_000);
  type P = { "place name": string; latitude: string; longitude: string; "post code": string };
  const places = r.ok ? ((r.json as { places?: P[] }).places ?? []) : [];
  const exact = places.find((p) => p["place name"].toLowerCase() === city.toLowerCase()) ?? places[0];
  return exact
    ? { status: "ok", lat: Number(exact.latitude), lon: Number(exact.longitude), label: `${exact["place name"]}, ${state}`, postalCode: exact["post code"], source, url }
    : { status: r.ok ? "empty" : "error", source, url, error: r.error ?? (r.ok ? "no such city" : `HTTP ${r.status}`) };
}

export async function cityToPoint(location: string): Promise<GeoResult> {
  const key = location.trim().toLowerCase();
  const cached = cityCache.get(key);
  if (cached) return cached;
  const stateOnly = STATES[key] ?? (key.length === 2 && STATE_ANCHORS[key.toUpperCase()] ? key.toUpperCase() : undefined);
  if (stateOnly) {
    const [city, zip] = STATE_ANCHORS[stateOnly]!;
    const point = await zipToPoint(zip);
    const out = point.status === "ok" ? { ...point, label: `${city}, ${stateOnly}`, source: "U.S. state center lookup" } : point;
    cityCache.set(key, out);
    return out;
  }
  const [cityRaw, stateRaw] = location.split(",").map((x) => x.trim());
  const st = stateRaw ? (stateRaw.length === 2 ? stateRaw.toUpperCase() : STATES[stateRaw.toLowerCase()]) : undefined;
  if (cityRaw && st) {
    const out = await cityInState(cityRaw, st);
    cityCache.set(key, out);
    return out;
  }
  const exactPlace = await placeToPoint(location);
  if (exactPlace.status === "ok" && exactPlace.postalCode) {
    cityCache.set(key, exactPlace);
    return exactPlace;
  }
  const source = "OpenStreetMap U.S. place lookup";
  if (key.length < 3) return { status: "empty", source, url: "", error: "location is too short" };
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=us&addressdetails=1&limit=5&q=${encodeURIComponent(location)}`;
  const r = await getJson(url, 5_000);
  type Place = { name?: string; lat: string; lon: string; display_name: string; address?: { city?: string; town?: string; village?: string; municipality?: string; state?: string; country_code?: string } };
  const places = r.ok && Array.isArray(r.json) ? r.json as Place[] : [];
  const place = places.find((candidate) => candidate.address?.country_code?.toLowerCase() === "us") ?? places[0];
  const placeState = place?.address?.state ? STATES[place.address.state.toLowerCase()] : undefined;
  const placeCity = place?.address?.city ?? place?.address?.town ?? place?.address?.village ?? place?.address?.municipality ?? place?.name;
  const out = placeCity && placeState
    ? await cityInState(placeCity, placeState)
    : { status: r.ok ? "empty" : "error", source, url, error: r.error ?? (r.ok ? "no such U.S. place" : `HTTP ${r.status}`) } as GeoResult;
  cityCache.set(key, out);
  return out;
}
