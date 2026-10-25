import { ConcurrentEdit, createRideDemoOwner, createRidePayment, listRidePayments, parseRidePaymentInput, requireRideDemoStorage, RidePaymentError, RIDE_DEMO_COOKIE, RIDE_DEMO_LIMITS, RIDE_DEMO_SESSION_SECONDS, tourContributionOriginAllowed, withState, type State } from "@smile/core";
import { NextResponse } from "next/server";
import { ensureState } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const headers = { "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer", Vary: "Cookie" };
const secureCookie = (request: Request) => new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";

async function receiptState<T>(operation: (state: State) => T): Promise<T> {
  try { return await withState(operation); }
  catch (error) {
    if (!(error instanceof ConcurrentEdit)) throw error;
    return withState(operation);
  }
}

function tokenFrom(request: Request) {
  const cookie = request.headers.get("cookie")?.split(";").find((part) => part.trim().startsWith(`${RIDE_DEMO_COOKIE}=`));
  if (!cookie) return undefined;
  try { return decodeURIComponent(cookie.trim().slice(RIDE_DEMO_COOKIE.length + 1)); }
  catch { throw new RidePaymentError("Your demo receipt session has expired. Re-enable simulated receipts to start a new session.", 401, "ride_demo_session_expired"); }
}

function errorResponse(error: unknown, request: Request) {
  const known = error instanceof RidePaymentError;
  const concurrent = error instanceof ConcurrentEdit;
  const response = NextResponse.json({ error: known ? error.message : concurrent ? "The receipt store changed. Retry the same ride without changing its details." : "Simulated receipts are temporarily unavailable. Please try again later.", code: known ? error.code : concurrent ? "ride_demo_retry" : "ride_demo_unavailable" }, { status: known ? error.status : 503, headers });
  if (known && error.status === 401) response.cookies.set(RIDE_DEMO_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/api/map/ride-payments", secure: secureCookie(request), maxAge: 0 });
  return response;
}

async function inputFrom(request: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new RidePaymentError("Send ride details as JSON.", 415, "ride_demo_invalid_input");
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > RIDE_DEMO_LIMITS.bodyBytes) throw new RidePaymentError("The ride details are too large.", 413, "ride_demo_body_limit");
  const reader = request.body?.getReader();
  if (!reader) throw new RidePaymentError("Ride details are required.", 400, "ride_demo_invalid_input");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 5_000);
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > RIDE_DEMO_LIMITS.bodyBytes) {
        await reader.cancel();
        throw new RidePaymentError("The ride details are too large.", 413, "ride_demo_body_limit");
      }
      chunks.push(part.value);
    }
    if (timedOut) throw new RidePaymentError("The ride details took too long to arrive. Try again.", 408, "ride_demo_body_timeout");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new RidePaymentError("Valid ride details are required.", 400, "ride_demo_invalid_input"); }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

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
