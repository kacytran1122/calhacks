import { appendAudit } from "../hyphenate/audit";
import { fmt } from "../src/money";
import { authorize } from "../src/permissions";
import type { State } from "../src/store";
import { newId } from "../src/store";
import type { Cents, Evidence } from "../src/types";
import { checkMandate } from "./visaSim";
import { authorizeVisaAcceptance, visaAcceptanceConfigured } from "./visaAcceptance";
import { paymentPreflight } from "../hyphenate/financeControls";

const agent = { kind: "agent" as const, id: "payments" as const };

export async function chargeTrip(state: State, tripId: string, amountCents: Cents, descriptor: string): Promise<{ ok: boolean; evidence: Evidence[]; detail: string }> {
  authorize(state, agent, "mandate.charge", tripId);
  const trip = state.trips.find((t) => t.id === tripId);
  const m = state.mandates.find((x) => x.id === trip?.mandateId);
  if (!trip || !m) throw new Error(`no mandate for ${tripId}`);
  const preflight = paymentPreflight(state, trip, m, amountCents, m.merchantCategory);
  if (!preflight.ok) {
    appendAudit(state, { actor: agent, action: "card.blocked", subject: tripId, reason: preflight.detail, refs: preflight.refs });
    return { ok: false, evidence: [], detail: preflight.detail };
  }
  const control = checkMandate(m, amountCents, m.merchantCategory);
  const visa = control.ok && visaAcceptanceConfigured() ? await authorizeVisaAcceptance({ amountCents, reference: preflight.idempotencyKey }) : undefined;
  const ok = control.ok && (!visa || visa.ok);
  const detail = !control.ok ? control.detail : visa && !visa.ok ? visa.detail : `authorized ${fmt(amountCents)}`;
  const visaId = visa && "id" in visa ? visa.id : undefined;
  const visaStatus = visa && "status" in visa ? visa.status : undefined;
  const correlationId = visa && "correlationId" in visa ? visa.correlationId : undefined;
  const visaReason = visa && !visa.ok ? visa.reason : undefined;
  if (ok) m.status = "consumed";
  const at = new Date().toISOString();
  m.authorization = {
    idempotencyKey: preflight.idempotencyKey,
    provider: visa ? "visa_acceptance" : "simulated",
    providerReference: visaId,
    status: ok ? "authorized" : "declined",
    amountCents,
    authorizedAt: at,
  };
  const auth: Evidence = {
    id: newId("EV-auth"),
    tripId,
    kind: "card_auth",
    source: visa ? "Visa Acceptance sandbox" : "Visa mandate network (SIMULATED)",
    fetchedAt: at,
    status: visa && !visa.ok && visa.reason === "network" ? "error" : "ok",
    provenance: visa ? "testnet" : "simulated",
    data: { amountCents, currency: "USD", result: ok ? "approved" : "declined", declineReason: ok ? undefined : !control.ok ? control.reason : visaReason, mandateId: m.id, approvalFingerprint: m.approvalBinding?.fingerprint, idempotencyKey: preflight.idempotencyKey, authCode: visa?.ok ? visa.authCode : control.ok ? control.authCode : undefined, visaTransactionId: visaId, visaStatus, correlationId, captured: false },
  };
  state.evidence.push(auth);
  const out = [auth];
  if (ok) {
    if (!visa) {
      const line: Evidence = { id: newId("EV-bank"), tripId, kind: "bank_line", source: "Card statement feed (SIMULATED settlement)", fetchedAt: at, status: "ok", provenance: "simulated", data: { amountCents, currency: "USD", descriptor, postedDate: at.slice(0, 10), captured: false } };
      state.evidence.push(line);
      out.push(line);
    }
    trip.state = "booked";
  }
  appendAudit(state, {
    actor: agent,
    action: ok ? "card.authorized" : "card.declined",
    subject: tripId,
    reason: ok ? `Authorized ${fmt(amountCents)} with capture disabled on single-use token ${m.token}` : `Declined ${fmt(amountCents)}: ${detail}`,
    refs: [auth.id, m.id, ...(ok ? [] : ["R7"])],
  });
  return { ok, evidence: out, detail };
}
