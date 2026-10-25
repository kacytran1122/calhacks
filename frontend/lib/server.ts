import "server-only";
import {
  AGENT_CAPS,
  AGENT_NEVER,
  brightDataKey,
  buildSeed,
  hasState,
  llmAvailable,
  loadState,
  PermissionDenied,
  LedgerError,
  POLICY,
  RULES,
  saveState,
  trialBalance,
  verifyChain,
  type State,
  type User,
} from "@smile/core";
import { NextResponse } from "next/server";

export function ensureState(): void {
  if (!hasState()) saveState(buildSeed().state);
}

export function integrations() {
  return {
    claude: llmAvailable(),
    brightData: Boolean(brightDataKey()),
    photon: Boolean(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_BRIDGE_SECRET),
    visa: "simulated" as const,
  };
}

export function canSeeTrip(s: State, user: User, tripId: string): boolean {
  if (user.role !== "traveler") return true;
  return s.trips.some((t) => t.id === tripId && t.travelerId === user.personId);
}

export function snapshot(user: User) {
  ensureState();
  const s: State = loadState();
  const mine = (tripId: string) => canSeeTrip(s, user, tripId);
  const staff = user.role !== "traveler";
  const tb = trialBalance(s);
  const spent = tb.find((r) => r.account === "5100")?.balance ?? 0;
  return {
    company: s.company,
    people: s.people,
    integrations: integrations(),
    budget: { seasonCents: POLICY.seasonBudgetCents, spentCents: spent, remainingCents: POLICY.seasonBudgetCents - spent },
    chain: verifyChain(s.audit),
    user,
    trialBalance: staff ? tb : [],
    journal: staff ? s.journal.slice(-40).reverse() : [],
    inbox: s.inbox.filter((i) => i.status === "open" && mine(i.tripId)),
    answered: s.inbox.filter((i) => i.status === "answered" && mine(i.tripId)).slice(-10).reverse(),
    trips: s.trips
      .filter((t) => (t.id.startsWith("TR-F") || t.id.startsWith("TR-L")) && mine(t.id))
      .map((t) => ({ ...t, traveler: s.travelers.find((x) => x.id === t.travelerId), event: s.events.find((e) => e.id === t.eventId)?.name })),
    audit: staff ? s.audit.slice(-60).reverse() : [],
    agents: Object.entries(AGENT_CAPS).map(([id, caps]) => ({ id, caps, never: AGENT_NEVER[id as keyof typeof AGENT_NEVER] })),
    rules: RULES,
  };
}

export function fail(e: unknown) {
  const status = e instanceof PermissionDenied ? 403 : e instanceof LedgerError ? 409 : 400;
  return NextResponse.json({ error: (e as Error).message, kind: (e as Error).constructor.name }, { status });
}
