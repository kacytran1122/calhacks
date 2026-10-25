import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  ChatBusy,
  ChatReplayConflict,
  ChatStorageUnavailable,
  claimPhotonTripHandoff,
  loadState,
  photonTripBinding,
  PhotonHandoffStorageUnavailable,
  type PhotonTripBinding,
} from "@smile/core";
import { handleMessage, parseMention } from "@/lib/chat";
import { ensureState } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const WEBSITE = "https://smilefromhereto.work";

const same = (a: string, b: string) => {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
};

const safeLabel = (value: string | undefined, fallback: string) => {
  const text = (value ?? "").replace(/https?:\/\/\S+/giu, "").replace(/\s+/g, " ").trim();
  return text || fallback;
};

const modeLabel: Record<string, string> = {
  bus: "Bus",
  drive: "Drive",
  flight: "Flight",
  rideshare: "Rideshare",
  train: "Train",
};

const statusLabel: Record<string, string> = {
  planned: "Planned",
  pre_approved: "Pre-approved",
  booked: "Booked",
  submitted: "Submitted for reimbursement",
  needs_human: "Needs review",
  reimbursed: "Reimbursed",
  denied: "Denied",
  closed: "Closed",
};

const eventTimeZone = (longitude?: number) => longitude === undefined || longitude < -115
  ? "America/Los_Angeles"
  : longitude < -101
    ? "America/Denver"
    : longitude < -87
      ? "America/Chicago"
      : "America/New_York";

function tripSummary(binding: PhotonTripBinding, kind: "connected" | "update"): string | null {
  ensureState();
  const state = loadState();
  const trip = state.trips.find((candidate) => candidate.id === binding.tripId && candidate.travelerId === binding.travelerId);
  if (!trip) return null;
  const event = state.events.find((candidate) => candidate.id === trip.eventId);
  if (!event) return null;
  const destination = [safeLabel(event.venue, "Event venue"), safeLabel(event.city, "")].filter(Boolean).join(", ");
  const starts = Number.isNaN(Date.parse(event.startsAt))
    ? "Time to be confirmed"
    : new Date(event.startsAt).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: eventTimeZone(event.lon),
      timeZoneName: "short",
    });
  const mode = modeLabel[trip.mode] ?? safeLabel(trip.mode, "Route");
  const route = trip.routeTitle ? `${safeLabel(trip.routeTitle, mode)} (${mode})` : mode;
  const heading = kind === "connected" ? "Your S’mile trip is connected." : "Trip update";
  const routeInstruction = binding.mapPath
    ? "Open the secure step-by-step route in the next message."
    : `Refresh your secure route from ${WEBSITE}/finding-events.`;
  return [
    heading,
    "",
    `Event: ${safeLabel(event.name, "Selected event")}`,
    `Destination: ${destination}`,
    `Starts: ${starts}`,
    `Current route: ${route}`,
    `Trip status: ${statusLabel[trip.state] ?? safeLabel(trip.state, "In progress")}`,
    "",
    routeInstruction,
    "Message @smile status, @smile trip, or @smile location for the latest saved update. Pin the route message in Messages for quick access.",
  ].join("\n");
}

const missingTripSummary = (binding: PhotonTripBinding) => [
  "Your secure S’mile route is connected.",
  "",
  binding.mapPath
    ? "Open the secure step-by-step route in the next message."
    : `Refresh your secure route from ${WEBSITE}/finding-events.`,
  "Pin the route message in Messages for quick access.",
].join("\n");

export async function POST(req: Request) {
  const expected = process.env.PHOTON_BRIDGE_SECRET;
  const supplied = req.headers.get("x-smile-photon-secret") ?? "";
  if (!expected) return NextResponse.json({ error: "Photon bridge is not configured", code: "PHOTON_BRIDGE_NOT_CONFIGURED" }, { status: 503 });
  if (!same(supplied, expected)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const configuredProject = process.env.PHOTON_PROJECT_ID;
  if (!configuredProject || !/^pho_prj_[A-Za-z0-9_-]+$/.test(configuredProject))
    return NextResponse.json({ error: "Photon project is not configured", code: "PHOTON_PROJECT_NOT_CONFIGURED" }, { status: 503 });

  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "A valid JSON message is required" }, { status: 400 }); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "A message object is required" }, { status: 400 });
  const body = raw as Record<string, unknown>;
  const { projectId, messageId, spaceId, senderId, text } = body;
  if ([projectId, messageId, spaceId, senderId, text].some((value) => typeof value !== "string") || !(text as string).trim())
    return NextResponse.json({ error: "projectId, messageId, spaceId, senderId and text are required" }, { status: 400 });
  if ((text as string).length > 4_000 || [projectId, messageId, spaceId, senderId].some((value) => (value as string).length > 200))
    return NextResponse.json({ error: "Photon message is too large" }, { status: 413 });
  if (!/^pho_prj_[A-Za-z0-9_-]+$/.test(projectId as string) || ![messageId, spaceId].every((value) => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value as string)) || !/^[+A-Za-z0-9][A-Za-z0-9_.:+@-]*$/.test(senderId as string))
    return NextResponse.json({ error: "Invalid Photon message identity" }, { status: 400 });
  if (projectId !== configuredProject)
    return NextResponse.json({ error: "Photon project does not match this bridge" }, { status: 403 });
  if (!parseMention(text as string).mentioned)
    return NextResponse.json({ replies: [] });

  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const identity = {
    projectId: projectId as string,
    spaceId: spaceId as string,
    senderId: senderId as string,
  };
  try {
    const handoff = claimPhotonTripHandoff(text as string, identity);
    if (handoff.kind !== "none") {
      const id = `photon-handoff-${hash([projectId, spaceId, messageId]).slice(0, 24)}`;
      if (handoff.kind === "ready") {
        const summary = tripSummary(handoff.scope, "connected") ?? missingTripSummary(handoff.scope);
        return NextResponse.json({ replies: [{
          id,
          text: handoff.reused ? summary.replace("is connected.", "is connected again.") : summary,
          mapPath: handoff.mapPath,
        }] });
      }
      const textByKind = {
        invalid: "That route code is not valid. Return to your trip page and create a new Messages QR.",
        expired: "That route code or map access has expired. Return to your trip page and create a new Messages QR.",
        used: "That route code has already been claimed in another conversation. Return to your trip page and create a new Messages QR.",
      } as const;
      return NextResponse.json({ replies: [{ id, text: textByKind[handoff.kind] }] });
    }

    const binding = photonTripBinding(identity);
    if (binding) {
      const id = `photon-trip-update-${hash([projectId, spaceId, messageId]).slice(0, 24)}`;
      return NextResponse.json({ replies: [{
        id,
        text: tripSummary(binding, "update") ?? missingTripSummary(binding),
        ...(binding.mapPath ? { mapPath: binding.mapPath } : {}),
      }] });
    }
  } catch (error) {
    if (error instanceof PhotonHandoffStorageUnavailable) {
      return NextResponse.json({ error: error.message, code: "PHOTON_HANDOFF_STORAGE_UNAVAILABLE" }, { status: 503, headers: { "Retry-After": String(error.retryAfter ?? 5) } });
    }
    return NextResponse.json({ error: "The secure route handoff is temporarily unavailable.", code: "PHOTON_HANDOFF_UNAVAILABLE" }, { status: 503, headers: { "Retry-After": "5" } });
  }

  const sender = `Traveler ${hash([projectId, senderId]).slice(0, 24).toUpperCase()}`;
  const requestId = `photon:${hash([projectId, spaceId, messageId])}`;
  try {
    const result = await handleMessage(`photon:${hash([projectId, spaceId])}`, sender, text as string, {
      requestId,
      payloadHash: hash([projectId, messageId, spaceId, senderId, text]),
    });
    return NextResponse.json({
      replies: result.posted.filter((m) => m.bot).map((m) => ({ id: m.id, text: m.text, approvalPath: result.approvals[m.id] })),
    });
  } catch (error) {
    if (error instanceof ChatReplayConflict) return NextResponse.json({ error: error.message, code: "CHAT_REPLAY_CONFLICT" }, { status: 409 });
    if (error instanceof ChatBusy)
      return NextResponse.json({ error: error.message, code: "CHAT_BUSY" }, { status: 503, headers: { "Retry-After": "5" } });
    if (error instanceof ChatStorageUnavailable)
      return NextResponse.json({ error: error.message, code: "CHAT_STORAGE_UNAVAILABLE" }, { status: 503, headers: { "Retry-After": "5" } });
    return NextResponse.json({ error: "Photon could not process this message. Please retry the same message.", code: "PHOTON_PROCESSING_FAILED" }, { status: 500 });
  }
}
