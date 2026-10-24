"use client";

import { useCallback, useEffect, useState } from "react";
import { SmileWord } from "@/components/landing/Smile";

type Listing = {
  key: string;
  source: "luma" | "devpost" | "mlh";
  name: string;
  startsAt?: string;
  endsAt?: string;
  city?: string;
  venue?: string;
  lat?: number;
  lon?: number;
  locationPrecision: "exact" | "city" | "unknown";
  url: string;
  kind: "hackathon" | "tech" | "other";
  distanceMiles?: number;
  alsoOn?: string[];
  fetchedAt: string;
  via: string;
  change?: string;
};
type Discover = {
  origin: { zip: string; label?: string };
  radiusMiles: number;
  events: Listing[];
  unplaced: Listing[];
  sources: { source: string; status: string; via: string; count: number; ms: number; note?: string }[];
  store: "tigerdata" | "local";
  storeNote?: string;
  classifiedBy: "claude" | "keywords";
};
type Ev = { id: string; kind: string; source: string; status: string; provenance: string; fetchedAt: string; url?: string; data: Record<string, unknown>; note?: string };
type Plan = {
  approvalToken: string;
  trip: { id: string; mode: string; quoteCents: number; distanceMiles: number; travelerId: string; travelerBudgetCents?: number; travelerMaxDistanceMiles?: number; organizerCapCents?: number; reimbursementEligibleCents?: number };
  event: { name: string; startsAt: string };
  evidence: Ev[];
  routes: { options: { mode: string; costCents: number; costSource: string; pMiss: number; history: { trips: number; late: number }; withinCap: boolean; withinBudget: boolean }[]; pick?: { mode: string }; cap: number; travelerBudgetCents?: number; maxDistanceMiles?: number; blockReason?: "TRAVELER_BUDGET" | "ORGANIZER_CAP" | "MAX_DISTANCE" } | null;
  inbox: { id: string; question: string; askedOf: "traveler" | "organizer" | "controller" } | null;
  buddies: { initials: string; mode: string; sameMode: boolean; milesApart: number }[];
};

const fmt = (c: number) => (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toFixed(2);
const SOURCE = { luma: "Luma", devpost: "Devpost", mlh: "MLH" } as const;

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

function when(e: Listing) {
  if (!e.startsAt) return { mon: "—", day: "", time: "date unknown" };
  const d = new Date(e.startsAt);
  const dateOnly = e.source === "devpost" && !e.alsoOn?.length;
  return {
    mon: d.toLocaleDateString("en-US", { month: "short" }),
    day: d.toLocaleDateString("en-US", { day: "numeric" }),
    time: dateOnly ? d.toLocaleDateString("en-US", { weekday: "short" }) : d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }),
  };
}

export function FindClient({ initialZip }: { initialZip: string }) {
  const [zip, setZip] = useState(initialZip);
  const [radius, setRadius] = useState(200);
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<Set<"mlh" | "tech">>(new Set(["mlh", "tech"]));
  const [res, setRes] = useState<Discover | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Listing | null>(null);

  const search = useCallback(async (z = zip) => {
    if (!/^\d{5}$/.test(z)) return setErr("Enter a 5-digit ZIP.");
    setLoading(true);
    setErr(null);
    setPicked(null);
    try {
      const p = new URLSearchParams({ zip: z, radius: String(radius), groups: [...groups].join(",") });
      if (q.trim()) p.set("q", q.trim());
      setRes(await api<Discover>(`/api/events?${p}`));
      history.replaceState(null, "", `/find?zip=${z}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [zip, radius, q, groups]);

  useEffect(() => {
    if (initialZip) search(initialZip);
  }, []);

  const toggle = (k: "mlh" | "tech") => {
    const n = new Set(groups);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    if (n.size) setGroups(n);
  };

  return (
    <div className="dk">
      <header className="dk-top">
        <a href="/" className="brand" aria-label="S’mile home">
          <SmileWord />
        </a>
        <span className="dk-desk">Find events</span>
        <div className="dk-co">Official MLH hackathons and local tech events, clearly separated.</div>
        <a className="dk-btn ghost" href="/chat">
          @smile group chat
        </a>
        <a className="dk-btn ghost" href="/desk">
          Organizer finance desk
        </a>
      </header>

      <form
        className="fd-search"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input className="dk-in fd-zip" value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" placeholder="Your ZIP" aria-label="Your ZIP code" />
        <input className="dk-in fd-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: AI, Stanford, Cal Hacks…" aria-label="Search events" />
        <label className="fd-limit">
          <span>Max distance</span>
          <span className="fd-number"><input className="dk-in" type="number" min={1} max={3000} value={radius} onChange={(e) => setRadius(Math.min(3000, Math.max(1, Number(e.target.value) || 1)))} aria-label="Maximum route distance in miles" /><b>mi</b></span>
        </label>
        <div className="dk-seg fd-types" aria-label="Event types">
          <button type="button" aria-pressed={groups.has("mlh")} className={groups.has("mlh") ? "on" : ""} onClick={() => toggle("mlh")}>
            <span>MLH events</span>
            <small>Official student hackathons</small>
          </button>
          <button type="button" aria-pressed={groups.has("tech")} className={groups.has("tech") ? "on" : ""} onClick={() => toggle("tech")}>
            <span>Tech events</span>
            <small>Meetups, talks &amp; workshops</small>
          </button>
        </div>
        <button className="dk-btn primary" disabled={loading}>
          {loading ? "Searching live sources…" : "Find events"}
        </button>
      </form>

      {err && <div className="dk-toast err">{err}</div>}

      {res && (
        <div className="fd-meta">
          <span>
            <b>{res.events.length}</b> events within {res.radiusMiles} mi of {res.origin.label ?? res.origin.zip}
          </span>
        </div>
      )}

      <div className={`fd-grid ${picked ? "with-plan" : ""}`}>
        <div className="fd-list">
          {res?.events.map((e) => {
            const w = when(e);
            return (
              <article key={e.key} className={`fd-card ${picked?.key === e.key ? "sel" : ""}`}>
                <div className="fd-card-top">
                  <div className="fd-date">
                    <span>{w.mon}</span>
                    <b>{w.day}</b>
                  </div>
                  <div className="fd-tags">
                    <span className={`fd-kind ${e.kind}`}>{e.source === "mlh" || e.alsoOn?.includes("mlh") ? "MLH event" : "Tech event"}</span>
                    {[e.source, ...(e.alsoOn ?? [])].map((s) => (
                      <span key={s} className="fd-srcbadge">
                        {SOURCE[s as keyof typeof SOURCE] ?? s}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="fd-body">
                  <h3>{e.name}</h3>
                  <div className="dk-mut">
                    {w.time} · {e.venue && e.source !== "luma" ? `${e.venue}, ` : ""}
                    {e.city ?? "location unknown"} · <b>{e.distanceMiles} mi</b>
                    {e.locationPrecision === "city" && " (city center)"}
                  </div>
                  {e.change && <div className="dk-warn fd-change">⚠ {e.change}</div>}
                  <div className="dk-row fd-actions">
                    <button className="dk-btn primary" onClick={() => setPicked(e)}>
                      Plan my trip
                    </button>
                    <a className="dk-link" href={e.url} target="_blank" rel="noreferrer">
                      event page ↗
                    </a>
                  </div>
                </div>
              </article>
            );
          })}
          {res && res.events.length === 0 && <p className="dk-mut">No MLH or tech events found in that radius in the next 90 days. Try a wider radius.</p>}
          {res && res.unplaced.length > 0 && (
            <p className="dk-mut">
              {res.unplaced.length} more match your search but list only a venue name we can’t place on a map: {res.unplaced.map((u) => u.name).join(", ")}.
            </p>
          )}
        </div>
        {picked && <PlanPane key={picked.key} zip={zip} maxDistanceMiles={radius} event={picked} onClose={() => setPicked(null)} />}
      </div>
    </div>
  );
}

function PlanPane({ zip, maxDistanceMiles, event, onClose }: { zip: string; maxDistanceMiles: number; event: Listing; onClose: () => void }) {
  const [initials, setInitials] = useState("");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [includeSelfDrive, setIncludeSelfDrive] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [stage, setStage] = useState<"none" | "planned" | "approved" | "booked" | "declined">("none");

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const doPlan = () =>
    run("plan", async () => {
      const p = await api<Plan>("/api/plan", {
        zip,
        initials: initials || undefined,
        travelerBudgetCents: Math.round(Number(budgetUsd) * 100),
        maxDistanceMiles,
        includeSelfDrive,
        event: { key: event.key, name: event.name, startsAt: event.startsAt, venue: event.venue, city: event.city, lat: event.lat, lon: event.lon, url: event.url },
      });
      setPlan(p);
      setStage(p.inbox?.askedOf === "traveler" && p.trip.quoteCents > 0 ? "planned" : "none");
    });

  const approve = () =>
    run("approve", async () => {
      await api("/api/desk/answer", { itemId: plan!.inbox!.id, option: "approve", tripToken: plan!.approvalToken });
      setStage("approved");
      setMsg({ kind: "ok", text: `Approved exactly ${fmt(plan!.trip.quoteCents)}. Nothing has been charged yet.` });
    });

  const book = (delta: number) =>
    run("book", async () => {
      const r = await api<{ ok: boolean; detail: string }>("/api/plan/book", { tripId: plan!.trip.id, fareDeltaCents: delta, tripToken: plan!.approvalToken });
      setStage(r.ok ? "booked" : "declined");
      setMsg(r.ok ? { kind: "ok", text: `Booked on a single-use card for exactly ${fmt(plan!.trip.quoteCents)} (simulated).` } : { kind: "err", text: `The card declined ${r.detail}. You'll be asked to approve the new exact amount.` });
    });

  const stops = plan?.evidence.find((e) => e.kind === "stop");
  const weather = plan?.evidence.find((e) => e.kind === "weather");
  const fare = plan?.evidence.find((e) => e.kind === "fare");

  return (
    <aside className="dk-panel fd-plan" aria-label={`Trip plan for ${event.name}`}>
      <div className="dk-ph">
        <h2>Your trip</h2>
        <button className="dk-btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <p>
        <b>{event.name}</b>
        <br />
        <span className="dk-mut">
          {event.city} · {event.distanceMiles} mi from {zip}
        </span>
      </p>
      {msg && <div className={`dk-toast ${msg.kind}`}>{msg.text}</div>}

      {!plan && (
        <>
          <label className="fd-label">
            Your initials (shown to buddies instead of your name)
            <input className="dk-in" value={initials} onChange={(e) => setInitials(e.target.value.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase())} placeholder="e.g. JP" />
          </label>
          <label className="fd-label">
            Your maximum travel spend
            <span className="fd-money"><b>$</b><input className="dk-in" type="number" min="0" max="10000" step="1" value={budgetUsd} onChange={(e) => setBudgetUsd(e.target.value)} placeholder="e.g. 120" aria-label="Your maximum travel budget in dollars" /></span>
          </label>
          <label className="fd-drive">
            <span>Include self-drive</span>
            <input type="checkbox" checked={includeSelfDrive} onChange={(e) => setIncludeSelfDrive(e.target.checked)} />
            <span className="fd-drive-switch" aria-hidden="true"><i /></span>
          </label>
          <p className="dk-note">This is your personal limit. It filters routes but never raises the organizer’s reimbursement cap.</p>
          <button className="dk-btn primary" disabled={!!busy || budgetUsd === "" || Number(budgetUsd) < 0} onClick={doPlan}>
            {busy === "plan" ? "Comparing routes…" : "Compare ways to get there"}
          </button>
          <p className="dk-mut">Live fares and stops come from the public web; weather from the National Weather Service. It can take up to a minute.</p>
        </>
      )}

      {plan?.routes && (
        <>
          <h3>Ways to get there</h3>
          <table className="dk-table tight">
            <thead>
              <tr>
                <th>Option</th>
                <th className="r">Cost</th>
                <th className="r">Chance you’re late</th>
              </tr>
            </thead>
            <tbody>
              {plan.routes.options.map((o) => (
                <tr key={o.mode} className={plan.routes?.pick?.mode === o.mode ? "sel" : ""}>
                  <td>
                    {o.mode} {plan.routes?.pick?.mode === o.mode && <span className="dk-tag">best</span>}
                    <div className="dk-mut">{o.costSource}</div>
                  </td>
                  <td className="r num">
                    {fmt(o.costCents)}
                    {!o.withinCap && <div className="dk-warn">over organizer cap</div>}
                    {!o.withinBudget && <div className="dk-warn">over your budget</div>}
                  </td>
                  <td className="r num">{o.history.trips ? `${Math.round(o.pMiss * 100)}%` : "no history yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="fd-handoff">
            <div><span>Your choice</span><b>{fmt(plan.routes.travelerBudgetCents ?? 0)} budget</b></div>
            <i aria-hidden="true">→</i>
            <div><span>Organizer policy</span><b>{fmt(plan.routes.cap)} cap · R1</b></div>
            <i aria-hidden="true">→</i>
            <div><span>Finance desk</span><b>{plan.routes.pick ? `${fmt(plan.trip.reimbursementEligibleCents ?? 0)} eligible` : "waiting"}</b></div>
          </div>
          {plan.routes.blockReason === "TRAVELER_BUDGET" && (
            <div className="dk-q">
              <b>No route fits your budget.</b>
              <p>The organizer has eligible options, but S’mile will not spend beyond your limit. Choose a different event or change your budget.</p>
              <button className="dk-btn ghost" onClick={() => setPlan(null)}>Change my budget</button>
            </div>
          )}
          {plan.routes.blockReason === "MAX_DISTANCE" && (
            <div className="dk-q"><b>This event is outside your distance limit.</b><p>Go back and increase the maximum distance only if you want to.</p></div>
          )}
          {plan.routes.blockReason === "ORGANIZER_CAP" && <p className="dk-note">No route fits organizer policy R1. The finance controller—not the traveler—receives the exception request.</p>}
          {fare?.status !== "ok" && <p className="dk-note">Fares: {fare?.note ?? fare?.status}.{includeSelfDrive ? " Driving cost is the IRS mileage rate × distance." : " Self-drive is excluded from this plan."}</p>}

          <h3>A stop on the way</h3>
          {stops?.status === "ok" && Array.isArray(stops.data.results) && (stops.data.results as unknown[]).length ? (
            <ul className="dk-ul">
              {(stops.data.results as { title: string; link: string }[]).map((r) => (
                <li key={r.link}>
                  <a href={r.link} target="_blank" rel="noreferrer">
                    {r.title}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dk-note">{stops?.note ?? "No stop found yet."}</p>
          )}
          {weather && <p className="dk-mut">Weather at kickoff: {weather.status === "ok" ? `${weather.data.summary}, ${weather.data.tempF}°F` : weather.note}</p>}

          <h3>Buddies on your route</h3>
          {plan.buddies.length ? (
            <div className="dk-row">
              {plan.buddies.map((b, i) => (
                <span key={i} className="fd-buddy" title={`${b.mode}, ~${b.milesApart} mi from you`}>
                  {b.initials}
                </span>
              ))}
              <span className="dk-mut">
                {plan.buddies.length} going from within 15 mi{plan.buddies.some((b) => b.sameMode) ? `, ${plan.buddies.filter((b) => b.sameMode).length} by ${plan.trip.mode}` : ""}. Only initials are shared.
              </span>
            </div>
          ) : (
            <p className="dk-mut">No one else nearby has planned this event yet. You’ll be matched as others plan it.</p>
          )}
          <p className="dk-mut">
            Going with friends? <a href="/chat">Plan it together in the @smile group chat →</a>
          </p>

          {stage === "planned" && plan.inbox && (
            <div className="dk-q">
              <p>{plan.inbox.question}</p>
              <button className="dk-btn primary" disabled={!!busy} onClick={approve}>
                Approve exactly {fmt(plan.trip.quoteCents)}
              </button>
            </div>
          )}
          {stage === "approved" && (
            <div className="dk-row">
              <button className="dk-btn primary" disabled={!!busy} onClick={() => book(0)}>
                Book at {fmt(plan.trip.quoteCents)}
              </button>
              <button className="dk-btn ghost" disabled={!!busy} onClick={() => book(350)}>
                Demo: fare rises $3.50 at checkout
              </button>
            </div>
          )}
          {stage === "booked" && (
            <div className="fd-booked">
              <p className="dk-ok">Booked. Nothing more will be charged without asking you.</p>
              <p><b>Finance handoff created.</b> Booking evidence is now visible to the organizer. Reimbursement still waits for the receipt, check-in and bank settlement.</p>
              <a className="dk-btn ghost" href="/desk">View organizer reimbursement desk →</a>
            </div>
          )}
        </>
      )}
      {plan && !plan.routes && <p className="dk-warn">Couldn’t plan this trip: {plan.evidence.map((e) => `${e.kind} ${e.status}`).join(", ")}.</p>}
    </aside>
  );
}
