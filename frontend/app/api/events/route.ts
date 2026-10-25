import { discoverCall, discoverEvents, PermissionDenied, runAgent, type EventGroup, type EventListing } from "@smile/core";
import { NextResponse, type NextRequest } from "next/server";
import { ensureState } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const zip = p.get("zip") ?? "";
  if (!/^\d{5}$/.test(zip)) return NextResponse.json({ error: "ZIP must be 5 digits" }, { status: 400 });
  const radius = Math.min(3_000, Math.max(1, Number(p.get("radius") ?? 200) || 200));
  const lat = p.get("lat") === null ? undefined : Number(p.get("lat"));
  const lon = p.get("lon") === null ? undefined : Number(p.get("lon"));
  const originCoordinates = lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 ? { lat, lon } : undefined;
  const originLabel = originCoordinates ? p.get("originLabel")?.trim().slice(0, 120) || "Current location" : undefined;
  const groups = (p.get("groups") ?? "mlh,tech").split(",").filter((group): group is EventGroup => ["mlh", "tech"].includes(group));
  const kinds: EventListing["kind"][] = [...(groups.includes("mlh") ? ["hackathon" as const] : []), ...(groups.includes("tech") ? ["tech" as const] : [])];
  ensureState();
  try {
    return NextResponse.json(
      await runAgent(discoverCall(`zip:${zip}`), () => discoverEvents({ zip, originCoordinates, originLabel, radiusMiles: radius, query: p.get("q") ?? undefined, kinds: kinds.length ? kinds : ["hackathon", "tech"], groups: groups.length ? groups : ["mlh", "tech"] })),
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof PermissionDenied ? 403 : 502 });
  }
}
