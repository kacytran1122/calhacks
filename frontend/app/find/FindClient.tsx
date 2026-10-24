"use client";

import { useCallback, useState } from "react";
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
  thumbnailUrl?: string;
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
  outsideRadius?: Listing[];
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
type ConstraintReview = {
  status: "ready" | "needs_clarification";
  summary: string;
  destination: string | null;
  arriveBy: string | null;
  departAfter: string | null;
  timezone: string | null;
  followUpQuestion: string | null;
  parsedBy: "claude" | "rules";
};

const fmt = (c: number) => (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toFixed(2);
const SOURCE = { luma: "Luma", devpost: "Devpost", mlh: "MLH" } as const;
const KM_PER_MILE = 1.609344;

function displayDistance(miles: number, unit: "mi" | "km") {
  return Math.round(unit === "mi" ? miles : miles * KM_PER_MILE);
}

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

function EventVisual({ event, compact = false }: { event: Listing; compact?: boolean }) {
  const fallback = event.source === "mlh" || event.alsoOn?.includes("mlh") ? "/mlh-logo.png" : "/tech-events-icon.png";
  const hasThumbnail = Boolean(event.thumbnailUrl);
  return (
    <span className={`fd-event-visual${compact ? " compact" : ""}${hasThumbnail ? "" : " fallback"}`} aria-hidden="true">
      <img src={event.thumbnailUrl ?? fallback} alt="" onError={(e) => { e.currentTarget.parentElement?.classList.add("fallback"); e.currentTarget.src = fallback; }} />
    </span>
  );
}

export function FindClient({ initialZip }: { initialZip: string }) {
  const [locationInput, setLocationInput] = useState(initialZip);
  const [zip, setZip] = useState(initialZip);
  const [radius, setRadius] = useState(200);
  const [distanceUnit, setDistanceUnit] = useState<"mi" | "km">("mi");
  const [q, setQ] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [groups, setGroups] = useState<Set<"mlh" | "tech">>(new Set(["mlh", "tech"]));
  const [res, setRes] = useState<Discover | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Listing | null>(null);

  const search = useCallback(async (z: string, nextRadius = radius, nextQuery = q, nextGroups = groups) => {
    if (!/^\d{5}$/.test(z)) return setErr("Enter a 5-digit ZIP.");
    setLoading(true);
    setErr(null);
    setPicked(null);
    try {
      const query = nextQuery.trim();
      const p = new URLSearchParams({ zip: z, radius: String(nextRadius), groups: [...nextGroups].join(",") });
      if (query) p.set("q", query);
      setRes(await api<Discover>(`/api/events?${p}`));
      setActiveQuery(query);
      setZip(z);
      history.replaceState(null, "", `/find?zip=${z}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [radius, q, groups]);

  const useTypedLocation = async () => {
    const input = locationInput.trim();
    if (!input) return setErr("Enter a U.S. ZIP code, city, state, or city and state.");
    setLoading(true);
    setErr(null);
    try {
      const location = /^\d{5}$/.test(input)
        ? { zip: input, label: input }
        : await api<{ zip: string; label?: string }>(`/api/location/resolve?city=${encodeURIComponent(input)}`);
      setZip(location.zip);
      setLocationInput(location.label ?? input);
      await search(location.zip);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const submitOrigin = () => {
    const input = locationInput.trim();
    if (!input) return setErr("Enter a U.S. ZIP code, city, state, or city and state.");
    useTypedLocation();
  };

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
        <div className="dk-co" />
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
          submitOrigin();
        }}
      >
        <label className="fd-origin">
          <span>Where are you starting?</span>
          <input
            className="dk-in"
            value={locationInput}
            onChange={(e) => {
              setLocationInput(e.target.value);
            }}
            autoComplete="address-level2"
            placeholder="ZIP, city, state, or city + state"
            aria-label="Starting ZIP, city, or state"
          />
        </label>
        <label className="fd-limit">
          <span>Max distance</span>
          <span className="fd-number">
            <input
              className="dk-in"
              type="number"
              min={1}
              max={distanceUnit === "mi" ? 3000 : 4828}
              value={displayDistance(radius, distanceUnit)}
              onChange={(e) => {
                const value = Math.max(1, Number(e.target.value) || 1);
                setRadius(Math.min(3000, distanceUnit === "mi" ? value : value / KM_PER_MILE));
              }}
              aria-label={`Maximum route distance in ${distanceUnit === "mi" ? "miles" : "kilometers"}`}
            />
            <span className="fd-unit" role="group" aria-label="Distance unit">
              <button type="button" aria-pressed={distanceUnit === "mi"} onClick={() => setDistanceUnit("mi")}>mi</button>
              <button type="button" aria-pressed={distanceUnit === "km"} onClick={() => setDistanceUnit("km")}>km</button>
            </span>
          </span>
        </label>
        <div className="fd-type-picker">
          <div className="fd-type-heading"><b>What do you want to find?</b><span>Choose one or both</span></div>
          <div className="fd-types" role="group" aria-label="Event types">
            <button type="button" aria-pressed={groups.has("mlh")} className={groups.has("mlh") ? "on mlh" : "mlh"} onClick={() => toggle("mlh")}>
              <span className="fd-type-icon" aria-hidden="true"><img src="/mlh-logo.png" alt="" /></span>
              <span><b>MLH events</b><small>Official student hackathons from MLH</small></span>
              <i aria-hidden="true">✓</i>
            </button>
            <button type="button" aria-pressed={groups.has("tech")} className={groups.has("tech") ? "on tech" : "tech"} onClick={() => toggle("tech")}>
              <span className="fd-type-icon" aria-hidden="true"><img src="/tech-events-icon.png" alt="" /></span>
              <span><b>Tech events</b><small>Local meetups, talks and workshops</small></span>
              <i aria-hidden="true">✓</i>
            </button>
          </div>
        </div>
        <button className="dk-btn primary" disabled={loading}>
          {loading ? "Updating nearby events…" : "Update nearby events"}
        </button>
      </form>

      {err && <div className="dk-toast err">{err}</div>}

      {res && (
        <section className="fd-results-head">
          <div className="fd-meta">
            <span><b>{res.events.length}</b> events within {displayDistance(res.radiusMiles, distanceUnit)} {distanceUnit} of {res.origin.label ?? res.origin.zip}</span>
          </div>
          <form className="fd-event-search" onSubmit={(e) => { e.preventDefault(); search(zip, radius, q); }}>
            <label htmlFor="event-search"><b>Looking for a specific event?</b><span>We’ll tell you clearly if it is outside your travel area.</span></label>
            <div>
              <input id="event-search" className="dk-in" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Try Cal Hacks, AI, Stanford…" aria-label="Search events by name or topic" />
              {q && <button type="button" className="fd-clear" aria-label="Clear event search" onClick={() => { setQ(""); search(zip, radius, ""); }}>×</button>}
              <button className="dk-btn primary" disabled={loading}>{loading ? "Checking events…" : "Search events"}</button>
            </div>
          </form>
        </section>
      )}

      {res && activeQuery && res.events.length === 0 && (res.outsideRadius?.length ?? 0) > 0 && (() => {
        const event = res.outsideRadius![0]!;
        const distance = event.distanceMiles ?? res.radiusMiles;
        const expandedRadius = Math.max(res.radiusMiles + 1, Math.ceil(distance));
        return (
          <section className="fd-outside" role="status">
            <EventVisual event={event} compact />
            <div>
              <span className="fd-eyebrow">A match exists beyond your limit</span>
              <h2>{event.name} is outside your {displayDistance(res.radiusMiles, distanceUnit)} {distanceUnit} travel area.</h2>
              <p>The closest matching event is in {event.city ?? event.venue ?? "another city"}, about <b>{displayDistance(distance, distanceUnit).toLocaleString()} {distanceUnit}</b> from {res.origin.label ?? res.origin.zip}. Expand your distance to include it, or keep your limit and explore closer events.</p>
              <div className="dk-row">
                <button className="dk-btn primary" onClick={() => { setRadius(expandedRadius); search(zip, expandedRadius, activeQuery); }}>Expand to {displayDistance(expandedRadius, distanceUnit).toLocaleString()} {distanceUnit}</button>
                <a className="dk-btn ghost" href={event.url} target="_blank" rel="noreferrer">View event page ↗</a>
              </div>
            </div>
          </section>
        );
      })()}

      <div className={`fd-grid ${picked ? "with-plan" : ""}`}>
        <div className="fd-list">
          {res?.events.map((e) => {
            const w = when(e);
            return (
              <article key={e.key} className={`fd-card ${picked?.key === e.key ? "sel" : ""}`}>
                <div className="fd-card-top">
                  <EventVisual event={e} />
                  <div className="fd-card-top-meta">
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
          {res && res.events.length === 0 && !(activeQuery && (res.outsideRadius?.length ?? 0) > 0) && <p className="dk-mut">{activeQuery ? `No MLH or tech events matching “${activeQuery}” were found in the next 90 days.` : "No MLH or tech events found in that radius in the next 90 days. Try a wider radius."}</p>}
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
  const [constraintText, setConstraintText] = useState("");
  const [constraintAnswer, setConstraintAnswer] = useState("");
  const [constraintReview, setConstraintReview] = useState<ConstraintReview | null>(null);
  const [reviewedConstraintText, setReviewedConstraintText] = useState("");
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
      const rawConstraint = [constraintText.trim(), constraintAnswer.trim() ? `Additional detail: ${constraintAnswer.trim()}` : ""].filter(Boolean).join("\n");
      let reviewed = constraintReview;
      if (rawConstraint && (!reviewed || reviewedConstraintText !== rawConstraint)) {
        reviewed = await api<ConstraintReview>("/api/constraints", {
          text: rawConstraint,
          origin: zip,
          eventName: event.name,
          eventCity: event.city,
          eventStartsAt: event.startsAt,
        });
        setConstraintReview(reviewed);
        setReviewedConstraintText(rawConstraint);
      }
      if (reviewed?.status === "needs_clarification") return;
      const p = await api<Plan>("/api/plan", {
        zip,
        initials: initials || undefined,
        travelerBudgetCents: Math.round(Number(budgetUsd) * 100),
        maxDistanceMiles,
        includeSelfDrive,
        travelConstraints: reviewed ? { ...reviewed, raw: rawConstraint } : undefined,
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
  const constraint = plan?.evidence.find((e) => e.kind === "traveler_constraint");

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
          <label className="fd-label fd-constraint-label">
            Any arrival, departure, or destination requirements?
            <textarea
              className="dk-in"
              rows={3}
              maxLength={1500}
              value={constraintText}
              onChange={(e) => {
                setConstraintText(e.target.value);
                setConstraintReview(null);
                setConstraintAnswer("");
                setReviewedConstraintText("");
              }}
              placeholder="For example: I need to arrive at SFO by 10:00 PM PT on October 25, or be at Knox College by 10:00 AM CT."
              aria-label="Travel timing and destination requirements"
            />
            <small>Write naturally. Claude will turn clear details into route constraints.</small>
          </label>
          {constraintReview?.status === "needs_clarification" && (
            <div className="fd-constraint-question" role="status">
              <b>One detail before S’mile plans</b>
              <p>{constraintReview.followUpQuestion ?? "What exact place, date, time, and time zone should S’mile use?"}</p>
              <input className="dk-in" value={constraintAnswer} onChange={(e) => setConstraintAnswer(e.target.value)} placeholder="Type your answer" aria-label="Answer Claude’s travel requirement question" />
            </div>
          )}
          {constraintReview?.status === "ready" && <div className="fd-constraint-ready"><b>Claude understood</b><span>{constraintReview.summary}</span></div>}
          <label className="fd-drive">
            <span>Include self-drive</span>
            <input type="checkbox" checked={includeSelfDrive} onChange={(e) => setIncludeSelfDrive(e.target.checked)} />
            <span className="fd-drive-switch" aria-hidden="true"><i /></span>
          </label>
          <p className="dk-note">This is your personal limit. It filters routes but never raises the organizer’s reimbursement cap.</p>
          <button className="dk-btn primary" disabled={!!busy || budgetUsd === "" || Number(budgetUsd) < 0 || (constraintReview?.status === "needs_clarification" && !constraintAnswer.trim())} onClick={doPlan}>
            {busy === "plan" ? "Coordinating your trip…" : constraintReview?.status === "needs_clarification" ? "Answer and compare routes" : "Compare ways to get there"}
          </button>
          <p className="dk-mut">Live fares and stops come from the public web; weather comes from the National Weather Service. Most plans return in 3–10 seconds.</p>
        </>
      )}

      {plan?.routes && (
        <>
          {constraint?.data.summary && <div className="fd-constraint-ready"><b>Travel requirement applied</b><span>{String(constraint.data.summary)}</span></div>}
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
