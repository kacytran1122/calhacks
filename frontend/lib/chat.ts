import "server-only";
import { randomUUID } from "node:crypto";
import { buddiesFor, cachedTripPlan, chatStore, converse, fmt, issueTripToken, llmAvailable, loadState, planTrip, prepareChatTravel, updateChatTravelMemory, withState, type ChatTravelMemory, type DurableChatStore, type EventListing, type PlanTripResult } from "@smile/core";
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

type Plan = { initials: string; eventKey: string; eventName: string; mode: string; tripId?: string };
type Room = { messages: ChatMsg[]; plans: Map<string, Plan>; memory: Map<string, ChatTravelMemory>; listings: Map<string, EventListing> };
type StoredRoom = { messages: ChatMsg[]; plans: [string, Plan][]; memory: [string, ChatTravelMemory][]; listings: [string, EventListing][] };
export type ChatResult = { posted: ChatMsg[]; approvals: Record<string, string> };
export type ChatMessageOptions = { requestId?: string; payloadHash?: string; store?: DurableChatStore };

const emptyRoom = (): StoredRoom => ({ messages: [], plans: [], memory: [], listings: [] });
const hydrate = (r: StoredRoom): Room => ({ messages: r.messages, plans: new Map(r.plans), memory: new Map(r.memory), listings: new Map(r.listings) });
const stored = (r: Room): StoredRoom => ({ messages: r.messages.slice(-200), plans: [...r.plans].slice(-500), memory: [...r.memory].slice(-500), listings: [...r.listings].slice(-300) });

export const initialsOf = (name: string) => /^Traveler [A-F0-9]{24}$/.test(name)
  ? `T-${name.slice(9, 17)}`
  : name
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3) || "?";

function push(r: Room, m: Omit<ChatMsg, "id" | "at">): ChatMsg {
  const msg = { ...m, id: `m-${randomUUID()}`, at: new Date().toISOString() };
  r.messages.push(msg);
  if (r.messages.length > 200) r.messages.splice(0, r.messages.length - 200);
  return msg;
}

const bot = (r: Room, text: string, card?: PlanCard) => push(r, { from: "S’mile", initials: "S", text, bot: true, card });

export function view(chatId: string, store = chatStore()) {
  const r = store.read<StoredRoom>(chatId);
  return { messages: r.state?.messages ?? [], typing: r.busy };
}

export function resetRoom(chatId: string, store = chatStore()) {
  store.reset(chatId);
}

export function parseMention(text: string): { mentioned: boolean; zip?: string; url?: string } {
  const mentioned = /(^|[^\p{L}\p{N}_@])@smile(?=$|[^\p{L}\p{N}_])/iu.test(text);
  const url = text.match(/https?:\/\/[^\s<>"]+/)?.[0]?.replace(/[).,!?]+$/, "");
  const zip = text.replace(/https?:\/\/[^\s<>"]+/g, " ").match(/\b\d{5}\b/)?.[0];
  return { mentioned, zip, url };
}

function buddiesOf(r: Room, me: string): string[] {
  const mine = r.plans.get(me);
  if (!mine) return [];
  const local = [...r.plans.entries()].filter(([who, p]) => who !== me && p.eventKey === mine.eventKey && p.mode === mine.mode).map(([, p]) => p.initials);
  let global: string[] = [];
  if (mine.tripId) {
    try { global = buddiesFor(loadState(), mine.tripId).filter((buddy) => buddy.sameMode).map((buddy) => buddy.initials); }
    catch {}
  }
  return [...new Set([...local, ...global])];
}

const ride = (mode: string) => (mode === "drive" ? "driving" : `taking the ${mode}`);

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const approveLink = (tripId: string, travelerId: string) => `/desk#approve=${encodeURIComponent(issueTripToken(tripId, travelerId))}&trip=${encodeURIComponent(tripId)}`;

function tripReply(r: Room, name: string, me: string, p: PlanTripResult, approvals: Record<string, string>, options: { timingNeedsConfirmation?: boolean; expired?: boolean } = {}): ChatMsg[] {
  if (options.expired) return [bot(r, `@${me} your original trip to ${p.event.name} is saved, but its price and approval are no longer current. Please send a new @smile message to check the latest fare before approving.`)];
  const pick = p.routes?.pick;
  if (!p.routes) return [bot(r, `@${me} I couldn’t work out the distance to ${p.event.name} (the ZIP or venue location wasn’t found). Try another ZIP, or check the event link.`)];
  if (!pick) {
    const reason = p.routes.blockReason === "NO_VERIFIED_FARE"
      ? `I found routes to ${p.event.name}. Open the trip planner and use Check Fare beside a route before approving it.`
      : p.routes.blockReason === "TRAVELER_BUDGET"
        ? `no route to ${p.event.name} fits your travel budget.`
        : p.routes.blockReason === "MAX_DISTANCE"
          ? `${p.event.name} is outside your distance limit.`
          : `no option to ${p.event.name} fits the ${fmt(p.routes.cap)} organizer cap, so I’ve asked the organizer about an exception.`;
    return [bot(r, `@${me} ${reason}`)];
  }
  r.plans.set(name, { initials: me, eventKey: p.event.url ?? p.event.name, eventName: p.event.name, mode: pick.mode, tripId: p.trip.id });
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
  const scheduleNote = options.timingNeedsConfirmation ? " Your timing requirements are saved, but please confirm the service’s schedule before approving because those times have not been verified against this route." : "";
  const reply = bot(r, `@${me} best pick is ${ride(pick.mode)} to ${p.event.name}: ${fmt(pick.costCents)} (${miss}${card.co2eKg != null ? `, about ${card.co2eKg} kg CO₂e` : ""}). Nothing is charged until you approve. I’ve sent you a private approve link.${scheduleNote}`, card);
  approvals[reply.id] = approveLink(p.trip.id, p.trip.travelerId);
  const out = [reply];
  if (buddies.length) out.push(bot(r, `Buddy match: ${list([...buddies, me])} are ${buddies.length > 1 ? "all " : "both "}${ride(pick.mode)} to ${p.event.name}. Want to go together?`));
  return out;
}

async function respondWithConcierge(chatId: string, r: Room, name: string, me: string, text: string, mem: ChatTravelMemory, approvals: Record<string, string>, requestId?: string): Promise<ChatMsg[] | null> {
  if (!llmAvailable() || process.env.SMILE_CONCIERGE === "off") return null;
  try {
    ensureState();
    const transcript = r.messages.slice(-13, -1).map((m) => ({ from: m.bot ? "S’mile" : m.initials, text: m.text }));
    const c = await converse({ room: chatId, text, sender: { name: me, initials: me }, memory: mem, transcript, listings: r.listings, requestId });
    if (c.memory) r.memory.set(name, c.memory);
    const plan = c.plans.at(-1);
    let card: PlanCard | undefined;
    if (plan) {
      r.plans.set(name, { initials: me, eventKey: plan.eventKey, eventName: plan.eventName, mode: plan.mode, tripId: plan.tripId });
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
  }
}

export async function handleMessage(chatId: string, from: string, text: string, options: ChatMessageOptions = {}): Promise<ChatResult> {
  const request = options.requestId ? { id: options.requestId, payloadHash: options.payloadHash ?? "" } : undefined;
  return (options.store ?? chatStore()).transact(chatId, emptyRoom, async (data) => {
    const r = hydrate(data);
    const approvals: Record<string, string> = {};
    const posted = await respond(chatId, r, from, text.slice(0, 4_000), approvals, options.requestId);
    Object.assign(data, stored(r));
    return { posted, approvals };
  }, request);
}

async function respond(chatId: string, r: Room, from: string, text: string, approvals: Record<string, string>, requestId?: string): Promise<ChatMsg[]> {
  const name = from.trim().slice(0, 40) || "Guest";
  const me = initialsOf(name);
  const out = [push(r, { from: name, initials: me, text })];
  const { mentioned, zip, url } = parseMention(text);
  if (!mentioned) return out;

  const mem = updateChatTravelMemory(r.memory.get(name) ?? {}, text);
  if (zip) mem.zip = zip;
  if (url) mem.url = url;
  r.memory.set(name, mem);

  if (requestId) {
    ensureState();
    const cached = cachedTripPlan(loadState(), requestId);
    if (cached) {
      const age = Date.now() - Date.parse(cached.createdAt);
      return [...out, ...tripReply(r, name, me, cached.result, approvals, { expired: !Number.isFinite(age) || age < 0 || age >= 86_400_000, timingNeedsConfirmation: Boolean(cached.result.trip.travelConstraintSummary) })];
    }
  }

  const agentic = await respondWithConcierge(chatId, r, name, me, text, mem, approvals, requestId);
  if (agentic) return [...out, ...agentic];

  if (!mem.zip) {
    if (r.plans.has(name)) {
      const b = buddiesOf(r, name);
      out.push(bot(r, b.length ? `@${me} you’re riding with ${list(b)}.` : `@${me} no buddies on your route yet. I’ll say when someone joins.`));
    } else {
      out.push(bot(r, `@${me} choose an event and create your trip at https://smilefromhereto.work/finding-events. Then return here and message @smile to open your route.`));
    }
    return out;
  }

  try {
    if (!mem.url) {
      out.push(bot(r, `@${me} choose the event at https://smilefromhereto.work/finding-events so its destination and schedule are securely attached to this conversation.`));
      return out;
    }
    const prepared = await prepareChatTravel(mem, text, { origin: mem.zip });
    r.memory.set(name, prepared.memory);
    if (prepared.clarification) {
      out.push(bot(r, `@${me} ${prepared.clarification}`));
      return out;
    }
    ensureState();
    const p = await withState((s) => planTrip(s, { zip: mem.zip!, eventUrl: mem.url, initials: me, ...prepared.preferences, requestKey: requestId }));
    return [...out, ...tripReply(r, name, me, p, approvals, { timingNeedsConfirmation: Boolean(prepared.preferences.travelConstraints) })];
  } catch (e) {
    out.push(bot(r, `@${me} something went wrong planning that: ${e instanceof Error ? e.message : String(e)}`));
    return out;
  }
}
