import { createHash } from "node:crypto";
import { trialBalance } from "./ledger";
import type { State } from "./store";
import type { Cents, Mandate, Trip } from "./types";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const latestQuote = (state: State, tripId: string) =>
  state.evidence.filter((e) => e.tripId === tripId && e.kind === "quote" && e.status === "ok").at(-1);

export function bindApproval(state: State, trip: Trip, mandate: Mandate, approvedAt: string) {
  const quote = latestQuote(state, trip.id);
  if (!quote) throw new Error("the approval has no current fare evidence");
  const binding = {
    travelerId: trip.travelerId,
    eventId: trip.eventId,
    fareEvidenceId: quote.id,
    amountCents: mandate.maxCents,
    currency: "USD" as const,
    merchantCategory: mandate.merchantCategory,
    approvedAt,
  };
  mandate.approvalBinding = { ...binding, fingerprint: hash(binding) };
  return mandate.approvalBinding;
}

export type PaymentControlCode =
  | "ready"
  | "approval_not_bound"
  | "approval_changed"
  | "stale_fare"
  | "duplicate_authorization";

export function paymentPreflight(
  state: State,
  trip: Trip,
  mandate: Mandate,
  amountCents: Cents,
  merchantCategory: string,
): { ok: true; code: "ready"; idempotencyKey: string; refs: string[] } | { ok: false; code: Exclude<PaymentControlCode, "ready">; detail: string; refs: string[] } {
  const binding = mandate.approvalBinding;
  if (!binding) return { ok: false, code: "approval_not_bound", detail: "the authorization is not bound to a traveler-approved fare", refs: [mandate.id] };
  const currentQuote = latestQuote(state, trip.id);
  const fingerprint = hash({
    travelerId: trip.travelerId,
    eventId: trip.eventId,
    fareEvidenceId: binding.fareEvidenceId,
    amountCents,
    currency: "USD",
    merchantCategory,
    approvedAt: binding.approvedAt,
  });
  if (fingerprint !== binding.fingerprint || amountCents !== binding.amountCents || merchantCategory !== binding.merchantCategory)
    return { ok: false, code: "approval_changed", detail: "the traveler-approved amount, traveler, event, or merchant category changed", refs: [mandate.id, binding.fareEvidenceId] };
  if (!currentQuote || currentQuote.id !== binding.fareEvidenceId || Number(currentQuote.data.amountCents) !== binding.amountCents)
    return { ok: false, code: "stale_fare", detail: "the approved fare is no longer the current fare evidence", refs: [mandate.id, binding.fareEvidenceId, ...(currentQuote ? [currentQuote.id] : [])] };
  const idempotencyKey = hash({ tripId: trip.id, mandateId: mandate.id, amountCents, merchantCategory }).slice(0, 32);
  if (mandate.authorization || state.evidence.some((e) => e.kind === "card_auth" && e.data.idempotencyKey === idempotencyKey))
    return { ok: false, code: "duplicate_authorization", detail: "this exact authorization request was already processed", refs: [mandate.id, idempotencyKey] };
  return { ok: true, code: "ready", idempotencyKey, refs: [mandate.id, binding.fareEvidenceId] };
}

export function closeReadiness(state: State) {
  const tb = trialBalance(state);
  const debits = tb.reduce((total, row) => total + row.debit, 0);
  const credits = tb.reduce((total, row) => total + row.credit, 0);
  const openItems = state.inbox.filter((item) => item.status === "open");
  const unresolvedTrips = state.trips.filter((trip) => trip.state === "submitted" || trip.state === "needs_human");
  const duplicateKeys = state.evidence
    .filter((e) => e.kind === "card_auth" && typeof e.data.idempotencyKey === "string")
    .map((e) => String(e.data.idempotencyKey))
    .filter((key, index, all) => all.indexOf(key) !== index);
  const authorizedCents = state.evidence
    .filter((e) => e.kind === "card_auth" && e.data.result === "approved")
    .reduce((total, e) => total + Number(e.data.amountCents ?? 0), 0);
  const reimbursedCents = state.trips
    .filter((trip) => trip.state === "reimbursed" || trip.state === "closed")
    .reduce((total, trip) => total + Math.max(0, trip.decision?.payCents ?? 0), 0);
  const issues = [
    ...(debits !== credits ? [`trial balance differs by ${Math.abs(debits - credits)} cents`] : []),
    ...(openItems.length ? [`${openItems.length} approval or exception item(s) remain open`] : []),
    ...(unresolvedTrips.length ? [`${unresolvedTrips.length} trip(s) remain unresolved`] : []),
    ...(duplicateKeys.length ? [`${new Set(duplicateKeys).size} duplicate authorization key(s) detected`] : []),
  ];
  return {
    ready: issues.length === 0,
    period: state.company.openPeriod,
    approvedCents: state.mandates.filter((m) => m.status === "approved" || m.status === "consumed").reduce((total, m) => total + m.maxCents, 0),
    authorizedCents,
    reimbursedCents,
    openItems: openItems.length,
    unresolvedTrips: unresolvedTrips.length,
    booksBalanced: debits === credits,
    duplicateAuthorizations: new Set(duplicateKeys).size,
    issues,
  };
}
