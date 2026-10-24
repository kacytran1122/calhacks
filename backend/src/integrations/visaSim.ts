import { randomBytes } from "node:crypto";
import type { Cents, Mandate } from "../types";

export function createMandate(args: { tripId: string; maxCents: Cents; merchantCategory: string; requestedBy: string; ttlHours?: number }): Mandate {
  return {
    id: `MDT-${randomBytes(3).toString("hex")}`,
    tripId: args.tripId,
    token: `vtok_sim_${randomBytes(6).toString("hex")}`,
    maxCents: args.maxCents,
    merchantCategory: args.merchantCategory,
    expiresAt: new Date(Date.now() + (args.ttlHours ?? 72) * 3_600_000).toISOString(),
    singleUse: true,
    status: "pending",
    requestedBy: args.requestedBy,
    provenance: "simulated",
  };
}

export type ChargeResult =
  | { ok: true; authCode: string; amountCents: Cents }
  | { ok: false; reason: "not_approved" | "already_used" | "expired" | "amount_exceeds_mandate" | "wrong_merchant_category"; detail: string };

export function chargeMandate(m: Mandate, amountCents: Cents, merchantCategory: string, now = new Date()): ChargeResult {
  if (m.status === "consumed") return { ok: false, reason: "already_used", detail: "single-use token already settled" };
  if (m.status !== "approved") return { ok: false, reason: "not_approved", detail: `mandate is ${m.status}` };
  if (now > new Date(m.expiresAt)) return { ok: false, reason: "expired", detail: `expired ${m.expiresAt}` };
  if (merchantCategory !== m.merchantCategory)
    return { ok: false, reason: "wrong_merchant_category", detail: `${merchantCategory} ≠ ${m.merchantCategory}` };
  if (amountCents > m.maxCents)
    return { ok: false, reason: "amount_exceeds_mandate", detail: `charge ${amountCents}¢ > approved ${m.maxCents}¢` };
  m.status = "consumed";
  return { ok: true, authCode: `SIM${randomBytes(3).toString("hex").toUpperCase()}`, amountCents };
}
