import { cityToPoint, coordinatesToPoint } from "@smile/core";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const latParam = req.nextUrl.searchParams.get("lat");
  const lonParam = req.nextUrl.searchParams.get("lon");
  if (latParam !== null || lonParam !== null) {
    const location = await coordinatesToPoint(Number(latParam), Number(lonParam));
    if (location.status !== "ok" || !location.postalCode) {
      return NextResponse.json({ error: "We couldn’t match your current location to a U.S. ZIP code." }, { status: 404 });
    }
    return NextResponse.json({ zip: location.postalCode, label: location.label, source: location.source });
  }
  const city = req.nextUrl.searchParams.get("city")?.trim() ?? "";
  if (city.length < 3 || city.length > 100) {
    return NextResponse.json({ error: "Enter a U.S. city, state, or city and state." }, { status: 400 });
  }

  const location = await cityToPoint(city);
  if (location.status !== "ok" || !location.postalCode) {
    return NextResponse.json(
      { error: "We couldn’t find that U.S. location. Try a ZIP code, city, state, or city and state." },
      { status: 404 },
    );
  }

  return NextResponse.json({ zip: location.postalCode, label: location.label, source: location.source });
}
