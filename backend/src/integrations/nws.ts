import type { FetchStatus } from "../types";
import { getJson } from "./geo";

export interface WeatherAtKickoff {
  status: FetchStatus;
  url: string;
  summary?: string;
  tempF?: number;
  precipPct?: number;
  note?: string;
}

export async function weatherAt(lat: number, lon: number, whenIso: string): Promise<WeatherAtKickoff> {
  const pointsUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const daysOut = (new Date(whenIso).getTime() - Date.now()) / 86_400_000;
  if (daysOut > 7) return { status: "empty", url: pointsUrl, note: `kickoff is ${Math.round(daysOut)} days out; NWS publishes ~7 days ahead. Will re-check closer in.` };
  if (daysOut < -1) return { status: "empty", url: pointsUrl, note: "event already started; no forecast needed" };

  const p = await getJson(pointsUrl);
  if (!p.ok) return { status: p.error === "timeout" ? "timeout" : "error", url: pointsUrl, note: p.error ?? `HTTP ${p.status}` };
  const hourlyUrl = (p.json as { properties?: { forecastHourly?: string } }).properties?.forecastHourly;
  if (!hourlyUrl) return { status: "empty", url: pointsUrl, note: "no hourly forecast for this point" };

  const h = await getJson(hourlyUrl);
  if (!h.ok) return { status: h.error === "timeout" ? "timeout" : "error", url: hourlyUrl, note: h.error ?? `HTTP ${h.status}` };
  type Period = { startTime: string; endTime: string; temperature: number; shortForecast: string; probabilityOfPrecipitation?: { value: number | null } };
  const periods = (h.json as { properties?: { periods?: Period[] } }).properties?.periods ?? [];
  const t = new Date(whenIso).getTime();
  const hit = periods.find((x) => new Date(x.startTime).getTime() <= t && t < new Date(x.endTime).getTime());
  if (!hit) return { status: "empty", url: hourlyUrl, note: "kickoff hour not in the published forecast window" };
  return {
    status: "ok",
    url: hourlyUrl,
    summary: hit.shortForecast,
    tempF: hit.temperature,
    precipPct: hit.probabilityOfPrecipitation?.value ?? undefined,
  };
}
