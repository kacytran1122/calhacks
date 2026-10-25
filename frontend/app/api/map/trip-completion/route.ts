import {
  completeTripFromMap,
  ConcurrentEdit,
  PHOTON_MAP_COMPLETION_COOKIE,
  PhotonHandoffStorageUnavailable,
  PermissionDenied,
  resolvePhotonMapHandoff,
  tourContributionOriginAllowed,
  withState,
  type State,
} from "@smile/core";
import { NextResponse } from "next/server";
import { ensureState } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  Vary: "Cookie",
};

const secureCookie = (request: Request) => new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";

function tokenFrom(request: Request): string | undefined {
  const cookie = request.headers.get("cookie")?.split(";").find((part) => part.trim().startsWith(`${PHOTON_MAP_COMPLETION_COOKIE}=`));
  if (!cookie) return undefined;
  try { return decodeURIComponent(cookie.trim().slice(PHOTON_MAP_COMPLETION_COOKIE.length + 1)); }
  catch { return undefined; }
}

function clearSession(response: NextResponse, request: Request) {
  response.cookies.set(PHOTON_MAP_COMPLETION_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookie(request),
    path: "/api/map/trip-completion",
    maxAge: 0,
  });
  return response;
}

async function update<T>(operation: (state: State) => T): Promise<T> {
  try { return await withState(operation); }
  catch (error) {
    if (!(error instanceof ConcurrentEdit)) throw error;
    return withState(operation);
  }
}

export async function POST(request: Request) {
  if (!tourContributionOriginAllowed(request)) {
    return NextResponse.json({ error: "Complete this route from the S’mile map." }, { status: 403, headers });
  }

  const token = tokenFrom(request);
  if (!token) return NextResponse.json({ connected: false }, { headers });

  try {
    const handoff = resolvePhotonMapHandoff(token);
    if (!handoff) {
      return clearSession(NextResponse.json({ error: "This secure map session is invalid or expired." }, { status: 401, headers }), request);
    }
    ensureState();
    const result = await update((state) => completeTripFromMap(state, handoff));
    return NextResponse.json({
      connected: true,
      replayed: result.replayed,
      state: result.tripState,
      decisionCode: result.decisionCode,
      needsHuman: result.needsHuman,
    }, { status: result.replayed ? 200 : 201, headers });
  } catch (error) {
    if (error instanceof PhotonHandoffStorageUnavailable) {
      return NextResponse.json({ error: "Secure trip completion is temporarily unavailable." }, { status: 503, headers: { ...headers, "Retry-After": "5" } });
    }
    if (error instanceof PermissionDenied) {
      return clearSession(NextResponse.json({ error: "This map session cannot complete that trip." }, { status: 403, headers }), request);
    }
    return NextResponse.json({ error: "This trip could not enter post-trip review." }, { status: 409, headers });
  }
}
