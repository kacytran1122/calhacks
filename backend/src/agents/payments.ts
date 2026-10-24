import { appendAudit } from "../audit";
import { fmt } from "../money";
import { authorize } from "../permissions";
import type { State } from "../store";
import { newId } from "../store";
import type { Cents, Evidence } from "../types";
import { chargeMandate } from "../integrations/visaSim";

const agent = { kind: "agent" as const, id: "payments" as const };

export function chargeTrip(state: State, tripId: string, amountCents: Cents, descriptor: string): { ok: boolean; evidence: Evidence[]; detail: string } {
  authorize(state, agent, "mandate.charge", tripId);
  const trip = state.trips.find((t) => t.id === tripId);
  const m = state.mandates.find((x) => x.id === trip?.mandateId);
  if (!trip || !m) throw new Error(`no mandate for ${tripId}`);
  const r = chargeMandate(m, amountCents, m.merchantCategory);
  const at = new Date().toISOString();
  const auth: Evidence = {
    id: newId("EV-auth"),
    tripId,
    kind: "card_auth",
    source: "Visa mandate network (SIMULATED)",
    fetchedAt: at,
    status: "ok",
    provenance: "simulated",
    data: { amountCents, currency: "USD", result: r.ok ? "approved" : "declined", declineReason: r.ok ? undefined : r.reason, mandateId: m.id, authCode: r.ok ? r.authCode : undefined },
  };
  state.evidence.push(auth);
  const out = [auth];
  if (r.ok) {
    const line: Evidence = { id: newId("EV-bank"), tripId, kind: "bank_line", source: "Card statement feed (SIMULATED settlement)", fetchedAt: at, status: "ok", provenance: "simulated", data: { amountCents, currency: "USD", descriptor, postedDate: at.slice(0, 10) } };
    state.evidence.push(line);
    out.push(line);
    trip.state = "booked";
  }
  appendAudit(state, {
    actor: agent,
    action: r.ok ? "card.charged" : "card.declined",
    subject: tripId,
    reason: r.ok ? `Charged ${fmt(amountCents)} on single-use token ${m.token}` : `Declined ${fmt(amountCents)}: ${r.detail}`,
    refs: [auth.id, m.id, ...(r.ok ? [] : ["R7"])],
  });
  return { ok: r.ok, evidence: out, detail: r.ok ? `charged ${fmt(amountCents)}` : r.detail };
}
