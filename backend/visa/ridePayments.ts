import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { appendAudit } from "../hyphenate/audit";
import type { State } from "../src/store";

export const RIDE_DEMO_COOKIE = "smile_ride_demo";
export const RIDE_DEMO_SESSION_SECONDS = 30 * 24 * 60 * 60;
export const RIDE_DEMO_LIMITS = { bodyBytes: 8_192, tripBodyBytes: 40_960, tripLegs: 40, receiptsPerOwner: 100, receipts: 5_000, tripReceiptsPerOwner: 25, tripReceipts: 1_000, owners: 1_000, maxAmountCents: 100_000 } as const;

const text = (max: number) => z.string().max(max).trim().min(1).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const RideInput = z.object({
  journeyId: text(200).optional(),
  legId: text(200),
  mode: z.enum(["bus", "train", "taxi"]),
  service: text(120),
  from: text(240),
  to: text(240),
  amountCents: z.number().int().min(1).max(RIDE_DEMO_LIMITS.maxAmountCents),
  completed: z.literal(true),
  consent: z.literal(true),
}).strict();

const TripLegInput = z.object({
  legId: text(200), mode: z.enum(["bus", "train", "taxi"]), service: text(120), from: text(240), to: text(240), expectedReceiptId: text(200).optional(),
}).strict();
const TripInput = z.object({
  journeyId: text(200), from: text(240), to: text(240), legs: z.array(TripLegInput).max(RIDE_DEMO_LIMITS.tripLegs), completed: z.literal(true),
}).strict().refine((input) => new Set(input.legs.map((leg) => leg.legId)).size === input.legs.length);

export interface RideDemoReceipt {
  id: string;
  journeyId?: string;
  legId: string;
  mode: "bus" | "train" | "taxi";
  service: string;
  from: string;
  to: string;
  amountCents: number;
  currency: "USD";
  paidAt: string;
  provenance: "simulated";
  captured: false;
  provider: "visa_simulation";
  amountSource: "traveler_entered_demo";
}

export interface TripDemoReceipt {
  id: string;
  journeyId: string;
  from: string;
  to: string;
  createdAt: string;
  currency: "USD";
  totalRecordedCents: number;
  legs: { legId: string; mode: "bus" | "train" | "taxi"; service: string; from: string; to: string; status: "demo_receipt_recorded" | "no_payment_recorded"; receiptId?: string; amountCents: number | null }[];
  provenance: "simulated";
  captured: false;
  provider: "visa_simulation";
  amountSource: "owned_demo_receipts";
}

export interface RidePaymentState {
  owners: { ownerHash: string; expiresAt: string }[];
  receipts: { ownerHash: string; fingerprint: string; receipt: RideDemoReceipt }[];
  tripReceipts?: { ownerHash: string; fingerprint: string; receipt: TripDemoReceipt }[];
}

export class RidePaymentError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
    this.name = "RidePaymentError";
  }
}

export function requireRideDemoStorage(env: NodeJS.ProcessEnv = process.env) {
  if (env.VERCEL) throw new RidePaymentError("Simulated receipts need the persistent application service. Please try again later.", 503, "ride_demo_storage_unavailable");
}

const ownerHash = (token: string) => createHash("sha256").update(token).digest("hex");

function activeState(state: State, now: Date) {
  const data = state.ridePayments ??= { owners: [], receipts: [] };
  data.owners = data.owners.filter((owner) => Date.parse(owner.expiresAt) > now.getTime());
  const active = new Set(data.owners.map((owner) => owner.ownerHash));
  data.receipts = data.receipts.filter((entry) => active.has(entry.ownerHash));
  if (data.tripReceipts) data.tripReceipts = data.tripReceipts.filter((entry) => active.has(entry.ownerHash));
  return data;
}

function ownerFor(state: State, token: string, now: Date) {
  const data = activeState(state, now);
  const hash = /^[A-Za-z0-9_-]{43}$/.test(token) ? ownerHash(token) : "";
  const owner = data.owners.find((candidate) => candidate.ownerHash === hash);
  if (!owner) throw new RidePaymentError("Your demo receipt session has expired. Re-enable simulated receipts to start a new session.", 401, "ride_demo_session_expired");
  return { data, owner };
}

export function createRideDemoOwner(state: State, now = new Date()) {
  const data = activeState(state, now);
  if (data.owners.length >= RIDE_DEMO_LIMITS.owners) throw new RidePaymentError("Simulated receipt storage is full. Please try again later.", 429, "ride_demo_limit");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + RIDE_DEMO_SESSION_SECONDS * 1_000).toISOString();
  data.owners.push({ ownerHash: ownerHash(token), expiresAt });
  return { token, expiresAt };
}

export function listRidePayments(state: State, token: string, now = new Date()): RideDemoReceipt[] {
  const { data, owner } = ownerFor(state, token, now);
  return data.receipts.filter((entry) => entry.ownerHash === owner.ownerHash).map((entry) => ({ ...entry.receipt })).reverse();
}

export function parseRidePaymentInput(input: unknown) {
  const parsed = RideInput.safeParse(input);
  if (!parsed.success) throw new RidePaymentError("Enter the ride details and a demo amount, then confirm you have left the vehicle and consent to simulation. Card and additional fields are not accepted.", 400, "ride_demo_invalid_input");
  return parsed.data;
}

export function createRidePayment(state: State, token: string, input: unknown, now = new Date()): { receipt: RideDemoReceipt; replayed: boolean } {
  const payload = parseRidePaymentInput(input);
  const { data, owner } = ownerFor(state, token, now);
  const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const previous = data.receipts.find((entry) => entry.ownerHash === owner.ownerHash && entry.receipt.legId === payload.legId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new RidePaymentError("A demo receipt already exists for this ride with different details. Its original amount has been kept.", 409, "ride_demo_conflict");
    return { receipt: { ...previous.receipt }, replayed: true };
  }
  if (payload.journeyId && data.tripReceipts?.some((entry) => entry.ownerHash === owner.ownerHash && entry.receipt.journeyId === payload.journeyId)) throw new RidePaymentError("This journey already has a final demo receipt. Its recorded amounts cannot be changed.", 409, "ride_demo_journey_closed");
  if (data.receipts.length >= RIDE_DEMO_LIMITS.receipts || data.receipts.filter((entry) => entry.ownerHash === owner.ownerHash).length >= RIDE_DEMO_LIMITS.receiptsPerOwner) throw new RidePaymentError("The simulated receipt limit has been reached. Existing receipts remain available.", 429, "ride_demo_limit");
  const receipt: RideDemoReceipt = {
    id: `ride_sim_${randomUUID()}`,
    ...(payload.journeyId ? { journeyId: payload.journeyId } : {}),
    legId: payload.legId,
    mode: payload.mode,
    service: payload.service,
    from: payload.from,
    to: payload.to,
    amountCents: payload.amountCents,
    currency: "USD",
    paidAt: now.toISOString(),
    provenance: "simulated",
    captured: false,
    provider: "visa_simulation",
    amountSource: "traveler_entered_demo",
  };
  data.receipts.push({ ownerHash: owner.ownerHash, fingerprint, receipt });
  appendAudit(state, { actor: { kind: "agent", id: "payments" }, action: "ride_demo.receipt_created", subject: receipt.id, reason: "Created a simulated ride receipt. No funds were captured.", refs: [receipt.id] });
  return { receipt: { ...receipt }, replayed: false };
}

export function parseTripDemoReceiptInput(input: unknown) {
  const parsed = TripInput.safeParse(input);
  if (!parsed.success) throw new RidePaymentError("Enter a completed journey and distinct ride details. Client amounts, card details, and additional fields are not accepted.", 400, "ride_demo_invalid_input");
  return parsed.data;
}

const copyTripReceipt = (receipt: TripDemoReceipt): TripDemoReceipt => ({ ...receipt, legs: receipt.legs.map((leg) => ({ ...leg })) });

export function listTripDemoReceipts(state: State, token: string, now = new Date()): TripDemoReceipt[] {
  const { data, owner } = ownerFor(state, token, now);
  return (data.tripReceipts ?? []).filter((entry) => entry.ownerHash === owner.ownerHash).map((entry) => copyTripReceipt(entry.receipt)).reverse();
}

export function createTripDemoReceipt(state: State, token: string, input: unknown, now = new Date()): { receipt: TripDemoReceipt; replayed: boolean } {
  const payload = parseTripDemoReceiptInput(input);
  const { data, owner } = ownerFor(state, token, now);
  const entries = data.tripReceipts ?? [];
  const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const previous = entries.find((entry) => entry.ownerHash === owner.ownerHash && entry.receipt.journeyId === payload.journeyId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new RidePaymentError("This journey already has a final demo receipt with different details. Its original record has been kept.", 409, "ride_demo_conflict");
    return { receipt: copyTripReceipt(previous.receipt), replayed: true };
  }
  const owned = data.receipts.filter((entry) => entry.ownerHash === owner.ownerHash && entry.receipt.journeyId === payload.journeyId).map((entry) => entry.receipt);
  const unverifiable = () => new RidePaymentError("The journey’s ride receipts could not be verified. Keep your downloaded receipts and try again from the original receipt session.", 409, "ride_demo_trip_unverifiable");
  if (owned.some((receipt) => !payload.legs.some((leg) => leg.legId === receipt.legId))) throw unverifiable();
  const legs: TripDemoReceipt["legs"] = payload.legs.map((leg) => {
    const receipt = owned.find((entry) => entry.legId === leg.legId);
    if ((leg.expectedReceiptId && receipt?.id !== leg.expectedReceiptId) || (receipt && (receipt.mode !== leg.mode || receipt.service !== leg.service || receipt.from !== leg.from || receipt.to !== leg.to))) throw unverifiable();
    return { legId: leg.legId, mode: leg.mode, service: leg.service, from: leg.from, to: leg.to, status: receipt ? "demo_receipt_recorded" : "no_payment_recorded", ...(receipt ? { receiptId: receipt.id } : {}), amountCents: receipt?.amountCents ?? null };
  });
  if (entries.length >= RIDE_DEMO_LIMITS.tripReceipts || entries.filter((entry) => entry.ownerHash === owner.ownerHash).length >= RIDE_DEMO_LIMITS.tripReceiptsPerOwner) throw new RidePaymentError("The final demo receipt limit has been reached. Existing receipts remain available.", 429, "ride_demo_limit");
  const receipt: TripDemoReceipt = { id: `trip_sim_${randomUUID()}`, journeyId: payload.journeyId, from: payload.from, to: payload.to, createdAt: now.toISOString(), currency: "USD", totalRecordedCents: legs.reduce((sum, leg) => sum + (leg.amountCents ?? 0), 0), legs, provenance: "simulated", captured: false, provider: "visa_simulation", amountSource: "owned_demo_receipts" };
  data.tripReceipts = [...entries, { ownerHash: owner.ownerHash, fingerprint, receipt }];
  appendAudit(state, { actor: { kind: "agent", id: "payments" }, action: "ride_demo.trip_receipt_created", subject: receipt.id, reason: "Consolidated simulated ride records. No new payment or funds captured.", refs: [receipt.id] });
  return { receipt: copyTripReceipt(receipt), replayed: false };
}
