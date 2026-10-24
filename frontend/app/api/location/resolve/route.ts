import { cityToPoint } from "@smile/core";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const city = req.nextUrl.searchParams.get("city")?.trim() ?? "";
  if (city.length < 3 || city.length > 100) {
    return NextResponse.json({ error: "Enter a city and state, like Galesburg, IL." }, { status: 400 });
  }

  const location = await cityToPoint(city);
  if (location.status !== "ok" || !location.postalCode) {
    return NextResponse.json(
      { error: location.error === "not a U.S. city, state" ? "Add the state, like Galesburg, IL." : "We couldn’t find that U.S. city. Check the spelling and state." },
      { status: 404 },
    );
  }

  return NextResponse.json({ zip: location.postalCode, label: location.label, source: location.source });
}
