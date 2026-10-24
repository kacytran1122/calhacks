import { discoverEvents, type EventGroup, type EventListing } from "@smile/core";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const zip = p.get("zip") ?? "";
  if (!/^\d{5}$/.test(zip)) return NextResponse.json({ error: "ZIP must be 5 digits" }, { status: 400 });
  const radius = Math.min(3_000, Math.max(1, Number(p.get("radius") ?? 200) || 200));
  const groups = (p.get("groups") ?? "mlh,tech").split(",").filter((group): group is EventGroup => ["mlh", "tech"].includes(group));
  const kinds: EventListing["kind"][] = [...(groups.includes("mlh") ? ["hackathon" as const] : []), ...(groups.includes("tech") ? ["tech" as const] : [])];
  try {
    return NextResponse.json(await discoverEvents({ zip, radiusMiles: radius, query: p.get("q") ?? undefined, kinds: kinds.length ? kinds : ["hackathon", "tech"], groups: groups.length ? groups : ["mlh", "tech"] }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
