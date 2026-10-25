"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { snapshot } from "@/lib/server";
import { SmileWord } from "@/components/landing/Smile";

type Snap = ReturnType<typeof snapshot>;
type TripRow = Snap["trips"][number];

const fmt = (c: number) => (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toFixed(2);
const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

function Prov({ p }: { p: string }) {
  return <span className={`dk-prov dk-prov-${p}`}>{p === "simulated" ? "SIMULATED" : p === "testnet" ? "TESTNET" : p === "live" ? "LIVE" : "SEEDED"}</span>;
}

function Status({ s }: { s: string }) {
  return <span className={`dk-status dk-status-${s}`}>{s}</span>;
}

function Code({ t }: { t: TripRow }) {
  if (!t.decision) return <span className="dk-code dk-code-pending">{t.state}</span>;
  const tone = t.state === "needs_human" ? "ask" : t.state === "denied" ? "no" : "yes";
  return <span className={`dk-code dk-code-${tone}`}>{t.decision.code.replace(/_/g, " ")}</span>;
}

export function DeskClient({ initialZip }: { initialZip: string }) {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [approveLink, setApproveLink] = useState<{ token: string; tripId: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [withClaude, setWithClaude] = useState(false);
  const [filter, setFilter] = useState<"all" | "flagged">("all");

  const refresh = useCallback(async () => {
    try {
      setSnap(await api<Snap>("/api/desk"));
      setSignedOut(false);
    } catch (e) {
      if ((e as Error).message === "sign in first") setSignedOut(true);
      else throw e;
    }
  }, []);
  useEffect(() => {
    const h = new URLSearchParams(location.hash.slice(1));
    const token = h.get("approve");
    const tripId = h.get("trip");
    if (token && tripId) {
      setApproveLink({ token, tripId });
      history.replaceState(null, "", location.pathname + location.search);
    }
    refresh().catch((e) => setToast({ kind: "err", text: e.message }));
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>, ok?: (r: unknown) => string) => {
    setBusy(label);
    setToast(null);
    try {
      const r = await fn();
      if (ok) setToast({ kind: "ok", text: ok(r) });
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const trips = useMemo(() => (snap?.trips ?? []).filter((t) => filter === "all" || (t.decision && t.decision.code !== "reimburse_full")), [snap, filter]);
  const pending = snap?.trips.filter((t) => t.state === "submitted" || (t.state === "reimbursed" && t.id === "TR-F-19" && t.decision?.code !== "recover_refund")).length ?? 0;

  if (approveLink) return <TravelerApproval link={approveLink} onExit={() => setApproveLink(null)} />;
  if (signedOut) return <SignIn onDone={() => refresh()} />;
  if (!snap) return <div className="dk dk-loading">Loading the books…</div>;
  const i = snap.integrations;
  const staff = snap.user.role !== "traveler";
  const signOut = async () => {
    await api("/api/auth/logout", {});
    setSnap(null);
    setSignedOut(true);
  };

  return (
    <div className="dk">
      <header className="dk-top">
        <a href="/landing" className="brand" aria-label="S’mile home">
          <SmileWord />
        </a>
        <span className="dk-desk">Desk</span>
        <div className="dk-co">
          <b>{snap.company.name}</b> · {snap.company.program} · open period <b>{snap.company.openPeriod}</b>
        </div>
        <div className="dk-chips">
          <span className={`dk-chip ${i.claude ? "on" : ""}`}>Claude {i.claude ? "on" : "off"}</span>
          <span className={`dk-chip ${i.brightData ? "on" : ""}`}>Bright Data {i.brightData ? "on" : "off"}</span>
          <span className={`dk-chip ${i.photon ? "on" : ""}`}>Photon 2.0 {i.photon ? "ready" : "off"}</span>
          <span className={`dk-chip ${i.visa === "sandbox" ? "on" : "sim"}`}>Visa · {i.visa}</span>
        </div>
        <div className="dk-me">
          <b>{snap.user.name}</b> <span className="dk-tag">{snap.user.role}</span>
          <button className="dk-btn ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <div className="dk-seats">
        <b>Seats filled:</b> Travel Reimbursement Clerk + Card Reconciliation Analyst for {snap.company.name}, reporting to the controller. It reconciles every trip on its own, asks one person one question when it can’t decide, and can’t pay, approve, or edit history.
      </div>

      {toast && (
        <div className={`dk-toast ${toast.kind}`} role="status" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      <div className="dk-grid">
        <div className="dk-col">
          {staff && (
          <div className="dk-panel">
            <div className="dk-ph">
              <h2>Run the desk</h2>
              <span className="dk-mut">{pending} trip(s) waiting</span>
            </div>
            <p className="dk-mut">The previous volunteer treasurer handed over the Fall Hack Night backlog half-done. One pass reconciles all of it against the bank feed, receipts, check-ins and policy.</p>
            <div className="dk-row">
              <button className="dk-btn primary" disabled={!!busy} onClick={() => run("tick", () => api<{ done: unknown[] }>("/api/desk/tick", { explainWithClaude: withClaude }), (r) => `Reconciled ${(r as { done: unknown[] }).done.length} trip(s).`)}>
                {busy === "tick" ? "Reconciling…" : "Run autonomous pass"}
              </button>
              <label className="dk-check">
                <input type="checkbox" checked={withClaude} disabled={!i.claude} onChange={(e) => setWithClaude(e.target.checked)} /> Claude writes the explanations {i.claude ? "" : "(needs key)"}
              </label>
              <button className="dk-btn ghost" disabled={!!busy} onClick={() => confirm("Reset the books to the seeded state?") && run("reset", () => api("/api/desk/reset", {}), () => "Books reset to the seed.")}>
                Reset
              </button>
            </div>
          </div>
          )}

          {staff && snap.scheduler && <SchedulerPanel jobs={snap.scheduler} busy={busy} run={run} />}

          <div className="dk-panel">
            <div className="dk-ph">
              <h2>{staff ? "Needs a person" : "Waiting for you"}</h2>
              <span className="dk-mut">answering as {snap.user.name} ({snap.user.role})</span>
            </div>
            {snap.inbox.length === 0 && <p className="dk-mut">Nothing waiting. The desk only asks when the books can’t decide.</p>}
            {snap.inbox.map((q) => (
              <div key={q.id} className="dk-q">
                <div className="dk-q-h">
                  <span className="dk-tag">for {q.askedOf}</span>
                  <button className="dk-link" onClick={() => setSelected(q.tripId)}>
                    {q.tripId}
                  </button>
                  {q.meta.code && <span className="dk-mut">{q.meta.code.replace(/_/g, " ")}</span>}
                </div>
                <p>{q.question}</p>
                <div className="dk-row">
                  {q.options.map((o) => (
                    <button
                      key={o.id}
                      className={`dk-btn ${o.id === "reject" ? "ghost" : "primary"}`}
                      disabled={!!busy}
                      onClick={() =>
                        run(q.id, () => api<{ outcome: string }>("/api/desk/answer", { itemId: q.id, option: o.id }), (r) => `${q.tripId}: ${(r as { outcome: string }).outcome}`)
                      }
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="dk-panel">
            <div className="dk-ph">
              <h2>Trips</h2>
              <div className="dk-seg">
                <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
                  All
                </button>
                <button className={filter === "flagged" ? "on" : ""} onClick={() => setFilter("flagged")}>
                  Not routine
                </button>
              </div>
            </div>
            <div className="dk-table-wrap">
              <table className="dk-table">
                <thead>
                  <tr>
                    <th>Trip</th>
                    <th>Traveler</th>
                    <th>Mode</th>
                    <th className="r">Quote</th>
                    <th>Decision</th>
                    <th className="r">Pays</th>
                  </tr>
                </thead>
                <tbody>
                  {trips.map((t) => (
                    <tr key={t.id} onClick={() => setSelected(t.id)} className={selected === t.id ? "sel" : ""}>
                      <td className="mono">{t.id}</td>
                      <td>
                        {t.traveler?.initials} <span className="dk-mut">· {t.traveler?.school}</span>
                      </td>
                      <td>{t.mode}</td>
                      <td className="r num">{fmt(t.quoteCents)}</td>
                      <td>
                        <Code t={t} />
                      </td>
                      <td className="r num">{t.decision ? fmt(t.decision.payCents) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {staff && (
        <div className="dk-col">
          <div className="dk-panel">
            <div className="dk-ph">
              <h2>Travel fund</h2>
            </div>
            <div className="dk-stats">
              <div>
                <div className="v num">{fmt(snap.budget.remainingCents)}</div>
                <div className="l">remaining of {fmt(snap.budget.seasonCents)}</div>
              </div>
              <div>
                <div className={`v ${snap.chain.ok ? "ok" : "bad"}`}>{snap.chain.ok ? "Intact" : "BROKEN"}</div>
                <div className="l">audit chain · {snap.chain.ok ? `${snap.chain.length} events` : `at event ${snap.chain.brokenAt}`}</div>
              </div>
            </div>
            <div className="dk-meter">
              <div style={{ width: `${Math.min(100, (snap.budget.spentCents / snap.budget.seasonCents) * 100)}%` }} />
            </div>
          </div>

          {snap.closeReadiness && (
          <div className="dk-panel">
            <div className="dk-ph">
              <h2>Close readiness</h2>
              <span className={`dk-close-state ${snap.closeReadiness.ready ? "ready" : "review"}`}>
                {snap.closeReadiness.ready ? "Ready to close" : "Review needed"}
              </span>
            </div>
            <p className="dk-mut">A live control check across approvals, authorizations, reimbursements, open exceptions, duplicate requests, and the trial balance.</p>
            <div className="dk-control-totals">
              <div><span>Approved</span><b className="num">{fmt(snap.closeReadiness.approvedCents)}</b></div>
              <div><span>Authorized</span><b className="num">{fmt(snap.closeReadiness.authorizedCents)}</b></div>
              <div><span>Reimbursed</span><b className="num">{fmt(snap.closeReadiness.reimbursedCents)}</b></div>
              <div><span>Open items</span><b className="num">{snap.closeReadiness.openItems}</b></div>
            </div>
            <div className="dk-control-list">
              <span className={snap.closeReadiness.booksBalanced ? "pass" : "fail"}>{snap.closeReadiness.booksBalanced ? "✓" : "!"} Books balance</span>
              <span className={snap.closeReadiness.duplicateAuthorizations === 0 ? "pass" : "fail"}>{snap.closeReadiness.duplicateAuthorizations === 0 ? "✓" : "!"} No duplicate authorizations</span>
              <span className={snap.closeReadiness.unresolvedTrips === 0 ? "pass" : "fail"}>{snap.closeReadiness.unresolvedTrips === 0 ? "✓" : "!"} {snap.closeReadiness.unresolvedTrips} unresolved trips</span>
            </div>
            {snap.closeReadiness.issues.length > 0 && <ul className="dk-issue-list">{snap.closeReadiness.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
          </div>
          )}

          {snap.carbon && <EmissionsPanel carbon={snap.carbon} />}

          <div className="dk-panel">
            <div className="dk-ph">
              <h2>Trial balance</h2>
              <span className="dk-mut">{snap.company.closedPeriods.length} periods closed</span>
            </div>
            <table className="dk-table tight">
              <tbody>
                {snap.trialBalance.map((r) => (
                  <tr key={r.account}>
                    <td className="mono">{r.account}</td>
                    <td>{r.name}</td>
                    <td className="r num">{fmt(r.balance)}</td>
                  </tr>
                ))}
                <tr className="tot">
                  <td />
                  <td>Debits − credits</td>
                  <td className="r num">{fmt(snap.trialBalance.reduce((a, r) => a + r.balance, 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="dk-panel">
            <div className="dk-ph">
              <h2>The agents and what they can’t do</h2>
            </div>
            {snap.agents.map((a) => (
              <div key={a.id} className="dk-agent">
                <b>{a.id}</b>
                <span className="dk-caps">{a.caps.join(" · ") || "—"}</span>
                <span className="dk-never">{a.never}</span>
              </div>
            ))}
          </div>
        </div>
        )}
      </div>

      <PlanPanel initialZip={initialZip} busy={busy} run={run} />
      {staff && <Scorecard />}
      {staff && <AuditPanel snap={snap} />}

      {selected && <TraceDrawer tripId={selected} onClose={() => setSelected(null)} claude={i.claude} />}
    </div>
  );
}

const kg = (v: number) => `${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 1 })} kg`;
const every = (min: number) => (min % 60 === 0 ? `${min / 60} h` : `${min} min`);
type JobRun = { results: ({ job: string; summary: string } | { job: string; error: string })[] };
const jobsDone = (r: unknown) => (r as JobRun).results.map((x) => `${x.job}: ${"error" in x ? `failed (${x.error})` : x.summary}`).join(" · ") || "Nothing was due.";

/** The jobs that wake the agents without anyone asking, and when each last ran. */
function SchedulerPanel({ jobs, busy, run }: { jobs: NonNullable<Snap["scheduler"]>; busy: string | null; run: (l: string, fn: () => Promise<unknown>, ok?: (r: unknown) => string) => Promise<void> }) {
  return (
    <div className="dk-panel">
      <div className="dk-ph">
        <h2>Scheduler</h2>
        <span className="dk-mut">{jobs.filter((j) => j.due).length} job(s) due</span>
      </div>
      <p className="dk-mut">
        Wakes the agents on its own (<code>npm run scheduler</code>, or a cron calling <code>/api/scheduler/run</code>) and sends notices. It can’t approve, charge or change an amount.
      </p>
      <table className="dk-table tight">
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>
                <b>{j.what}</b>
                <br />
                <span className="dk-mut">every {every(j.everyMinutes)} · last run {j.lastRun ? ago(j.lastRun) : "never"}</span>
              </td>
              <td className="r">
                <button className="dk-btn ghost" disabled={!!busy} onClick={() => run(`job:${j.id}`, () => api<JobRun>("/api/scheduler/run", { jobs: [j.id] }), jobsDone)}>
                  {busy === `job:${j.id}` ? "Running…" : j.due ? "Run (due)" : "Run now"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="dk-btn primary" disabled={!!busy} onClick={() => run("scheduler", () => api<JobRun>("/api/scheduler/run", {}), jobsDone)}>
        {busy === "scheduler" ? "Waking the agents…" : "Run everything due"}
      </button>
    </div>
  );
}

/** Organizer totals: what the chosen routes emit against every attendee driving alone. */
function EmissionsPanel({ carbon }: { carbon: NonNullable<Snap["carbon"]> }) {
  const more = carbon.avoidedKg < 0;
  return (
    <div className="dk-panel">
      <div className="dk-ph">
        <h2>Emissions</h2>
        <span className="dk-mut">{carbon.trips} approved trip(s)</span>
      </div>
      <div className="dk-stats">
        <div>
          <div className="v num">{kg(carbon.avoidedKg)}</div>
          <div className="l">CO₂e {more ? "more than" : "avoided versus"} every attendee driving alone{more ? "" : ` (${carbon.avoidedPct}%)`}</div>
        </div>
        <div>
          <div className="v num">{kg(carbon.chosenKg)}</div>
          <div className="l">emitted by the chosen routes (estimate)</div>
        </div>
      </div>
      {carbon.byEvent.length > 0 && (
        <table className="dk-table tight dk-carbon">
          <thead>
            <tr>
              <th>Event</th>
              <th className="r">Trips</th>
              <th className="r">Emitted</th>
              <th className="r">Avoided</th>
            </tr>
          </thead>
          <tbody>
            {carbon.byEvent.map((e) => (
              <tr key={e.eventId}>
                <td>{e.name}</td>
                <td className="r num">{e.trips}</td>
                <td className="r num">{kg(e.chosenKg)}</td>
                <td className="r num">{e.avoidedKg < 0 ? `−${kg(e.avoidedKg)}` : kg(e.avoidedKg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details className="dk-method">
        <summary>How this is calculated</summary>
        <ul className="dk-ul">
          {carbon.method.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <p className="dk-mut">
          {carbon.sources.map((s, i) => (
            <span key={s.url}>
              {i > 0 && " · "}
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.name}
              </a>
            </span>
          ))}
        </p>
      </details>
    </div>
  );
}

type PlanOut = {
  approvalToken: string;
  trip: { id: string; state: string; quoteCents: number; mode: string; distanceMiles: number; travelerId: string };
  event: { name: string; venue: string; startsAt: string };
  evidence: { id: string; kind: string; source: string; status: string; provenance: string; fetchedAt: string; url?: string; data: Record<string, unknown>; note?: string }[];
  routes: { options: { mode: string; routeTitle?: string; costCents: number; costSource: string; pMiss: number; history: { trips: number; late: number }; withinCap: boolean; withinBudget: boolean; co2eKg?: number; co2eFormula?: string }[]; pick?: { mode: string; routeTitle?: string; costCents: number }; pickReason?: string; cap: number; travelerBudgetCents?: number; blockReason?: string } | null;
  inbox: { id: string; question: string } | null;
};

export function PlanPanel({ initialZip, busy, run }: { initialZip: string; busy: string | null; run: (l: string, fn: () => Promise<unknown>, ok?: (r: unknown) => string) => Promise<void> }) {
  const [zip, setZip] = useState(initialZip || "95616");
  const [url, setUrl] = useState("");
  const [plan, setPlan] = useState<PlanOut | null>(null);
  const [stage, setStage] = useState<"none" | "planned" | "approved" | "booked" | "declined">("none");

  const doPlan = () =>
    run(
      "plan",
      async () => {
        const p = await api<PlanOut>("/api/plan", { zip, eventUrl: url || undefined });
        setPlan(p);
        setStage("planned");
        return p;
      },
      (r) => ((r as PlanOut).routes ? `Planned ${(r as PlanOut).trip.id}` : "Couldn’t plan — see the evidence below"),
    );

  const approve = () =>
    plan?.inbox &&
    run("approve", async () => {
      await api("/api/desk/answer", { itemId: plan.inbox!.id, option: "approve", tripToken: plan.approvalToken });
      setStage("approved");
    }, () => `Approved exactly ${fmt(plan.trip.quoteCents)}.`);

  const book = (delta: number) =>
    plan &&
    run("book", async () => {
      const r = await api<{ ok: boolean; detail: string }>("/api/plan/book", { tripId: plan.trip.id, fareDeltaCents: delta, tripToken: plan.approvalToken });
      setStage(r.ok ? "booked" : "declined");
      return r;
    }, (r) => ((r as { ok: boolean }).ok ? `${(r as { detail: string }).detail}. Capture remains disabled.` : `Declined: ${(r as { detail: string }).detail}. Re-approval sent to the traveler (R7).`));

  return (
    <div className="dk-panel dk-wide" id="plan">
      <div className="dk-ph">
        <h2>Plan a live trip</h2>
        <span className="dk-mut">Scout · Evidence · Route · Policy · Mandate · Payments</span>
      </div>
      <p className="dk-mut">Live public data only: Bright Data for the event page and the open web, NWS and Census for official facts. Pages can take 2–40 s; blocked or empty sources are shown, never filled in.</p>
      <div className="dk-row">
        <input className="dk-in" value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="Home ZIP" aria-label="Home ZIP" style={{ width: 110 }} />
        <input className="dk-in" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Public event page URL (optional — defaults to Golden Gate Hack 2026)" aria-label="Event URL" style={{ flex: 1, minWidth: 220 }} />
        <button className="dk-btn primary" disabled={!!busy || zip.length !== 5} onClick={doPlan}>
          {busy === "plan" ? "Collecting evidence…" : "Plan with live data"}
        </button>
      </div>
      {plan && (
        <div className="dk-plan">
          <div className="dk-ev-list">
            {plan.evidence.map((e) => (
              <div key={e.id} className="dk-ev">
                <div className="dk-ev-h">
                  <b>{e.kind.replace(/_/g, " ")}</b> <Status s={e.status} /> <Prov p={e.provenance} />
                  <span className="dk-mut">{ago(e.fetchedAt)}</span>
                </div>
                <div className="dk-mut">
                  {e.url ? (
                    <a href={e.url} target="_blank" rel="noreferrer">
                      {e.source}
                    </a>
                  ) : (
                    e.source
                  )}
                </div>
                <EvidenceData e={e} />
                {e.note && <div className="dk-note">{e.note}</div>}
              </div>
            ))}
          </div>
          {plan.routes && (
            <div>
              <table className="dk-table tight">
                <thead>
                  <tr>
                    <th>Option</th>
                    <th className="r">Cost</th>
                    <th className="r">P(miss kickoff)</th>
                    <th className="r">CO₂e</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.routes.options.map((o) => {
                    const picked = plan.routes?.pick;
                    const selected = picked?.mode === o.mode && picked.routeTitle === o.routeTitle && picked.costCents === o.costCents;
                    return <tr key={JSON.stringify([o.mode, o.routeTitle, o.costCents])} className={selected ? "sel" : ""}>
                      <td>
                        {o.routeTitle || o.mode} {selected && <span className="dk-tag">pick</span>}
                      </td>
                      <td className="r num">{fmt(o.costCents)}{!o.withinCap && " ⚠ over cap"}{!o.withinBudget && " ⚠ over traveler budget"}</td>
                      <td className="r num" title={`${o.history.late} late of ${o.history.trips} past trips`}>{Math.round(o.pMiss * 100)}%</td>
                      <td className="r num" title={o.co2eFormula}>{o.co2eKg !== undefined ? `${o.co2eKg} kg` : "—"}</td>
                      <td className="dk-mut">{o.costSource}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
              <p className="dk-mut">
                {plan.trip.distanceMiles} mi one way · cap {fmt(plan.routes.cap)} (R1) · P(miss) is learned from this program’s past trips · CO₂e per traveler from EPA emission factors × distance (hover for the formula).
              </p>
              {plan.routes.pickReason && <p className="dk-mut">Why the pick: {plan.routes.pickReason}</p>}
              {plan.inbox && stage === "planned" && (
                <div className="dk-q">
                  <span className="dk-tag">for traveler</span>
                  <p>{plan.inbox.question}</p>
                  <button className="dk-btn primary" disabled={!!busy} onClick={approve}>
                    Approve exactly {fmt(plan.trip.quoteCents)}
                  </button>
                </div>
              )}
              {stage === "approved" && (
                <div className="dk-row">
                  <button className="dk-btn primary" disabled={!!busy} onClick={() => book(0)}>
                    Book at the approved price
                  </button>
                  <button className="dk-btn ghost" disabled={!!busy} onClick={() => book(350)}>
                    Book — fare moved +$3.50 at checkout
                  </button>
                </div>
              )}
              {stage === "booked" && <p className="dk-ok">Authorized exactly {fmt(plan.trip.quoteCents)} on a single-use token. Capture remains disabled.</p>}
              {stage === "declined" && <p className="dk-warn">The mandate declined the higher fare. The traveler has a new question in “Needs a person” to approve the exact new amount.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EvidenceData({ e }: { e: PlanOut["evidence"][number] }) {
  const d = e.data;
  if (e.kind === "event_page" && d.name) return <div>{String(d.name)} · {String(d.venue ?? "")} · {d.startsAt ? new Date(String(d.startsAt)).toLocaleString() : "time unknown"} <span className="dk-mut">({String(d.extractedBy)}{d.verified === false ? ", unverified" : ""})</span></div>;
  if (e.kind === "geocode" && d.label) return <div>{String(d.label)}</div>;
  if (e.kind === "weather" && d.summary) return <div>{String(d.summary)}, {String(d.tempF)}°F{d.precipPct != null ? `, ${d.precipPct}% precip` : ""}</div>;
  if (e.kind === "stop" && Array.isArray(d.results)) return <ul className="dk-ul">{(d.results as { title: string; link: string }[]).map((r) => <li key={r.link}><a href={r.link} target="_blank" rel="noreferrer">{r.title}</a></li>)}</ul>;
  if (e.kind === "fare" && Array.isArray(d.fares)) return d.fares.length ? <ul className="dk-ul">{(d.fares as { mode: string; amountUsd: number; link: string; quote: string }[]).map((f, i) => <li key={i}>{f.mode} ${f.amountUsd} — “{f.quote}” <a href={f.link} target="_blank" rel="noreferrer">source</a></li>)}</ul> : null;
  if (e.kind === "quote") return <div>{fmt(Number(d.amountCents))} by {String(d.mode)}</div>;
  return null;
}

type Eval = {
  totals: { cases: number; exact: number; plantedCaught: number; planted: number; cleanPassedThrough: number; clean: number; escalations: number; controlsHeld: number; controls: number };
  cases: { tripId: string; plant: string; expected: string; got: string; codeOk: boolean; payOk: boolean; needsHumanOk: boolean; gotPay: number }[];
  controls: { name: string; ok: boolean; detail: string }[];
};

function Scorecard() {
  const [r, setR] = useState<Eval | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <div className="dk-panel dk-wide">
      <div className="dk-ph">
        <h2>Proof it works</h2>
        <button className="dk-btn primary" disabled={loading} onClick={async () => { setLoading(true); try { setR(await api<Eval>("/api/desk/eval")); } finally { setLoading(false); } }}>
          {loading ? "Running…" : "Run the answer-key eval"}
        </button>
      </div>
      <p className="dk-mut">Runs on a fresh copy of the seeded books (live books untouched): 40 backlog trips, 12 planted errors with an answer key, then deliberate attempts to break the controls.</p>
      {r && (
        <>
          <div className="dk-stats four">
            <div><div className="v num">{r.totals.plantedCaught}/{r.totals.planted}</div><div className="l">planted errors caught</div></div>
            <div><div className="v num">{r.totals.cleanPassedThrough}/{r.totals.clean}</div><div className="l">clean trips passed straight through</div></div>
            <div><div className="v num">{r.totals.escalations}</div><div className="l">questions asked of people</div></div>
            <div><div className="v num">{r.totals.controlsHeld}/{r.totals.controls}</div><div className="l">controls held under attack</div></div>
          </div>
          <div className="dk-table-wrap">
            <table className="dk-table tight">
              <thead><tr><th /><th>Trip</th><th>Planted</th><th>Expected</th><th>Got</th><th className="r">Pays</th></tr></thead>
              <tbody>
                {r.cases.filter((c) => !c.plant.startsWith("(clean)")).map((c) => (
                  <tr key={c.tripId}>
                    <td>{c.codeOk && c.payOk && c.needsHumanOk ? "✓" : "✗"}</td>
                    <td className="mono">{c.tripId}</td>
                    <td>{c.plant}</td>
                    <td className="mono">{c.expected}</td>
                    <td className="mono">{c.got}</td>
                    <td className="r num">{fmt(c.gotPay)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="dk-ul">
            {r.controls.map((c) => <li key={c.name}>{c.ok ? "✓" : "✗"} {c.name} <span className="dk-mut">— {c.detail}</span></li>)}
          </ul>
        </>
      )}
    </div>
  );
}

function AuditPanel({ snap }: { snap: Snap }) {
  return (
    <div className="dk-panel dk-wide">
      <div className="dk-ph">
        <h2>Audit trail</h2>
        <span className="dk-mut">append-only · each event hashes the one before it</span>
      </div>
      <div className="dk-audit">
        {snap.audit.map((a) => (
          <div key={a.seq} className={`dk-au ${a.action.includes("denied") || a.action.includes("blocked") ? "bad" : ""}`}>
            <span className="mono dk-mut">#{a.seq}</span>
            <span className="mono">{a.actor.kind === "agent" ? `agent:${a.actor.id}` : `${a.actor.role}:${a.actor.id}`}</span>
            <b>{a.action}</b>
            <span>{a.subject}</span>
            <span className="dk-mut dk-au-r">{a.reason}</span>
            <span className="mono dk-mut" title={a.hash}>{a.hash.slice(0, 8)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type Trace = {
  trip: TripRow;
  traveler?: { initials: string; school: string };
  event?: { name: string };
  evidence: PlanOut["evidence"];
  decision?: TripRow["decision"];
  rules: Record<string, string>;
  journal: { id: string; memo: string; period: string; lines: { account: string; debit: number; credit: number }[] }[];
  audit: { seq: number; action: string; reason: string; at: string }[];
};
type Defense = { stance: string; answer: string; citedIds: string[]; whatWouldChangeTheDecision: string; by: string; invalidCitations: string[] };

function TraceDrawer({ tripId, onClose, claude }: { tripId: string; onClose: () => void; claude: boolean }) {
  const [t, setT] = useState<Trace | null>(null);
  const [q, setQ] = useState("");
  const [d, setD] = useState<Defense | null>(null);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setT(null);
    setD(null);
    api<Trace>(`/api/trace/${tripId}`).then(setT, (e) => setErr(e.message));
  }, [tripId]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);

  const ask = async () => {
    setAsking(true);
    setErr(null);
    try {
      setD(await api<Defense>("/api/desk/challenge", { tripId, question: q }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="dk-drawer-bg" onClick={onClose}>
      <aside className="dk-drawer" onClick={(e) => e.stopPropagation()} aria-label={`Trace for ${tripId}`}>
        <div className="dk-ph">
          <h2 className="mono">{tripId}</h2>
          <button className="dk-btn ghost" onClick={onClose}>Close</button>
        </div>
        {err && <p className="dk-warn">{err}</p>}
        {!t ? (
          <p className="dk-mut">Loading trace…</p>
        ) : (
          <>
            <p>
              {t.traveler?.initials} · {t.traveler?.school} attending {t.event?.name} · {t.trip.mode}, {t.trip.distanceMiles} mi · approved quote <b>{fmt(t.trip.quoteCents)}</b>
            </p>
            {t.trip.travelerBudgetCents !== undefined && (
              <div className="dk-note">
                Traveler budget {fmt(t.trip.travelerBudgetCents)} · organizer R1 cap {fmt(t.trip.organizerCapCents ?? 0)} · reimbursement eligibility {fmt(t.trip.reimbursementEligibleCents ?? 0)}. These limits are evaluated independently.
              </div>
            )}
            {t.decision ? (
              <div className="dk-dec">
                <div className="dk-row">
                  <Code t={t.trip} /> <b className="num">{fmt(t.decision.payCents)}</b>
                  {t.decision.needsHuman && <span className="dk-tag">asked a person</span>}
                </div>
                {t.decision.explanation && (
                  <p className="dk-expl">
                    {t.decision.explanation} <span className="dk-mut">— {t.decision.explainedBy}</span>
                  </p>
                )}
                <ol className="dk-ul">
                  {t.decision.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ol>
                <div className="dk-refs">
                  {t.decision.refs.map((r) => <span key={r} className="dk-ref" title={t.rules[r] ?? ""}>{r}</span>)}
                </div>
              </div>
            ) : (
              <p className="dk-mut">Not decided yet. Run the autonomous pass.</p>
            )}

            <h3>Evidence</h3>
            {t.evidence.map((e) => (
              <div key={e.id} className="dk-ev">
                <div className="dk-ev-h">
                  <span className="mono">{e.id}</span> <b>{e.kind.replace(/_/g, " ")}</b> <Status s={e.status} /> <Prov p={e.provenance} />
                </div>
                <div className="dk-mut">{e.source}</div>
                {e.kind === "receipt" ? <pre className="dk-pre">{String(e.data.text)}</pre> : <pre className="dk-pre">{JSON.stringify(e.data, null, 1)}</pre>}
                {e.note && <div className="dk-note">{e.note}</div>}
              </div>
            ))}

            {Object.keys(t.rules).length > 0 && (
              <>
                <h3>Rules cited</h3>
                <ul className="dk-ul">{Object.entries(t.rules).map(([k, v]) => <li key={k}><b>{k}</b> {v}</li>)}</ul>
              </>
            )}

            {t.journal.length > 0 && (
              <>
                <h3>Journal entries</h3>
                {t.journal.map((j) => (
                  <div key={j.id} className="dk-je">
                    <div><span className="mono">{j.id}</span> · {j.period} · {j.memo}</div>
                    {j.lines.map((l, i) => (
                      <div key={i} className="dk-je-l mono">
                        <span>{l.account}</span>
                        <span className="r">{l.debit ? fmt(l.debit) : ""}</span>
                        <span className="r">{l.credit ? fmt(l.credit) : ""}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}

            {t.decision && (
              <div className="dk-challenge">
                <h3>Question this decision</h3>
                <textarea className="dk-in" rows={3} value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Why not just pay the $27.50? It's only $3.50." />
                <button className="dk-btn primary" disabled={asking || q.trim().length < 5} onClick={ask}>
                  {asking ? "Answering from the trace…" : "Ask"}
                </button>
                {!claude && <span className="dk-mut"> (template answer — add ANTHROPIC_API_KEY for Claude)</span>}
                {d && (
                  <div className={`dk-def ${d.stance}`}>
                    <div className="dk-row">
                      <span className="dk-tag">{d.stance}</span> <span className="dk-mut">answered by {d.by}</span>
                    </div>
                    <p>{d.answer}</p>
                    <div className="dk-refs">{d.citedIds.map((r) => <span key={r} className="dk-ref">{r}</span>)}</div>
                    {d.invalidCitations.length > 0 && <p className="dk-warn">Dropped citations not in the trace: {d.invalidCitations.join(", ")}</p>}
                    <p className="dk-mut">What would change it: {d.whatWouldChangeTheDecision}</p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/api/auth/login", { id, password: pw });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dk">
      <header className="dk-top">
        <a href="/landing" className="brand" aria-label="S’mile home">
          <SmileWord />
        </a>
        <span className="dk-desk">Desk</span>
      </header>
      <form className="dk-panel dk-signin" onSubmit={submit}>
        <h2>Sign in to the travel desk</h2>
        <p className="dk-mut">Your role comes from your account, not from anything you pick here. Test-only accounts for the demo are listed in backend/src/seed/users.ts.</p>
        <label>
          Sign-in name
          <input className="dk-in" value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" autoFocus />
        </label>
        <label>
          Password
          <input className="dk-in" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
        </label>
        {err && <p className="dk-warn">{err}</p>}
        <button className="dk-btn primary" disabled={busy || !id || !pw}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="dk-mut">
          Planning a trip? You don’t need an account — <a href="/desk/plan">plan one here</a> or use Lens.
        </p>
      </form>
    </div>
  );
}

type Status = { trip: { id: string; state: string; mode: string; routeTitle?: string; quoteCents: number; distanceMiles: number }; event?: { name: string }; questions: { id: string; question: string; options: { id: string; label: string }[] }[] };

function TravelerApproval({ link, onExit }: { link: { token: string; tripId: string }; onExit: () => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const load = useCallback(async () => {
    try {
      setSt(await api<Status>("/api/plan/status", { tripId: link.tripId, tripToken: link.token }));
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    }
  }, [link]);
  useEffect(() => {
    load();
  }, [load]);
  const answer = async (itemId: string, option: string) => {
    try {
      const r = await api<{ outcome: string }>("/api/desk/answer", { itemId, option, tripToken: link.token });
      setMsg({ kind: "ok", text: r.outcome });
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    }
  };
  return (
    <div className="dk">
      <header className="dk-top">
        <a href="/landing" className="brand" aria-label="S’mile home">
          <SmileWord />
        </a>
        <span className="dk-desk">Your trip</span>
        <div className="dk-co" />
        <button className="dk-btn ghost" onClick={onExit}>
          Close
        </button>
      </header>
      <div className="dk-panel dk-signin">
        {msg && <div className={`dk-toast ${msg.kind}`}>{msg.text}</div>}
        {!st ? (
          <p className="dk-mut">Loading your trip…</p>
        ) : (
          <>
            <h2>{st.event?.name ?? st.trip.id}</h2>
            <p className="dk-mut">
              {st.trip.routeTitle ?? st.trip.mode} · {st.trip.distanceMiles} mi · {fmt(st.trip.quoteCents)} · {st.trip.state.replace(/_/g, " ")}
            </p>
            {st.questions.length === 0 && <p>Nothing waiting for you. Nothing is charged until you approve an exact amount.</p>}
            {st.questions.map((q) => (
              <div key={q.id} className="dk-q">
                <p>{q.question}</p>
                <div className="dk-row">
                  {q.options.map((o) => (
                    <button key={o.id} className={`dk-btn ${o.id === "reject" ? "ghost" : "primary"}`} onClick={() => answer(q.id, o.id)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="dk-mut">This link only works for this one trip and expires in 24 hours.</p>
          </>
        )}
      </div>
    </div>
  );
}

export function PublicPlanner({ initialZip }: { initialZip: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const run = async (label: string, fn: () => Promise<unknown>, ok?: (r: unknown) => string) => {
    setBusy(label);
    setToast(null);
    try {
      const r = await fn();
      if (ok) setToast({ kind: "ok", text: ok(r) });
    } catch (e) {
      setToast({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="dk">
      <header className="dk-top">
        <a href="/landing" className="brand" aria-label="S’mile home">
          <SmileWord />
        </a>
        <span className="dk-desk">Plan a trip</span>
        <div className="dk-co">No account needed. Nothing is charged until you approve an exact amount.</div>
        <a className="dk-btn ghost" href="/desk">Organizer sign-in</a>
      </header>
      {toast && (
        <div className={`dk-toast ${toast.kind}`} role="status" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
      <PlanPanel initialZip={initialZip} busy={busy} run={run} />
    </div>
  );
}
