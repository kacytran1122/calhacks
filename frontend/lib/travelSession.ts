export type TravelOrigin = {
  zip: string;
  label: string;
  coordinates?: { lat: number; lon: number };
  enteredOrigin?: { zip: string; label: string };
};

export type TravelSession = { origin: TravelOrigin; locationExpired: boolean };

const STORAGE_KEY = "smile.travel-origin.v1";
let rememberedOrigin: TravelOrigin | null = null;
let rememberedActive = false;

function cleanLabel(value: unknown, fallback: string) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || fallback : fallback;
}

function validCoordinates(lat: unknown, lon: unknown): lat is number {
  return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

export function rememberTravelOrigin(origin: TravelOrigin) {
  if (!/^\d{5}$/.test(origin.zip)) return;
  const label = cleanLabel(origin.label, origin.zip);
  const coordinates = origin.coordinates && validCoordinates(origin.coordinates.lat, origin.coordinates.lon) ? { ...origin.coordinates } : undefined;
  const fallback = origin.enteredOrigin && /^\d{5}$/.test(origin.enteredOrigin.zip)
    ? { zip: origin.enteredOrigin.zip, label: cleanLabel(origin.enteredOrigin.label, origin.enteredOrigin.zip) }
    : { zip: origin.zip, label: label === "Current location" ? origin.zip : label };
  rememberedOrigin = { zip: origin.zip, label, ...(coordinates ? { coordinates } : {}), ...(origin.enteredOrigin ? { enteredOrigin: fallback } : {}) };
  rememberedActive = true;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, active: true, ...fallback, usedDeviceLocation: Boolean(origin.enteredOrigin) }));
  } catch {}
}

export function restoreTravelSession(): TravelSession | null {
  if (rememberedOrigin) return rememberedActive ? { origin: rememberedOrigin, locationExpired: false } : null;
  try {
    const saved: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return null;
    const value = saved as Record<string, unknown>;
    if (value.version !== 1 || value.active !== true || typeof value.zip !== "string" || !/^\d{5}$/.test(value.zip)) return null;
    const label = cleanLabel(value.label, value.zip);
    const origin = { zip: value.zip, label: label === "Current location" ? value.zip : label };
    return { origin, locationExpired: value.usedDeviceLocation === true };
  } catch {
    return null;
  }
}

export function setTravelViewActive(active: boolean) {
  rememberedActive = active;
  try {
    const saved: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object") window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, active }));
  } catch {}
}

export function clearTravelSession() {
  expireTravelMemory();
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function expireTravelMemory() {
  rememberedOrigin = null;
  rememberedActive = false;
}

export function legacyTravelOrigin(params: URLSearchParams): TravelOrigin | null {
  const zip = params.get("zip") ?? "";
  if (!/^\d{5}$/.test(zip)) return null;
  const rawLat = params.get("lat");
  const rawLon = params.get("lon");
  const lat = rawLat === null || !rawLat.trim() ? NaN : Number(rawLat);
  const lon = rawLon === null || !rawLon.trim() ? NaN : Number(rawLon);
  const label = cleanLabel(params.get("origin"), zip);
  if (validCoordinates(lat, lon)) return { zip, label: "Current location", coordinates: { lat, lon }, enteredOrigin: { zip, label: label === "Current location" ? zip : label } };
  return { zip, label: label === "Current location" ? zip : label };
}
