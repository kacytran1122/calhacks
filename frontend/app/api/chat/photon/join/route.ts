import {
  assignPhotonDirectChat,
  normalizeImessageHandle,
  PhotonJoinError,
  photonJoinFingerprint,
  tourContributionOriginAllowed,
  travelerForTripToken,
} from "@smile/core";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map<string, number[]>();

function sourceOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function reserve(key: string): number | undefined {
  const now = Date.now();
  let total = 0;
  for (const [entry, values] of attempts) {
    const recent = values.filter((value) => now - value < WINDOW_MS);
    if (recent.length) {
      attempts.set(entry, recent);
      total += recent.length;
    } else attempts.delete(entry);
  }
  const own = attempts.get(key) ?? [];
  if (own.length >= 5 || total >= 50) return Math.max(1, Math.ceil((WINDOW_MS - (now - (own[0] ?? now))) / 1000));
  attempts.set(key, [...own, now]);
  return undefined;
}

const noStore = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request: Request) {
  if (!tourContributionOriginAllowed(request)) {
    return NextResponse.json({ error: "This request must come from the S’mile website." }, { status: 403, headers: noStore });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 4_096) {
    return NextResponse.json({ error: "The request is too large." }, { status: 413, headers: noStore });
  }

  let raw: unknown;
  try { raw = await request.json(); }
  catch { return NextResponse.json({ error: "A valid JSON request is required." }, { status: 400, headers: noStore }); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "A join request is required." }, { status: 400, headers: noStore });
  }
  const body = raw as Record<string, unknown>;
  const handle = body.handle;
  const tripId = typeof body.tripId === "string" ? body.tripId : "";
  const tripToken = typeof body.tripToken === "string" ? body.tripToken : "";
  if (body.consent !== true) {
    return NextResponse.json({ error: "Confirm that Photon may use this iMessage identity to assign your private line." }, { status: 400, headers: noStore });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(tripId) || tripToken.length < 20 || tripToken.length > 200) {
    return NextResponse.json({ error: "Start from a current trip plan before connecting iMessage." }, { status: 403, headers: noStore });
  }
  try {
    if (!travelerForTripToken(tripToken, tripId)) {
      return NextResponse.json({ error: "This trip link is invalid or expired. Make a new trip plan and try again." }, { status: 403, headers: noStore });
    }
  } catch {
    return NextResponse.json({ error: "This trip link could not be verified. Make a new trip plan and try again." }, { status: 503, headers: noStore });
  }

  let normalizedHandle: string;
  try { normalizedHandle = normalizeImessageHandle(handle); }
  catch (error) {
    const message = error instanceof PhotonJoinError ? error.message : "Enter a valid iMessage phone number or Apple Account email.";
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }

  const retryAfter = reserve(photonJoinFingerprint(`${sourceOf(request)}\n${tripId}`));
  if (retryAfter !== undefined) {
    return NextResponse.json({ error: "Too many iMessage setup attempts. Try again in a few minutes." }, { status: 429, headers: { ...noStore, "Retry-After": String(retryAfter) } });
  }

  try {
    const result = await assignPhotonDirectChat(normalizedHandle);
    return NextResponse.json(result, { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof PhotonJoinError) {
      return NextResponse.json({ error: error.message }, {
        status: error.status,
        headers: { ...noStore, ...(error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) },
      });
    }
    return NextResponse.json({ error: "Private iMessage setup is temporarily unavailable." }, { status: 503, headers: noStore });
  }
}
