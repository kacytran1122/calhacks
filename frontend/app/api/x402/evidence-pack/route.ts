import { loadState, traceFor, X402_NETWORK } from "@smile/core";
import { NextResponse, type NextRequest } from "next/server";
import { ensureState } from "@/lib/server";

export const dynamic = "force-dynamic";

type Handler = (req: NextRequest) => Promise<Response>;
let paid: Promise<Handler> | undefined;

function pack(tripId: string) {
  ensureState();
  const t = traceFor(loadState(), tripId);
  return {
    trip: { id: t.trip.id, mode: t.trip.mode, distanceMiles: t.trip.distanceMiles, quoteCents: t.trip.quoteCents, state: t.trip.state },
    traveler: t.traveler ? { initials: t.traveler.initials } : undefined,
    event: t.event,
    evidence: t.evidence
      .filter((e) => e.kind !== "receipt")
      .map((e) => ({ id: e.id, kind: e.kind, source: e.source, url: e.url, fetchedAt: e.fetchedAt, status: e.status, provenance: e.provenance, data: e.data })),
    decision: t.decision,
    rules: t.rules,
  };
}

async function inner(req: NextRequest): Promise<NextResponse<unknown>> {
  const tripId = req.nextUrl.searchParams.get("tripId");
  if (!tripId) return NextResponse.json({ error: "tripId required" }, { status: 400 });
  try {
    return NextResponse.json(pack(tripId));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 });
  }
}

export async function GET(req: NextRequest) {
  const payTo = process.env.X402_PAY_TO || process.env.PAY_TO;
  const canProvisionReceiver = Boolean(process.env.CDP_WALLET_SECRET);
  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET || (!payTo && !canProvisionReceiver))
    return NextResponse.json(
      { error: "x402 seller not configured: set CDP_API_KEY_ID, CDP_API_KEY_SECRET, and either X402_PAY_TO or CDP_WALLET_SECRET in .env" },
      { status: 501 },
    );
  if (payTo && !/^0x[0-9a-fA-F]{40}$/.test(payTo))
    return NextResponse.json({ error: "X402_PAY_TO must be a valid EVM address" }, { status: 501 });
  if (!paid) {
    paid = Promise.all([
      import("@x402/next"),
      import("@coinbase/cdp-sdk/x402"),
    ]).then(async ([{ withX402FromHTTPServer }, { createX402Server }]) => {
      const server = await createX402Server({
        environment: "development",
        builderCode: "smile",
        ...(payTo ? { payToConfig: { type: "address" as const, evm: payTo as `0x${string}` } } : {}),
        routes: {
          "GET /api/x402/evidence-pack": {
            price: "$0.01",
            networks: [X402_NETWORK],
            description: "Verified evidence pack for one S'mile trip",
          },
        },
      });
      return withX402FromHTTPServer(inner, server) as Handler;
    });
  }
  return (await paid)(req);
}
