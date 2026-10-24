import { discoverEvents, type EventListing } from "@smile/core";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const zip = p.get("zip") ?? "";
  if (!/^\d{5}$/.test(zip)) return NextResponse.json({ error: "ZIP must be 5 digits" }, { status: 400 });
  const radius = Math.min(3_000, Math.max(1, Number(p.get("radius") ?? 200) || 200));
  const kinds = (p.get("kinds") ?? "hackathon,tech").split(",").filter((k): k is EventListing["kind"] => ["hackathon", "tech", "other"].includes(k));
  try {
    return NextResponse.json(await discoverEvents({ zip, radiusMiles: radius, query: p.get("q") ?? undefined, kinds: kinds.length ? kinds : ["hackathon", "tech"] }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
