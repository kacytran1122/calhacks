import { planExtensionRoute, type ExtensionEvent } from "@smile/core";
import { NextResponse } from "next/server";

export const maxDuration = 15;

function validUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const body = await request.json() as { originText?: string; originCoordinates?: { lat: number; lon: number }; includeSelfDrive?: boolean; event?: ExtensionEvent };
  if (!body.event || typeof body.event.name !== "string" || body.event.name.trim().length < 2 || typeof body.event.location !== "string" || body.event.location.trim().length < 2 || typeof body.event.url !== "string" || !validUrl(body.event.url)) {
    return NextResponse.json({ error: "The event needs a name, location and valid website." }, { status: 400 });
  }
  if (!body.originCoordinates && (!body.originText || body.originText.trim().length < 2)) {
    return NextResponse.json({ error: "Choose current location or enter a ZIP code, city or address." }, { status: 400 });
  }
  if (body.originText && body.originText.length > 160) return NextResponse.json({ error: "Starting location is too long." }, { status: 400 });
  if (body.originCoordinates && (!Number.isFinite(body.originCoordinates.lat) || !Number.isFinite(body.originCoordinates.lon) || body.originCoordinates.lat < -90 || body.originCoordinates.lat > 90 || body.originCoordinates.lon < -180 || body.originCoordinates.lon > 180)) {
    return NextResponse.json({ error: "Starting coordinates are invalid." }, { status: 400 });
  }
  try {
    const plan = await planExtensionRoute({ originText: body.originText, originCoordinates: body.originCoordinates, includeSelfDrive: body.includeSelfDrive === true, event: { ...body.event, name: body.event.name.trim(), location: body.event.location.trim() } });
    return NextResponse.json(plan);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message || "Route planning failed." }, { status: 422 });
  }
}
