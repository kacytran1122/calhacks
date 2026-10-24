import type { FetchStatus } from "../types";

const API = "https://router.project-osrm.org/route/v1/driving";
const USER_AGENT = "Smile/0.2 (+https://github.com/kacytran1122/calhacks)";

type Maneuver = { type?: string; modifier?: string };
type Step = { name?: string; distance?: number; duration?: number; maneuver?: Maneuver };
type Route = { duration: number; distance: number; legs?: { steps?: Step[] }[] };
export type OsrmPayload = { code?: string; routes?: Route[]; message?: string };

export interface DriveRoute {
  mode: "drive";
  title: string;
  durationMinutes: number;
  durationText: string;
  distanceMiles: number;
  sourceUrl: string;
  sourceQuote: string;
  steps: { instruction: string; detail: string | null }[];
}

export interface DrivePlanResult {
  status: FetchStatus;
  url: string;
  routes: DriveRoute[];
  ms: number;
  error?: string;
}

const mins = (seconds: number) => Math.max(1, Math.round(seconds / 60));

function durationText(seconds: number) {
  const total = mins(seconds);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours ? `${hours} hr${hours === 1 ? "" : "s"}${rest ? ` ${rest} min` : ""}` : `${rest} min`;
}

function instructionFor(step: Step, index: number, total: number) {
  const road = step.name?.trim() || "the road";
  const type = step.maneuver?.type ?? "continue";
  const modifier = step.maneuver?.modifier?.replace(/_/g, " ");
  if (index === total - 1 || type === "arrive") return "Arrive at the event.";
  if (type === "depart") return `Start on ${road}.`;
  if (type === "turn") return `Turn${modifier ? ` ${modifier}` : ""} onto ${road}.`;
  if (type === "merge") return `Merge${modifier ? ` ${modifier}` : ""} onto ${road}.`;
  if (type === "fork") return `Keep${modifier ? ` ${modifier}` : ""} to stay on ${road}.`;
  if (type === "roundabout" || type === "rotary") return `Enter the roundabout and continue onto ${road}.`;
  return `Continue${road === "the road" ? "" : ` on ${road}`}.`;
}

export function driveRoutesFrom(body: OsrmPayload, sourceUrl: string): DriveRoute[] {
  return (body.routes ?? []).slice(0, 3).map((route, routeIndex) => {
    const rawSteps = (route.legs ?? []).flatMap((leg) => leg.steps ?? []);
    const steps = rawSteps
      .filter((step, index) => index === 0 || index === rawSteps.length - 1 || (step.distance ?? 0) >= 160)
      .slice(0, 12)
      .map((step, index, all) => ({
        instruction: instructionFor(step, index, all.length),
        detail: `${Math.max(0.1, Math.round(((step.distance ?? 0) / 1609.344) * 10) / 10)} mi · ${durationText(step.duration ?? 0)}`,
      }));
    const distanceMiles = Math.round((route.distance / 1609.344) * 10) / 10;
    return {
      mode: "drive" as const,
      title: routeIndex === 0 ? "Drive the fastest road route" : `Driving alternative ${routeIndex + 1}`,
      durationMinutes: mins(route.duration),
      durationText: durationText(route.duration),
      distanceMiles,
      sourceUrl,
      sourceQuote: "Live road routing from the OSRM service using OpenStreetMap road data.",
      steps: steps.length ? steps : [{ instruction: "Follow the live road route to the event.", detail: `${distanceMiles} mi` }],
    };
  });
}

export async function planDrivingRoutes(args: { from: { lat: number; lon: number }; to: { lat: number; lon: number } }): Promise<DrivePlanResult> {
  const coordinates = `${args.from.lon},${args.from.lat};${args.to.lon},${args.to.lat}`;
  const url = `${API}/${coordinates}?alternatives=2&steps=true&overview=false`;
  const sourceUrl = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${args.from.lat}%2C${args.from.lon}%3B${args.to.lat}%2C${args.to.lon}`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (!response.ok) return { status: "error", url, routes: [], ms: Date.now() - started, error: `OSRM returned HTTP ${response.status}` };
    const body = await response.json() as OsrmPayload;
    const routes = driveRoutesFrom(body, sourceUrl);
    return { status: routes.length ? "ok" : "empty", url, routes, ms: Date.now() - started, error: routes.length ? undefined : body.message ?? "No road route was returned." };
  } catch (error) {
    const timedOut = (error as Error).name === "AbortError" || (error as Error).name === "TimeoutError";
    return { status: timedOut ? "timeout" : "error", url, routes: [], ms: Date.now() - started, error: timedOut ? "Live road routing took longer than 8 seconds." : (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
