/**
 * Explaining and defending decisions.
 *
 * Claude gets the full trace for one trip (evidence with provenance, the decision, the
 * rule text, audit events, journal entries) and must answer only from it. Every id it
 * cites is checked against the trace; an answer that cites nothing real is thrown out
 * and replaced by the template. It can concede — a system that never concedes isn't
 * defending, it's stonewalling — but it can't change the books from here.
 */
import { z } from "zod";
import { fmt } from "../money";
import { RULES, type RuleId } from "../policy";
import type { State } from "../store";
import type { Decision, Trip } from "../types";
import { llmAvailable, structured } from "../llm";

export function traceFor(state: State, tripId: string) {
  const trip = state.trips.find((t) => t.id === tripId);
  if (!trip) throw new Error(`no trip ${tripId}`);
  const evidence = state.evidence.filter((e) => e.tripId === tripId);
  const decision = trip.decision;
  const ruleIds = (decision?.refs ?? []).filter((r): r is RuleId => r in RULES);
  const journal = state.journal.filter((j) => j.refs.includes(tripId));
  const audit = state.audit.filter((a) => a.subject === tripId || a.refs.includes(tripId) || journal.some((j) => j.id === a.subject));
  const linkedTrips = (decision?.refs ?? []).filter((r) => r.startsWith("TR-") && r !== tripId);
  const linkedEvidence = state.evidence.filter((e) => decision?.refs.includes(e.id) && e.tripId !== tripId);
  return {
    company: `${state.company.name} — ${state.company.program}`,
    trip,
    traveler: state.travelers.find((t) => t.id === trip.travelerId),
    event: state.events.find((e) => e.id === trip.eventId),
    evidence: [...evidence, ...linkedEvidence],
    decision,
    rules: Object.fromEntries(ruleIds.map((r) => [r, RULES[r]])),
    journal,
    audit: audit.map((a) => ({ seq: a.seq, at: a.at, actor: a.actor, action: a.action, reason: a.reason, refs: a.refs })),
    linkedTrips,
    people: state.people,
  };
}

function knownIds(t: ReturnType<typeof traceFor>): Set<string> {
  return new Set<string>([
    t.trip.id,
    ...t.evidence.map((e) => e.id),
    ...Object.keys(t.rules),
    ...Object.keys(RULES),
    ...t.journal.map((j) => j.id),
    ...t.linkedTrips,
    ...t.people.map((p) => p.id),
    ...(t.decision?.refs ?? []),
  ]);
}

const SYSTEM = `You are the explanation layer of S'mile Desk, the autonomous travel-reimbursement and card-reconciliation system for a student hackathon's finance team.
You receive one trip's complete trace as JSON. Answer ONLY from that trace. Cite the exact ids (evidence ids like "EV-...", rule ids like "R6", journal ids like "JE-0042", person ids like "P-maya") that support each claim.
Amounts in the trace are integer cents. The decision's amount and code were computed by deterministic code; you explain them, you don't change them.
Write for a busy volunteer controller: plain, specific, no filler. Say what each source said, which one the policy trusts, and why.`;

const ExplanationSchema = z.object({
  summary: z.string().describe("2-4 sentences explaining the decision to the controller"),
  citedIds: z.array(z.string()),
});

export function templateExplanation(trip: Trip, d: Decision): string {
  return `${d.code.replace(/_/g, " ")} · ${fmt(d.payCents)}. ${d.reasons.join(" ")}`;
}

export async function explain(state: State, tripId: string): Promise<{ text: string; by: "claude" | "template"; cited: string[] }> {
  const t = traceFor(state, tripId);
  if (!t.decision) throw new Error("trip has no decision yet");
  if (llmAvailable()) {
    try {
      const out = await structured(ExplanationSchema, { model: "reason", system: SYSTEM, user: `Explain this decision.\n\n${JSON.stringify(t)}`, effort: "low" });
      const ids = knownIds(t);
      const cited = out.citedIds.filter((id) => ids.has(id));
      if (cited.length > 0) return { text: out.summary, by: "claude", cited };
    } catch {
      /* fall through to the template; the reason is not user-facing */
    }
  }
  return { text: templateExplanation(t.trip, t.decision), by: "template", cited: t.decision.refs };
}

const DefenseSchema = z.object({
  stance: z.enum(["defend", "concede", "need_more_info"]),
  answer: z.string().describe("Direct answer to the question, 2-6 sentences, citing ids inline like [EV-...]"),
  citedIds: z.array(z.string()),
  whatWouldChangeTheDecision: z.string().describe("The specific new evidence or rule that would change this decision"),
});
export type Defense = z.infer<typeof DefenseSchema> & { by: "claude" | "template"; invalidCitations: string[] };

/** A reviewer (human controller, or the model-played auditor) questions a decision. */
export async function defend(state: State, tripId: string, question: string): Promise<Defense> {
  const t = traceFor(state, tripId);
  if (!t.decision) throw new Error("trip has no decision yet");
  if (llmAvailable()) {
    try {
      const out = await structured(DefenseSchema, {
        model: "reason",
        system: `${SYSTEM}\nA reviewer is questioning this decision. Defend it if the trace supports it. Concede plainly if the reviewer has found a real gap, and say what should happen instead. If the trace can't answer, say need_more_info and name the missing evidence.`,
        user: `Reviewer's question: ${question}\n\nTrace:\n${JSON.stringify(t)}`,
        effort: "medium",
      });
      const ids = knownIds(t);
      const invalid = out.citedIds.filter((id) => !ids.has(id));
      const cited = out.citedIds.filter((id) => ids.has(id));
      if (cited.length > 0) return { ...out, citedIds: cited, by: "claude", invalidCitations: invalid };
    } catch {
      /* template below */
    }
  }
  const d = t.decision;
  return {
    stance: "defend",
    answer: `${d.reasons.join(" ")} ${d.refs.filter((r) => r in RULES).map((r) => `${r}: ${RULES[r as RuleId]}`).join(" ")}`,
    citedIds: d.refs,
    whatWouldChangeTheDecision: "New evidence that contradicts the cited bank, receipt or check-in records.",
    by: "template",
    invalidCitations: [],
  };
}

const ChallengeSchema = z.object({
  tripId: z.string(),
  question: z.string().describe("One pointed question an external auditor would ask about this decision"),
  why: z.string(),
});

/** The model plays an external auditor and picks the decision it trusts least. */
export async function auditorChallenge(state: State): Promise<z.infer<typeof ChallengeSchema> | null> {
  const decided = state.trips.filter((t) => t.decision && t.period !== "2026-03");
  if (!llmAvailable() || decided.length === 0) return null;
  const digest = decided.map((t) => ({ id: t.id, code: t.decision!.code, pay: t.decision!.payCents, reasons: t.decision!.reasons, refs: t.decision!.refs }));
  try {
    const out = await structured(ChallengeSchema, {
      model: "reason",
      system: "You are an external auditor reviewing a student hackathon's travel-reimbursement books. Pick the single decision most likely to be wrong or least well-supported, and ask one sharp question about it. Use the trip id exactly as given.",
      user: JSON.stringify(digest),
      effort: "medium",
    });
    return decided.some((t) => t.id === out.tripId) ? out : null;
  } catch {
    return null;
  }
}
