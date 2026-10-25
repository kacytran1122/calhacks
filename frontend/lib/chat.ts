import "server-only";
import { converse, fmt, issueTripToken, llmAvailable, planTrip, withState, type EventListing } from "@smile/core";
import { ensureState } from "@/lib/server";

export type PlanCard = {
  eventName: string;
  mode: string;
  priceCents: number;
  capCents: number;
  pMiss: number | null;
  historyTrips: number;
  tripId: string;
  buddies: string[];
  co2eKg?: number | null;
  by?: "claude" | "code";
};

export type ChatMsg = { id: string; from: string; initials: string; text: string; at: string; bot?: boolean; card?: PlanCard };

type Plan = { initials: string; eventKey: string; eventName: string; mode: string };
type Room = { messages: ChatMsg[]; plans: Map<string, Plan>; memory: Map<string, { zip?: string; url?: string }>; listings: Map<string, EventListing>; pending: number };

const g = globalThis as typeof globalThis & { __smileChat?: Map<string, Room> };
const rooms = (g.__smileChat ??= new Map());

function room(chatId: string): Room {
  let r = rooms.get(chatId);
  if (!r) rooms.set(chatId, (r = { messages: [], plans: new Map(), memory: new Map(), listings: new Map(), pending: 0 }));
  return r;
}

export const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3) || "?";

let seq = 0;
function push(r: Room, m: Omit<ChatMsg, "id" | "at">): ChatMsg {
  const msg = { ...m, id: `m${Date.now().toString(36)}${(seq++).toString(36)}`, at: new Date().toISOString() };
  r.messages.push(msg);
  if (r.messages.length > 200) r.messages.splice(0, r.messages.length - 200);
  return msg;
}

const bot = (r: Room, text: string, card?: PlanCard) => push(r, { from: "S’mile", initials: "S", text, bot: true, card });

export function view(chatId: string) {
  const r = room(chatId);
  return { messages: r.messages, typing: r.pending > 0 };
}

export function resetRoom(chatId: string) {
  rooms.delete(chatId);
}

export function parseMention(text: string): { mentioned: boolean; zip?: string; url?: string } {
  const mentioned = /(^|\s)@smile\b/i.test(text);
  const url = text.match(/https?:\/\/[^\s<>"]+/)?.[0]?.replace(/[).,!?]+$/, "");
  const zip = text.replace(/https?:\/\/[^\s<>"]+/g, " ").match(/\b\d{5}\b/)?.[0];
  return { mentioned, zip, url };
}

function buddiesOf(r: Room, me: string): string[] {
  const mine = r.plans.get(me);
  if (!mine) return [];
  return [...r.plans.entries()].filter(([who, p]) => who !== me && p.eventKey === mine.eventKey && p.mode === mine.mode).map(([, p]) => p.initials);
}

const ride = (mode: string) => (mode === "drive" ? "driving" : `taking the ${mode}`);

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const approveLink = (tripId: string, travelerId: string) => `/desk#approve=${encodeURIComponent(issueTripToken(tripId, travelerId))}&trip=${encodeURIComponent(tripId)}`;

/** Claude picks the tools for this message. Returns null when it can't run, so the rule-based path answers. */
async function respondWithConcierge(chatId: string, r: Room, name: string, me: string, text: string, mem: { zip?: string; url?: string }, approvals: Record<string, string>): Promise<ChatMsg[] | null> {
  if (!llmAvailable() || process.env.SMILE_CONCIERGE === "off") return null;
  r.pending++;
  try {
    ensureState();
    // Earlier messages go to Claude with initials only, never full names.
    const transcript = r.messages.slice(-13, -1).map((m) => ({ from: m.bot ? "S’mile" : m.initials, text: m.text }));
    const c = await converse({ room: chatId, text, sender: { name: me, initials: me }, memory: mem, transcript, listings: r.listings });
    const plan = c.plans.at(-1);
    let card: PlanCard | undefined;
    if (plan) {
      r.plans.set(name, { initials: me, eventKey: plan.eventKey, eventName: plan.eventName, mode: plan.mode });
      const buddies = [...new Set([...buddiesOf(r, name), ...plan.buddies])];
      card = { eventName: plan.eventName, mode: plan.mode, priceCents: plan.priceCents, capCents: plan.capCents, pMiss: plan.pMiss, historyTrips: plan.historyTrips, tripId: plan.tripId, buddies, co2eKg: plan.co2eKg, by: c.by };
    }
    const reply = bot(r, c.reply, card);
    const out = [reply];
    if (plan) {
      approvals[reply.id] = approveLink(plan.tripId, plan.travelerId);
      if (card!.buddies.length) out.push(bot(r, `Buddy match: ${list([...card!.buddies, me])} are ${card!.buddies.length > 1 ? "all " : "both "}${ride(plan.mode)} to ${plan.eventName}. Want to go together?`));
    }
    return out;
  } catch {
    return null;
  } finally {
    r.pending--;
  }
}

export async function handleMessage(chatId: string, from: string, text: string): Promise<{ posted: ChatMsg[]; approvals: Record<string, string> }> {
  const approvals: Record<string, string> = {};
  const posted = await respond(chatId, from, text, approvals);
  return { posted, approvals };
}

async function respond(chatId: string, from: string, text: string, approvals: Record<string, string>): Promise<ChatMsg[]> {
  const r = room(chatId);
  const name = from.trim().slice(0, 40) || "Guest";
  const me = initialsOf(name);
  const out = [push(r, { from: name, initials: me, text: text.slice(0, 1000) })];
  const { mentioned, zip, url } = parseMention(text);
  if (!mentioned) return out;

  const mem = r.memory.get(name) ?? {};
  if (zip) mem.zip = zip;
  if (url) mem.url = url;
  r.memory.set(name, mem);

  const agentic = await respondWithConcierge(chatId, r, name, me, text, mem, approvals);
  if (agentic) return [...out, ...agentic];

  if (!mem.zip) {
    if (r.plans.has(name)) {
      const b = buddiesOf(r, name);
      out.push(bot(r, b.length ? `@${me} you’re riding with ${list(b)}.` : `@${me} no buddies on your route yet. I’ll say when someone joins.`));
    } else {
      out.push(bot(r, `@${me} send me your home ZIP and, if you have it, the event link. For example: @smile 95616 https://lu.ma/your-event`));
    }
    return out;
  }

  r.pending++;
  try {
    ensureState();
    const p = await withState((s) => planTrip(s, { zip: mem.zip!, eventUrl: mem.url, initials: me }));
    const pick = p.routes?.pick;
    if (!p.routes) {
      out.push(bot(r, `@${me} I couldn’t work out the distance to ${p.event.name} (the ZIP or venue location wasn’t found). Try another ZIP, or check the event link.`));
      return out;
    }
    if (!pick) {
      const reason = p.routes.blockReason === "NO_VERIFIED_FARE"
        ? `I found routes to ${p.event.name}, but no live source stated a complete fare, so I did not create a payment approval.`
        : p.routes.blockReason === "TRAVELER_BUDGET"
          ? `no route to ${p.event.name} fits your travel budget.`
          : p.routes.blockReason === "MAX_DISTANCE"
            ? `${p.event.name} is outside your distance limit.`
            : `no option to ${p.event.name} fits the ${fmt(p.routes.cap)} organizer cap, so I’ve asked the organizer about an exception.`;
      out.push(bot(r, `@${me} ${reason}`));
      return out;
    }
    r.plans.set(name, { initials: me, eventKey: p.event.url ?? p.event.name, eventName: p.event.name, mode: pick.mode });
    const buddies = buddiesOf(r, name);
    const card: PlanCard = {
      eventName: p.event.name,
      mode: pick.mode,
      priceCents: pick.costCents,
      capCents: p.routes.cap,
      pMiss: pick.history.trips ? pick.pMiss : null,
      historyTrips: pick.history.trips,
      tripId: p.trip.id,
      buddies,
      co2eKg: pick.co2eKg ?? null,
      by: "code",
    };
    const miss = card.pMiss === null ? "no trip history for this mode yet" : `${Math.round(card.pMiss * 100)}% chance of missing kickoff`;
    const reply = bot(r, `@${me} best pick is ${ride(pick.mode)} to ${p.event.name}: ${fmt(pick.costCents)} (${miss}${card.co2eKg != null ? `, about ${card.co2eKg} kg CO₂e` : ""}). Nothing is charged until you approve. I’ve sent you a private approve link.`, card);
    out.push(reply);
    approvals[reply.id] = approveLink(p.trip.id, p.trip.travelerId);
    if (buddies.length) out.push(bot(r, `Buddy match: ${list([...buddies, me])} are ${buddies.length > 1 ? "all " : "both "}${ride(pick.mode)} to ${p.event.name}. Want to go together?`));
    return out;
  } catch (e) {
    out.push(bot(r, `@${me} something went wrong planning that: ${e instanceof Error ? e.message : String(e)}`));
    return out;
  } finally {
    r.pending--;
  }
}
