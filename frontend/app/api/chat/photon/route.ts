import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { handleMessage } from "@/lib/chat";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const same = (a: string, b: string) => {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
};

/** Private bridge used only by the Photon 2.0 worker. Photon credentials never enter the browser. */
export async function POST(req: Request) {
  const expected = process.env.PHOTON_BRIDGE_SECRET;
  const supplied = req.headers.get("x-smile-photon-secret") ?? "";
  if (!expected) return NextResponse.json({ error: "Photon bridge is not configured" }, { status: 503 });
  if (!same(supplied, expected)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { spaceId?: string; senderId?: string; text?: string };
  if (!body.spaceId || !body.senderId || !body.text?.trim()) return NextResponse.json({ error: "spaceId, senderId and text are required" }, { status: 400 });
  if (body.spaceId.length > 200 || body.senderId.length > 200 || body.text.length > 4_000) return NextResponse.json({ error: "Photon message is too large" }, { status: 413 });

  const sender = `Traveler ${createHash("sha256").update(body.senderId).digest("hex").slice(0, 6).toUpperCase()}`;
  const result = await handleMessage(`photon-${body.spaceId}`, sender, body.text);
  return NextResponse.json({
    replies: result.posted.filter((m) => m.bot).map((m) => ({ id: m.id, text: m.text, approvalPath: result.approvals[m.id] })),
  });
}
