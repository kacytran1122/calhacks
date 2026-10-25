import type { Cents } from "./types";

export const RULES = {
  R1: "Caps by one-way distance from the traveler's home ZIP to the venue: ≤50 mi $40 · ≤150 mi $90 · ≤400 mi $200 · farther $400.",
  R2: "Materiality: a difference of at most the larger of $1.00 or 3% of the approved quote is immaterial and is paid as settled.",
  R3: "Any payout over $150, and any exception to these rules, needs the controller's sign-off.",
  R4: "A traveler with a no-show in the prior 12 months must have a recorded venue check-in before being reimbursed.",
  R5: "A receipt can be reimbursed once. The fingerprint is merchant + amount + date + booking reference.",
  R6: "System of record when sources disagree: bank settlement > card authorization > receipt > traveler's claim.",
  R7: "If the price changes after approval, the traveler re-approves the exact new amount before anything settles.",
  R8: "Segregation of duties: whoever requests a spend cannot approve it.",
  R9: "Closed periods are locked. Late items post in the current open period, referencing the original trip.",
  R10: "Foreign-currency receipts are reimbursed at the bank's settled USD amount, not the receipt's FX rate.",
  R11: "A refund that arrives after reimbursement becomes a receivable from the traveler (or a card credit).",
  R12: "A traveler who never checked in (no-show) is not reimbursed; the no-show is recorded for R4.",
  R13: "Low-carbon preference: a train or bus is recommended over the cheapest option when it costs at most $10 or 25% more, takes at most 30 minutes or 25% longer, is about as reliable, and emits less CO₂e.",
} as const;

export type RuleId = keyof typeof RULES;

export const POLICY = {
  seasonBudgetCents: 600_000, // $6,000 sponsor-funded travel pool
  controllerThresholdCents: 15_000,
  materialityFloorCents: 100,
  materialityPct: 0.03,
  noShowLookbackDays: 365,
  irsMileageCentsPerMile: 70, // 2025 IRS standard mileage rate, used for drive estimates
  lowCarbon: { extraCents: 1_000, extraPct: 0.25, extraMinutes: 30, extraTimePct: 0.25, extraMissRisk: 0.05 }, // R13
};

export function capFor(distanceMiles: number): Cents {
  if (distanceMiles <= 50) return 4_000;
  if (distanceMiles <= 150) return 9_000;
  if (distanceMiles <= 400) return 20_000;
  return 40_000;
}

export function materialityFor(quoteCents: Cents): Cents {
  return Math.max(POLICY.materialityFloorCents, Math.round(quoteCents * POLICY.materialityPct));
}

export function isImmaterial(a: Cents, b: Cents, quoteCents: Cents): boolean {
  return Math.abs(a - b) <= materialityFor(quoteCents);
}
