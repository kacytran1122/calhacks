import { globalPlaceToPoint, placeToPoint, type GeoResult } from "./integrations/geo";
import { planDrivingRoutes } from "./integrations/osrm";
import { planPublicTransit } from "./integrations/transitous";

export interface ExtensionEvent {
  name: string;
  url: string;
  location: string;
  startsAt?: string;
  imageUrl?: string;
  lat?: number;
  lon?: number;
}

export interface ExtensionRoute {
  id: string;
  mode: "train" | "bus" | "drive";
  title: string;
  durationMinutes: number;
  durationText: string;
  distanceMiles?: number;
  sourceUrl: string;
  sourceLabel: string;
  liveStatus: string;
  steps: { instruction: string; detail: string | null }[];
}

export interface ExtensionRoutePlan {
  event: ExtensionEvent;
  originLabel: string;
  destinationLabel: string;
  fastestRouteId?: string;
  routes: ExtensionRoute[];
  messages: string[];
  generatedAt: string;
}

function validCoordinates(point: { lat: number; lon: number } | undefined) {
  return Boolean(point && Number.isFinite(point.lat) && Number.isFinite(point.lon) && point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180);
}

async function resolvePlace(text: string): Promise<GeoResult> {
  const primary = await globalPlaceToPoint(text);
  if (primary.status === "ok") return primary;
  return placeToPoint(text);
}

export async function planExtensionRoute(input: { originText?: string; originCoordinates?: { lat: number; lon: number }; includeSelfDrive: boolean; event: ExtensionEvent }): Promise<ExtensionRoutePlan> {
  const originText = input.originText?.trim();
  const destinationText = input.event.location.trim();
  const originLookup = validCoordinates(input.originCoordinates) ? undefined : originText ? await resolvePlace(originText) : undefined;
  const destinationLookup = validCoordinates(input.event.lat !== undefined && input.event.lon !== undefined ? { lat: input.event.lat, lon: input.event.lon } : undefined)
    ? undefined
    : await resolvePlace(destinationText);
  const origin = validCoordinates(input.originCoordinates)
    ? { lat: input.originCoordinates!.lat, lon: input.originCoordinates!.lon, label: originText || "Your current location" }
    : originLookup?.status === "ok" && originLookup.lat !== undefined && originLookup.lon !== undefined
      ? { lat: originLookup.lat, lon: originLookup.lon, label: originLookup.label || originText! }
      : undefined;
  const destination = input.event.lat !== undefined && input.event.lon !== undefined && validCoordinates({ lat: input.event.lat, lon: input.event.lon })
    ? { lat: input.event.lat, lon: input.event.lon, label: destinationText }
    : destinationLookup?.status === "ok" && destinationLookup.lat !== undefined && destinationLookup.lon !== undefined
      ? { lat: destinationLookup.lat, lon: destinationLookup.lon, label: destinationLookup.label || destinationText }
      : undefined;

  if (!origin) throw new Error("We couldn't find that starting location. Try a ZIP code or a city and state.");
  if (!destination) throw new Error("We couldn't find the event location. Try opening the event's official venue page.");

  const [transit, driving] = await Promise.all([
    planPublicTransit({ from: origin, to: destination, startsAt: input.event.startsAt, includeFares: false }),
    input.includeSelfDrive ? planDrivingRoutes({ from: origin, to: destination, fromLabel: origin.label, toLabel: destination.label }) : Promise.resolve(undefined),
  ]);
  const transitRoutes: ExtensionRoute[] = transit.options.map((option, index) => ({
    id: `transit-${index + 1}`,
    mode: option.mode,
    title: option.title,
    durationMinutes: option.durationMinutes,
    durationText: option.durationText,
    sourceUrl: option.sourceUrl,
    sourceLabel: "Transitous public transit",
    liveStatus: option.sourceQuote,
    steps: option.steps,
  }));
  const driveRoutes: ExtensionRoute[] = (driving?.routes ?? []).map((route, index) => ({
    id: `drive-${index + 1}`,
    mode: route.mode,
    title: route.title,
    durationMinutes: route.durationMinutes,
    durationText: route.durationText,
    distanceMiles: route.distanceMiles,
    sourceUrl: route.sourceUrl,
    sourceLabel: "OpenStreetMap + OSRM",
    liveStatus: route.sourceQuote,
    steps: route.steps,
  }));
  const routes = [...transitRoutes, ...driveRoutes].sort((a, b) => a.durationMinutes - b.durationMinutes).slice(0, 5);
  const messages = [
    ...(transit.error ? [transit.error] : []),
    ...(driving?.error ? [driving.error] : []),
    ...(!routes.length ? [input.includeSelfDrive ? "No live transit or driving route was returned. Try again closer to departure." : "No live public-transit route was returned. You can enable self-drive or try again closer to departure."] : []),
  ];
  return {
    event: input.event,
    originLabel: origin.label,
    destinationLabel: destination.label,
    fastestRouteId: routes[0]?.id,
    routes,
    messages,
    generatedAt: new Date().toISOString(),
  };
}
