import type { FetchStatus } from "../types";

const API = "https://router.project-osrm.org/route/v1/driving";
const USER_AGENT = "Smile/0.2 (+https://github.com/kacytran1122/calhacks)";

type Maneuver = { type?: string; modifier?: string; bearing_after?: number };
type Step = { name?: string; ref?: string; destinations?: string; exits?: string; distance?: number; duration?: number; maneuver?: Maneuver };
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

function distanceText(meters = 0) {
  const miles = meters / 1609.344;
  if (miles >= 0.2) return `${Math.round(miles * 10) / 10} mile${miles >= 1.5 ? "s" : ""}`;
  const feet = Math.max(50, Math.round((meters * 3.28084) / 50) * 50);
  return `${feet} feet`;
}

function roadName(step: Step) {
  const name = step.name?.trim();
  const ref = step.ref?.trim();
  if (name && ref && !name.includes(ref)) return `${name} (${ref})`;
  return name || ref || "";
}

function compassDirection(bearing?: number) {
  if (!Number.isFinite(bearing)) return "";
  const points = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return points[Math.round((((bearing as number) % 360) / 45)) % 8];
}

function nextNamedRoad(steps: Step[], index: number) {
  const current = steps[index];
  for (let cursor = index + 1; cursor < steps.length; cursor += 1) {
    const candidate = steps[cursor];
    if (!candidate) continue;
    const road = roadName(candidate);
    if (road && (!current || road !== roadName(current))) return road;
  }
  return "the event entrance";
}

function instructionFor(step: Step, index: number, steps: Step[], context?: { fromLabel?: string; toLabel?: string }) {
  const road = roadName(step);
  const type = step.maneuver?.type ?? "continue";
  const modifier = step.maneuver?.modifier?.replace(/_/g, " ");
  const span = distanceText(step.distance);
  const next = nextNamedRoad(steps, index);
  const heading = compassDirection(step.maneuver?.bearing_after);
  const signs = step.destinations?.trim() ? ` Follow signs for ${step.destinations.trim()}.` : "";
  const exit = step.exits?.trim() ? ` Take exit ${step.exits.trim()}` : "Take the exit";
  if (index === steps.length - 1 || type === "arrive") return `You’ll reach ${context?.toLabel || "the event"}. Slow down, follow the venue signs, and look for the event check-in entrance.`;
  if (type === "depart") return `Leave ${context?.fromLabel || "your starting point"}${road ? ` via ${road}` : ""}${heading ? ` heading ${heading}` : ""}. Follow it for ${span}.`;
  if (type === "turn") return `At the next junction, turn${modifier ? ` ${modifier}` : ""}${road ? ` onto ${road}` : ""}. Stay on it for ${span}, until the next decision point near ${next}.`;
  if (type === "merge") return `Use the ${modifier || "matching"} lane to join${road ? ` ${road}` : " the main traffic lanes"}.${signs} Stay on this stretch for ${span}.`;
  if (type === "fork") return `At the fork, keep${modifier ? ` ${modifier}` : " straight"}${road ? ` to remain on ${road}` : ""}.${signs} Follow it for ${span}.`;
  if (type === "on ramp") return `Take the${modifier ? ` ${modifier}` : ""} entrance ramp${road ? ` onto ${road}` : ""}.${signs} Join traffic carefully and stay on it for ${span}.`;
  if (type === "off ramp") return `${exit}${modifier ? ` on the ${modifier}` : ""}${road ? ` toward ${road}` : ""}.${signs}`;
  if (type === "end of road") return `At the end of the road, turn${modifier ? ` ${modifier}` : ""}${road ? ` onto ${road}` : ""}, then follow it for ${span}.`;
  if (type === "new name") return `The road becomes ${road || next}. Keep going for ${span}; no turn is needed.`;
  if (type === "roundabout" || type === "rotary") return `Enter the roundabout, follow signs for ${road || next}, and take the indicated exit. Continue for ${span}.`;
  if (road) return `Stay on ${road} for ${span}. Keep following it until you reach the junction for ${next}.`;
  return `Follow the current road${heading ? ` ${heading}` : ""} for ${span}. Your next named road is ${next}.`;
}

export function driveRoutesFrom(body: OsrmPayload, sourceUrl: string, context?: { fromLabel?: string; toLabel?: string }): DriveRoute[] {
  return (body.routes ?? []).slice(0, 3).map((route, routeIndex) => {
    const rawSteps = (route.legs ?? []).flatMap((leg) => leg.steps ?? []);
    const important = new Set(["depart", "arrive", "turn", "merge", "fork", "on ramp", "off ramp", "end of road", "new name", "roundabout", "rotary"]);
    const selectedSteps = rawSteps
      .filter((step, index) => index === 0 || index === rawSteps.length - 1 || important.has(step.maneuver?.type ?? "") || (step.distance ?? 0) >= 240)
      .slice(0, 16);
    const steps = selectedSteps
      .map((step, index, all) => ({
        instruction: instructionFor(step, index, all, context),
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

export async function planDrivingRoutes(args: { from: { lat: number; lon: number }; to: { lat: number; lon: number }; fromLabel?: string; toLabel?: string }): Promise<DrivePlanResult> {
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
    const routes = driveRoutesFrom(body, sourceUrl, { fromLabel: args.fromLabel, toLabel: args.toLabel });
    return { status: routes.length ? "ok" : "empty", url, routes, ms: Date.now() - started, error: routes.length ? undefined : body.message ?? "No road route was returned." };
  } catch (error) {
    const timedOut = (error as Error).name === "AbortError" || (error as Error).name === "TimeoutError";
    return { status: timedOut ? "timeout" : "error", url, routes: [], ms: Date.now() - started, error: timedOut ? "Live road routing took longer than 8 seconds." : (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
