/**
 * Heat map around an event venue:
 *
 *   select region -> gather thermal evidence per cell -> propose hotspot candidates
 *   -> deterministic anomaly gate -> severity x confidence -> ranked findings
 *
 * Evidence is the live forecast "feels like"
 * temperature at each grid cell from two independent weather models (GFS and ECMWF,
 * via Open-Meteo). Beyond the 16-day forecast it falls back to the same calendar week
 * in recent years (ERA5 archive) and says so. The numbers are relative
 * evidence for planning, not calibrated measurements, and no model or LLM owns the
 * ranking math below.
 */
import type { FetchStatus } from "../types";

const FORECAST = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const MODELS = ["gfs_seamless", "ecmwf_ifs025"] as const;

/** A cell must be at least this much warmer than the area's median to become a hotspot candidate. */
export const ANOMALY_THRESHOLD_F = 1;

export interface HeatCell {
  lat: number;
  lon: number;
  feelsLikeF: number; // mean of the models (or of past years)
  airTempF: number;
  anomalyF: number; // feelsLike minus the region median
  modelSpreadF: number | null; // |GFS - ECMWF|; null for climatology
  severity: number; // 0..1, NWS heat-index bands
  confidence: number; // 0..1, lead time x model agreement
  rank: number; // severity x confidence, 0 if the anomaly gate rejects the cell
}

export interface HeatMap {
  status: FetchStatus;
  basis: "forecast" | "climatology";
  at: string; // ISO hour the map describes
  center: { lat: number; lon: number };
  radiusMiles: number;
  cells: HeatCell[];
  hotspots: HeatCell[]; // passed the gate, best rank first
  regionMedianF: number | null;
  band: string; // NWS category of the hottest cell
  summary: string;
  method: string[];
  sources: { name: string; url: string }[];
  error?: string;
}

/** NWS heat-index categories, in feels-like °F. */
export function severityFor(feelsLikeF: number): { score: number; band: string } {
  if (feelsLikeF >= 125) return { score: 1, band: "Extreme danger" };
  if (feelsLikeF >= 103) return { score: 0.75 + ((feelsLikeF - 103) / 22) * 0.25, band: "Danger" };
  if (feelsLikeF >= 90) return { score: 0.5 + ((feelsLikeF - 90) / 13) * 0.25, band: "Extreme caution" };
  if (feelsLikeF >= 80) return { score: 0.25 + ((feelsLikeF - 80) / 10) * 0.25, band: "Caution" };
  return { score: Math.max(0, (feelsLikeF - 70) / 10) * 0.25, band: feelsLikeF >= 70 ? "Warm" : "Comfortable" };
}

/** How much to trust a cell: closer forecasts and agreeing models earn more. */
export function confidenceFor(leadDays: number, spreadF: number | null, basis: HeatMap["basis"]): number {
  const lead = basis === "climatology" ? 0.3 : leadDays <= 2 ? 0.9 : leadDays <= 7 ? 0.7 : 0.45;
  const agreement = spreadF === null ? 1 : 1 - Math.min(1, spreadF / 10) * 0.5;
  return Math.round(lead * agreement * 1000) / 1000;
}

export function gridAround(center: { lat: number; lon: number }, radiusMiles: number, size: number) {
  const dLat = radiusMiles / 69;
  const dLon = radiusMiles / (69 * Math.cos((center.lat * Math.PI) / 180));
  const pts: { lat: number; lon: number }[] = [];
  for (let i = 0; i < size; i++)
    for (let j = 0; j < size; j++) {
      const fy = size === 1 ? 0 : (i / (size - 1)) * 2 - 1;
      const fx = size === 1 ? 0 : (j / (size - 1)) * 2 - 1;
      pts.push({ lat: Math.round((center.lat + fy * dLat) * 1e4) / 1e4, lon: Math.round((center.lon + fx * dLon) * 1e4) / 1e4 });
    }
  return pts;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** "2026-11-14T09:00" in the venue's local time -> index into Open-Meteo's local hourly array. */
function localHourKey(isoUtc: string, utcOffsetSeconds: number) {
  const d = new Date(new Date(isoUtc).getTime() + utcOffsetSeconds * 1000);
  return d.toISOString().slice(0, 13) + ":00";
}

async function getJson(url: string, timeoutMs = 12_000): Promise<{ ok: true; body: unknown } | { ok: false; status: FetchStatus; error: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json", "User-Agent": "Smile/0.2 (+https://github.com/kacytran1122/calhacks)" } });
    if (!res.ok) return { ok: false, status: res.status === 429 ? "blocked" : "error", error: `Open-Meteo returned HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (e) {
    const timedOut = (e as Error).name === "AbortError";
    return { ok: false, status: timedOut ? "timeout" : "error", error: timedOut ? "Open-Meteo took longer than 12 seconds" : (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

type Located = { utc_offset_seconds: number; hourly: Record<string, (number | null)[]> & { time: string[] } };

export function scoreCells(
  raw: { lat: number; lon: number; feelsLikeF: number; airTempF: number; modelSpreadF: number | null }[],
  leadDays: number,
  basis: HeatMap["basis"],
): { cells: HeatCell[]; regionMedianF: number } {
  const regionMedianF = median(raw.map((c) => c.feelsLikeF));
  const cells = raw.map((c) => {
    const anomalyF = Math.round((c.feelsLikeF - regionMedianF) * 10) / 10;
    const severity = Math.round(severityFor(c.feelsLikeF).score * 1000) / 1000;
    const confidence = confidenceFor(leadDays, c.modelSpreadF, basis);
    // Heat anomaly gate: discard candidates whose anomaly is below the threshold.
    const rank = anomalyF < ANOMALY_THRESHOLD_F ? 0 : Math.round(severity * confidence * 1000) / 1000;
    return { ...c, anomalyF, severity, confidence, rank };
  });
  return { cells, regionMedianF: Math.round(regionMedianF * 10) / 10 };
}

export async function heatMapAround(args: { lat: number; lon: number; at: string; radiusMiles?: number; size?: number; now?: Date }): Promise<HeatMap> {
  const radiusMiles = Math.min(10, Math.max(0.5, args.radiusMiles ?? 3));
  const size = Math.min(9, Math.max(3, args.size ?? 7));
  const now = args.now ?? new Date();
  const leadDays = (new Date(args.at).getTime() - now.getTime()) / 86_400_000;
  const pts = gridAround(args, radiusMiles, size);
  const lat = pts.map((p) => p.lat).join(",");
  const lon = pts.map((p) => p.lon).join(",");
  const method = [
    `Region: ${size}×${size} grid within ${radiusMiles} mi of the venue.`,
    "Evidence per cell: feels-like temperature at the event's start hour.",
    `Hotspot gate: keep cells at least ${ANOMALY_THRESHOLD_F}°F warmer than the area's median.`,
    "Severity: NWS heat-index bands (80°F caution, 90°F extreme caution, 103°F danger).",
    "Confidence: forecast lead time × agreement between two weather models.",
    "Rank = severity × confidence. No AI touches these numbers.",
  ];
  const base = { at: args.at, center: { lat: args.lat, lon: args.lon }, radiusMiles, method };
  const empty = (status: FetchStatus, basis: HeatMap["basis"], error: string, sources: HeatMap["sources"]): HeatMap => ({ ...base, status, basis, cells: [], hotspots: [], regionMedianF: null, band: "unknown", summary: error, sources, error });

  let raw: { lat: number; lon: number; feelsLikeF: number; airTempF: number; modelSpreadF: number | null }[] = [];
  let basis: HeatMap["basis"];
  let sources: HeatMap["sources"];

  if (leadDays <= 15 && leadDays >= -1) {
    basis = "forecast";
    const url = `${FORECAST}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,apparent_temperature&models=${MODELS.join(",")}&temperature_unit=fahrenheit&timezone=auto&forecast_days=16`;
    sources = [{ name: "Open-Meteo forecast (GFS + ECMWF IFS)", url: `${FORECAST}?latitude=${args.lat}&longitude=${args.lon}&hourly=apparent_temperature&models=${MODELS.join(",")}` }];
    const r = await getJson(url);
    if (!r.ok) return empty(r.status, basis, r.error, sources);
    const list = (Array.isArray(r.body) ? r.body : [r.body]) as Located[];
    list.forEach((loc, i) => {
      const k = loc.hourly.time.indexOf(localHourKey(args.at, loc.utc_offset_seconds));
      if (k < 0) return;
      const feels = MODELS.map((m) => loc.hourly[`apparent_temperature_${m}`]?.[k]).filter((v): v is number => typeof v === "number");
      const air = MODELS.map((m) => loc.hourly[`temperature_2m_${m}`]?.[k]).filter((v): v is number => typeof v === "number");
      if (!feels.length || !air.length) return;
      raw.push({ ...pts[i]!, feelsLikeF: feels.reduce((a, b) => a + b, 0) / feels.length, airTempF: air.reduce((a, b) => a + b, 0) / air.length, modelSpreadF: feels.length === 2 ? Math.round(Math.abs(feels[0]! - feels[1]!) * 10) / 10 : null });
    });
  } else if (leadDays > 15) {
    // Too far out to forecast: the same date and hour over the last three years (ERA5 reanalysis).
    basis = "climatology";
    const when = new Date(args.at);
    const years = [1, 2, 3].map((k) => when.getUTCFullYear() - k);
    sources = years.map((y) => ({ name: `Open-Meteo ERA5 archive ${y}`, url: `${ARCHIVE}?latitude=${args.lat}&longitude=${args.lon}&hourly=apparent_temperature` }));
    const perYear = await Promise.all(
      years.map((y) => {
        const day = `${y}-${String(when.getUTCMonth() + 1).padStart(2, "0")}-${String(when.getUTCDate()).padStart(2, "0")}`;
        return getJson(`${ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${day}&end_date=${day}&hourly=temperature_2m,apparent_temperature&temperature_unit=fahrenheit&timezone=auto`, 20_000).then((r) => ({ y, r }));
      }),
    );
    const good = perYear.filter((p) => p.r.ok);
    if (!good.length) {
      const first = perYear[0]!.r;
      return empty(first.ok ? "empty" : first.status, basis, first.ok ? "no archive data" : first.error, sources);
    }
    pts.forEach((p, i) => {
      const feels: number[] = [];
      const air: number[] = [];
      for (const { y, r } of good) {
        if (!r.ok) continue;
        const loc = ((Array.isArray(r.body) ? r.body : [r.body]) as Located[])[i];
        if (!loc) continue;
        const key = localHourKey(args.at, loc.utc_offset_seconds).replace(/^\d{4}/, String(y));
        const k = loc.hourly.time.indexOf(key);
        const f = loc.hourly.apparent_temperature?.[k];
        const a = loc.hourly.temperature_2m?.[k];
        if (typeof f === "number") feels.push(f);
        if (typeof a === "number") air.push(a);
      }
      if (feels.length && air.length) raw.push({ ...p, feelsLikeF: feels.reduce((s, v) => s + v, 0) / feels.length, airTempF: air.reduce((s, v) => s + v, 0) / air.length, modelSpreadF: null });
    });
  } else {
    return empty("empty", "forecast", "The event has already started; no heat map needed.", []);
  }

  if (!raw.length) return empty("empty", basis, "No temperature evidence for the event's start hour.", sources);
  raw = raw.map((c) => ({ ...c, feelsLikeF: Math.round(c.feelsLikeF * 10) / 10, airTempF: Math.round(c.airTempF * 10) / 10 }));
  const { cells, regionMedianF } = scoreCells(raw, leadDays, basis);
  const hotspots = cells.filter((c) => c.rank > 0).sort((a, b) => b.rank - a.rank).slice(0, 5);
  const hottest = cells.reduce((a, b) => (b.feelsLikeF > a.feelsLikeF ? b : a));
  const band = severityFor(hottest.feelsLikeF).band;
  const coolest = Math.min(...cells.map((c) => c.feelsLikeF));
  const when = basis === "forecast" ? "forecast" : "typical for this date (last 3 years)";
  const summary =
    `Feels like ${Math.round(coolest)}–${Math.round(hottest.feelsLikeF)}°F around the venue at kickoff (${when}); hottest band: ${band}. ` +
    (hotspots.length ? `${hotspots.length} spot${hotspots.length > 1 ? "s" : ""} run at least ${ANOMALY_THRESHOLD_F}°F hotter than the area.` : "No spot stands out as hotter than the rest of the area.");
  return { ...base, status: "ok", basis, cells, hotspots, regionMedianF, band, summary, sources };
}
