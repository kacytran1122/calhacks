import { ConcurrentEdit, RidePaymentError, RIDE_DEMO_COOKIE, RIDE_DEMO_LIMITS, withState, type State } from "@smile/core";
import { NextResponse } from "next/server";

export const receiptHeaders = { "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer", Vary: "Cookie" };
export const secureReceiptCookie = (request: Request) => new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";

export async function receiptState<T>(operation: (state: State) => T): Promise<T> {
  try { return await withState(operation); }
  catch (error) {
    if (!(error instanceof ConcurrentEdit)) throw error;
    return withState(operation);
  }
}

export function receiptTokenFrom(request: Request) {
  const cookie = request.headers.get("cookie")?.split(";").find((part) => part.trim().startsWith(`${RIDE_DEMO_COOKIE}=`));
  if (!cookie) return undefined;
  try { return decodeURIComponent(cookie.trim().slice(RIDE_DEMO_COOKIE.length + 1)); }
  catch { throw new RidePaymentError("Your demo receipt session has expired. Re-enable simulated receipts to start a new session.", 401, "ride_demo_session_expired"); }
}

export function receiptErrorResponse(error: unknown, request: Request) {
  const known = error instanceof RidePaymentError;
  const concurrent = error instanceof ConcurrentEdit;
  const response = NextResponse.json({ error: known ? error.message : concurrent ? "The receipt store changed. Retry the same ride without changing its details." : "Simulated receipts are temporarily unavailable. Please try again later.", code: known ? error.code : concurrent ? "ride_demo_retry" : "ride_demo_unavailable" }, { status: known ? error.status : 503, headers: receiptHeaders });
  if (known && error.status === 401) response.cookies.set(RIDE_DEMO_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/api/map/ride-payments", secure: secureReceiptCookie(request), maxAge: 0 });
  return response;
}

export async function receiptInputFrom(request: Request, maxBytes: number = RIDE_DEMO_LIMITS.bodyBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new RidePaymentError("Send ride details as JSON.", 415, "ride_demo_invalid_input");
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maxBytes) throw new RidePaymentError("The ride details are too large.", 413, "ride_demo_body_limit");
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
      if (bytes > maxBytes) {
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
