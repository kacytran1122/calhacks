import "server-only";
import {
  AGENT_CAPS,
  AGENT_NEVER,
  brightDataKey,
  buildSeed,
  dueJobs,
  hasState,
  JOBS,
  llmAvailable,
  loadState,
  PermissionDenied,
  LedgerError,
  organizerCarbon,
  POLICY,
  RULES,
  saveState,
  trialBalance,
  verifyChain,
  visaAcceptanceConfigured,
  closeReadiness,
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
    photon: Boolean(
      /^pho_prj_[A-Za-z0-9_-]+$/.test(process.env.PHOTON_PROJECT_ID ?? "")
      && /^pho_sk_[A-Za-z0-9_-]+$/.test(process.env.PHOTON_API_KEY ?? "")
      && (process.env.PHOTON_BRIDGE_SECRET?.trim().length ?? 0) >= 16
      && /^\+[1-9]\d{7,14}$/.test(process.env.PHOTON_LINE_ADDRESS ?? ""),
    ),
    visa: visaAcceptanceConfigured() ? "sandbox" as const : "simulated" as const,
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
    closeReadiness: staff ? closeReadiness(s) : null,
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
    carbon: staff ? organizerCarbon(s) : null,
    scheduler: staff ? schedulerStatus(s) : null,
    rules: RULES,
  };
}

function schedulerStatus(s: State) {
  const due = new Set(dueJobs(s, new Date()));
  return Object.entries(JOBS).map(([id, j]) => ({ id, what: j.what, everyMinutes: j.everyMinutes, lastRun: s.scheduler?.lastRun[id] ?? null, due: due.has(id as keyof typeof JOBS) }));
}

export function fail(e: unknown) {
  const status = e instanceof PermissionDenied ? 403 : e instanceof LedgerError ? 409 : 400;
  return NextResponse.json({ error: (e as Error).message, kind: (e as Error).constructor.name }, { status });
}
