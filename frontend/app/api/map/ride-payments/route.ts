import { createRideDemoOwner, createRidePayment, listRidePayments, parseRidePaymentInput, requireRideDemoStorage, RidePaymentError, RIDE_DEMO_COOKIE, RIDE_DEMO_SESSION_SECONDS, tourContributionOriginAllowed } from "@smile/core";
import { NextResponse } from "next/server";
import { ensureState } from "@/lib/server";
import { receiptErrorResponse as errorResponse, receiptHeaders as headers, receiptInputFrom as inputFrom, receiptState, receiptTokenFrom as tokenFrom, secureReceiptCookie as secureCookie } from "@/lib/ridePaymentsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site" || (request.headers.has("origin") && !tourContributionOriginAllowed(request))) return NextResponse.json({ error: "Open simulated receipts from the S’mile website." }, { status: 403, headers });
  try {
    requireRideDemoStorage();
    const token = tokenFrom(request);
    if (new URL(request.url).searchParams.get("recover") === "1" && token === undefined) throw new RidePaymentError("This browser’s demo receipt session is unavailable. This ride cannot be retried safely. Skip the demo or return to your route.", 401, "ride_demo_session_required");
    ensureState();
    const result = await receiptState((state) => {
      if (token !== undefined) return { receipts: listRidePayments(state, token), owner: undefined };
      const owner = createRideDemoOwner(state);
      return { receipts: [], owner };
    });
    const response = NextResponse.json({ receipts: result.receipts }, { headers });
    if (result.owner) response.cookies.set(RIDE_DEMO_COOKIE, result.owner.token, { httpOnly: true, sameSite: "strict", path: "/api/map/ride-payments", secure: secureCookie(request), maxAge: RIDE_DEMO_SESSION_SECONDS, expires: new Date(result.owner.expiresAt) });
    return response;
  } catch (error) { return errorResponse(error, request); }
}

export async function POST(request: Request) {
  if (!tourContributionOriginAllowed(request)) return NextResponse.json({ error: "Create simulated receipts from the S’mile website." }, { status: 403, headers });
  try {
    requireRideDemoStorage();
    const token = tokenFrom(request);
    if (token === undefined) throw new RidePaymentError("Re-enable simulated receipts before creating a demo receipt.", 401, "ride_demo_session_required");
    const input = parseRidePaymentInput(await inputFrom(request));
    ensureState();
    const result = await receiptState((state) => createRidePayment(state, token, input));
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers });
  } catch (error) { return errorResponse(error, request); }
}
