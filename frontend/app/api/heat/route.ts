import { heatMapAround } from "@smile/core";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/heat?lat=37.80&lon=-122.43&at=2026-11-14T17:00:00Z&radius=3 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const lat = Number(p.get("lat"));
  const lon = Number(p.get("lon"));
  const at = p.get("at") ?? "";
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return NextResponse.json({ error: "lat and lon are required" }, { status: 400 });
  if (Number.isNaN(new Date(at).getTime())) return NextResponse.json({ error: "at must be a date" }, { status: 400 });
  const radius = Number(p.get("radius") ?? 3);
  return NextResponse.json(await heatMapAround({ lat, lon, at, radiusMiles: Number.isFinite(radius) ? radius : 3 }));
}
