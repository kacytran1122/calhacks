import { createTripDemoReceipt, listTripDemoReceipts, parseTripDemoReceiptInput, requireRideDemoStorage, RidePaymentError, RIDE_DEMO_LIMITS, tourContributionOriginAllowed } from "@smile/core";
import { NextResponse } from "next/server";
import { ensureState } from "@/lib/server";
import { receiptErrorResponse, receiptHeaders as headers, receiptInputFrom, receiptState, receiptTokenFrom } from "@/lib/ridePaymentsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const requiredToken = (request: Request) => {
  const token = receiptTokenFrom(request);
  if (token === undefined) throw new RidePaymentError("The original demo receipt session is required to finish this journey. No new record was created.", 401, "ride_demo_session_required");
  return token;
};

export async function GET(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site" || (request.headers.has("origin") && !tourContributionOriginAllowed(request))) return NextResponse.json({ error: "Open simulated receipts from the S’mile website." }, { status: 403, headers });
  try {
    requireRideDemoStorage();
    const token = requiredToken(request);
    ensureState();
    const receipts = await receiptState((state) => listTripDemoReceipts(state, token));
    return NextResponse.json({ receipts }, { headers });
  } catch (error) { return receiptErrorResponse(error, request); }
}

export async function POST(request: Request) {
  if (!tourContributionOriginAllowed(request)) return NextResponse.json({ error: "Finish simulated journeys from the S’mile website." }, { status: 403, headers });
  try {
    requireRideDemoStorage();
    const token = requiredToken(request);
    const input = parseTripDemoReceiptInput(await receiptInputFrom(request, RIDE_DEMO_LIMITS.tripBodyBytes));
    ensureState();
    const result = await receiptState((state) => createTripDemoReceipt(state, token, input));
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers });
  } catch (error) { return receiptErrorResponse(error, request); }
}
