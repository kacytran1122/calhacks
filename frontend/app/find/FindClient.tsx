"use client";

import { useCallback, useEffect, useState } from "react";
import { SmileWord } from "@/components/landing/Smile";
import { stateCodeFrom } from "@/lib/usState";
import { CarbonCompare, CarpoolCard, type CarbonComparison, type Carpool } from "./CarbonCompare";
import { TripInsights } from "./TripInsights";

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
  routes: { options: RouteOption[]; pick?: { mode: string }; pickReason?: string; fastest?: string; lowestCarbon?: string; carbon?: CarbonComparison; cap: number; travelerBudgetCents?: number; maxDistanceMiles?: number; blockReason?: "TRAVELER_BUDGET" | "ORGANIZER_CAP" | "MAX_DISTANCE" | "NO_VERIFIED_FARE" } | null;
  carpool?: Carpool | null;
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
type ConstraintAnswer = { question: string; answer: string };
type RouteOption = { mode: string; costCents: number; costSource: string; pMiss: number; history: { trips: number; late: number }; withinCap: boolean; withinBudget: boolean; co2eKg?: number; co2eFormula?: string; minutes?: number; minutesSource?: string };
type RouteGuide = { mode: string; title: string; durationText: string | null; sourceUrl: string; sourceQuote: string; steps: { instruction: string; detail: string | null }[] };
type FareItem = { mode: string; amountUsd: number; link: string; quote: string; routeTitle?: string; provider?: string; priceScope?: "route_total" | "published_ticket" | "day_pass"; fees?: "included" | "not_applicable" | "not_stated" };

const fmt = (c: number) => (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toFixed(2);
const SOURCE = { luma: "Luma", devpost: "Devpost", mlh: "MLH" } as const;
const KM_PER_MILE = 1.609344;

function displayDistance(miles: number, unit: "mi" | "km") {
  return Math.round(unit === "mi" ? miles : miles * KM_PER_MILE);
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const responseText = await res.text();
  let json: Record<string, unknown> | null = null;
  if (responseText) {
    try {
      json = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      throw new Error(`S’mile received an unreadable response from ${url} (HTTP ${res.status}). Please try again.`);
    }
  }
  if (!res.ok) throw new Error(typeof json?.error === "string" ? json.error : `S’mile could not complete ${url} (HTTP ${res.status}). Please try again.`);
  if (!json) throw new Error(`S’mile received an empty response from ${url} (HTTP ${res.status}). Please try again.`);
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

function modeName(mode: string) {
  return ({ train: "Train + local transit", bus: "Bus + local transit", rideshare: "Rideshare", flight: "Flight + airport transfer", drive: "Self-drive" } as Record<string, string>)[mode] ?? mode;
}

function liveDirectionsUrl(origin: string, event: Listing, mode: string) {
  const destination = event.lat !== undefined && event.lon !== undefined ? `${event.lat},${event.lon}` : [event.venue, event.city].filter(Boolean).join(", ");
  if (mode === "flight") return `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${origin} to ${destination}`)}`;
  const travelmode = mode === "drive" || mode === "rideshare" ? "driving" : "transit";
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=${travelmode}`;
}

function RouteInstructions({ option, guide, fare, origin, event, best = false, tags = [], why }: { option: RouteOption; guide?: RouteGuide; fare?: FareItem; origin: string; event: Listing; best?: boolean; tags?: string[]; why?: string }) {
  const destination = event.venue || event.city || event.name;
  const directionsUrl = liveDirectionsUrl(origin, event, option.mode);
  const steps = guide?.steps?.length ? guide.steps : [
    { instruction: `Start at ${origin}.`, detail: `Open the live ${option.mode === "drive" || option.mode === "rideshare" ? "road" : "transit"} directions before leaving so the first departure and delays are current.` },
    { instruction: `Follow the ${modeName(option.mode).toLowerCase()} route to ${destination}.`, detail: "Use the linked live directions for the exact platform, stop, terminal, or pickup point." },
    { instruction: `Complete the last leg to ${event.name}.`, detail: event.city ? `Confirm the event entrance in ${event.city} before the final transfer.` : "Confirm the event entrance before the final transfer." },
  ];
  const content = (
    <>
      <div className="fd-route-head">
        <div><span>{best ? "Best route" : "Alternative"}</span><h3>{guide?.title || modeName(option.mode)}</h3></div>
        <div className="fd-route-price"><b>{fmt(option.costCents)}</b><small>trip total</small></div>
      </div>
      <div className="fd-route-facts">
        {guide?.durationText && <span>{guide.durationText}</span>}
        <span>{option.history.trips ? `${Math.round(option.pMiss * 100)}% historical late risk` : "new route · no history yet"}</span>
        <span>{option.mode === "drive" ? "IRS mileage estimate" : fare ? "exact published fare" : "fare not verified"}</span>
        {option.co2eKg !== undefined && <span title={option.co2eFormula}>≈ {option.co2eKg} kg CO₂e per traveler</span>}
        {tags.map((t) => <span key={t} className="fd-tag">{t}</span>)}
      </div>
      {why && <p className="fd-why"><b>Why this route:</b> {why}</p>}
      <ol className="fd-route-steps">
        {steps.map((step, index) => <li key={`${option.mode}-${index}`}><i>{index + 1}</i><div><b>{step.instruction}</b>{step.detail && <span>{step.detail}</span>}</div></li>)}
      </ol>
      <div className="fd-cost-box">
        <div><span>{option.mode === "drive" ? "Estimated driving cost" : "Exact fare found"}</span><b>{fmt(option.costCents)}</b></div>
        <p>{option.mode === "drive" ? "Mileage estimate based on the current IRS rate and route distance." : fare ? `${fare.provider ? `${fare.provider}: ` : ""}“${fare.quote}”${fare.fees === "included" ? " Taxes and mandatory fees are included in the quoted total." : fare.fees === "not_applicable" ? " This is the published operator fare for the covered ticket or pass." : " The source does not separately state fees."}` : "No explicit live fare was published, so S’mile will not approve an amount."}</p>
      </div>
      <div className="dk-row fd-route-links">
        <a className="dk-btn primary" href={directionsUrl} target="_blank" rel="noreferrer">Open live directions ↗</a>
        {fare?.link && <a className="dk-link" href={fare.link} target="_blank" rel="noreferrer">Check fare source ↗</a>}
        {guide?.sourceUrl && <a className="dk-link" href={guide.sourceUrl} target="_blank" rel="noreferrer">Route data sources ↗</a>}
      </div>
      {guide?.sourceQuote && <p className="fd-route-source">Route source: {guide.sourceQuote}</p>}
      {!option.withinCap && <div className="dk-warn">This option is over the organizer cap.</div>}
      {!option.withinBudget && <div className="dk-warn">This option is over your travel budget.</div>}
    </>
  );
  if (best) return <section className="fd-route-card best">{content}</section>;
  return <details className="fd-route-card alternative"><summary><span>{modeName(option.mode)}{option.co2eKg !== undefined && <small> · {option.co2eKg} kg CO₂e</small>}</span><b>{fmt(option.costCents)}</b></summary><div className="fd-route-detail">{content}</div></details>;
}

function UnpricedRouteGuide({ guide, origin, event, best = false, tags = [] }: { guide: RouteGuide; origin: string; event: Listing; best?: boolean; tags?: string[] }) {
  const content = (
      <div className="fd-route-detail">
        <div className="fd-route-head"><div><span>{best ? "Best live route" : "Live alternative"}</span><h3>{guide.title}</h3></div><div className="fd-route-price"><small>fare verification needed</small></div></div>
        <div className="fd-route-facts">{guide.durationText && <span>{guide.durationText}</span>}<span>{guide.mode === "flight" ? "Google Flights schedule · fare checked separately" : guide.mode === "drive" ? "OSRM live road route" : "public GTFS / GTFS-Realtime"}</span>{tags.map((tag) => <span key={tag} className="fd-tag">{tag}</span>)}</div>
        <ol className="fd-route-steps">
          {guide.steps.map((step, index) => <li key={`${guide.title}-${index}`}><i>{index + 1}</i><div><b>{step.instruction}</b>{step.detail && <span>{step.detail}</span>}</div></li>)}
        </ol>
        <div className="dk-row fd-route-links">
          <a className="dk-btn primary" href={liveDirectionsUrl(origin, event, guide.mode)} target="_blank" rel="noreferrer">Open live directions ↗</a>
          <a className="dk-link" href={guide.sourceUrl} target="_blank" rel="noreferrer">Route data sources ↗</a>
        </div>
        <p className="fd-route-source">Route source: {guide.sourceQuote}</p>
        <p className="dk-note">This route is shown for comparison, but S’mile will not approve a total until a public source states the current fare. For flights, the Price outlook below checks Google Flights now and shows a clearly labeled predicted range for later.</p>
      </div>
  );
  if (best) return <section className="fd-route-card best">{content}</section>;
  return <details className="fd-route-card alternative"><summary><span>{guide.title}{tags.map((tag) => <small key={tag}> · {tag}</small>)}</span><b>check fare</b></summary>{content}</details>;
}

export function FindClient({ initialZip, initialOrigin, initialLat, initialLon }: { initialZip: string; initialOrigin?: string; initialLat?: number; initialLon?: number }) {
  const [locationInput, setLocationInput] = useState(initialOrigin || initialZip);
  const [resolvedInput, setResolvedInput] = useState(initialOrigin || initialZip);
  const [originCoordinates, setOriginCoordinates] = useState(initialLat !== undefined && initialLon !== undefined ? { lat: initialLat, lon: initialLon } : undefined);
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
  const [resolvingGpsLabel, setResolvingGpsLabel] = useState(initialOrigin === "Current location" && initialLat !== undefined && initialLon !== undefined);

  useEffect(() => {
    if (initialOrigin !== "Current location" || initialLat === undefined || initialLon === undefined) return;
    const controller = new AbortController();
    const resolveGpsLabel = async () => {
      try {
        const response = await fetch(`/api/location/resolve?lat=${encodeURIComponent(initialLat)}&lon=${encodeURIComponent(initialLon)}&fallbackZip=${encodeURIComponent(initialZip)}`, { cache: "no-store", signal: controller.signal });
        const location = await response.json() as { zip?: string; label?: string };
        if (!response.ok || !location.zip || !location.label) return;
        const coordinates = { lat: initialLat, lon: initialLon };
        setZip(location.zip);
        setLocationInput(location.label);
        setResolvedInput(location.label);
        setOriginCoordinates(coordinates);
        setRes((current) => current ? { ...current, origin: { ...current.origin, zip: location.zip!, label: location.label } } : current);
        history.replaceState(null, "", `/find?zip=${location.zip}&origin=${encodeURIComponent(location.label)}&gps=1&lat=${initialLat}&lon=${initialLon}`);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setErr("Your GPS coordinates are available, but the nearby city name could not be loaded. You can still search from this location.");
      } finally {
        if (!controller.signal.aborted) setResolvingGpsLabel(false);
      }
    };
    resolveGpsLabel();
    return () => controller.abort();
  }, [initialZip, initialOrigin, initialLat, initialLon]);

  const search = useCallback(async (z: string, nextRadius = radius, nextQuery = q, nextGroups = groups, originLabel = locationInput, coordinates = originCoordinates) => {
    if (!/^\d{5}$/.test(z)) return setErr("Enter a 5-digit ZIP.");
    setLoading(true);
    setErr(null);
    setPicked(null);
    try {
      const query = nextQuery.trim();
      const p = new URLSearchParams({ zip: z, radius: String(nextRadius), groups: [...nextGroups].join(",") });
      if (coordinates) {
        p.set("lat", String(coordinates.lat));
        p.set("lon", String(coordinates.lon));
        p.set("originLabel", originLabel || "Current location");
      }
      if (query) p.set("q", query);
      setRes(await api<Discover>(`/api/events?${p}`));
      setActiveQuery(query);
      setZip(z);
      history.replaceState(null, "", `/find?zip=${z}&origin=${encodeURIComponent(originLabel || z)}${coordinates ? `&gps=1&lat=${coordinates.lat}&lon=${coordinates.lon}` : ""}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [radius, q, groups, locationInput, originCoordinates]);

  const useTypedLocation = async () => {
    const input = locationInput.trim();
    if (!input) return setErr("Enter a U.S. ZIP code, city, state, or city and state.");
    setLoading(true);
    setErr(null);
    try {
      const location: { zip: string; label?: string; lat?: number; lon?: number } = input === resolvedInput && /^\d{5}$/.test(zip) && originCoordinates
        ? { zip, label: input, ...originCoordinates }
        : /^\d{5}$/.test(input)
          ? { zip: input, label: input }
          : await api<{ zip: string; label?: string; lat?: number; lon?: number }>(`/api/location/resolve?city=${encodeURIComponent(input)}`);
      const label = location.label ?? input;
      const coordinates = typeof location.lat === "number" && typeof location.lon === "number" ? { lat: location.lat, lon: location.lon } : undefined;
      setZip(location.zip);
      setLocationInput(label);
      setResolvedInput(label);
      setOriginCoordinates(coordinates);
      await search(location.zip, radius, q, groups, label, coordinates);
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
              setOriginCoordinates(undefined);
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
        <button className="dk-btn primary" disabled={resolvingGpsLabel || loading}>
          {resolvingGpsLabel ? "Identifying your city…" : loading ? "Updating nearby events…" : "Update nearby events"}
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
        {picked && <PlanPane key={picked.key} zip={zip} originText={locationInput} originState={stateCodeFrom(res?.origin.label ?? locationInput)} originCoordinates={originCoordinates} maxDistanceMiles={radius} event={picked} onClose={() => setPicked(null)} />}
      </div>
    </div>
  );
}

function PlanPane({ zip, originText, originState, originCoordinates, maxDistanceMiles, event, onClose }: { zip: string; originText: string; originState?: string; originCoordinates?: { lat: number; lon: number }; maxDistanceMiles: number; event: Listing; onClose: () => void }) {
  const [initials, setInitials] = useState("");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [constraintText, setConstraintText] = useState("");
  const [constraintAnswer, setConstraintAnswer] = useState("");
  const [constraintAnswers, setConstraintAnswers] = useState<ConstraintAnswer[]>([]);
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
      const activeQuestion = constraintReview?.status === "needs_clarification"
        ? constraintReview.followUpQuestion ?? "What exact place, date, time, and time zone should S’mile use?"
        : null;
      const submittedAnswer = constraintAnswer.trim();
      const completedAnswers = submittedAnswer && activeQuestion
        ? [...constraintAnswers, { question: activeQuestion, answer: submittedAnswer }]
        : constraintAnswers;
      const rawConstraint = [
        constraintText.trim(),
        ...completedAnswers.map(({ question, answer }) => `Follow-up question: ${question}\nTraveler's answer: ${answer}`),
      ].filter(Boolean).join("\n\n");
      let reviewed = constraintReview;
      if (rawConstraint && (!reviewed || reviewedConstraintText !== rawConstraint)) {
        reviewed = await api<ConstraintReview>("/api/constraints", {
          text: rawConstraint,
          origin: zip,
          eventName: event.name,
          eventVenue: event.venue,
          eventCity: event.city,
          eventStartsAt: event.startsAt,
          eventLat: event.lat,
          eventLon: event.lon,
        });
        setConstraintReview(reviewed);
        setReviewedConstraintText(rawConstraint);
      }
      if (submittedAnswer && activeQuestion) {
        setConstraintAnswers(completedAnswers);
        setConstraintAnswer("");
      }
      if (reviewed?.status === "needs_clarification") return;
      const p = await api<Plan>("/api/plan", {
        zip,
        originText: originText || zip,
        originCoordinates,
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
      setMsg(r.ok ? { kind: "ok", text: `${r.detail}. Capture remains disabled.` } : { kind: "err", text: `The card declined ${r.detail}. You'll be asked to approve the new exact amount.` });
    });

  const stops = plan?.evidence.find((e) => e.kind === "stop");
  const weather = plan?.evidence.find((e) => e.kind === "weather");
  const homeGeo = plan?.evidence.find((e) => e.kind === "geocode");
  const fare = plan?.evidence.find((e) => e.kind === "fare");
  const routeGuide = plan?.evidence.find((e) => e.kind === "route_guide");
  const constraint = plan?.evidence.find((e) => e.kind === "traveler_constraint");
  const fareItems = (Array.isArray(fare?.data.fares) ? fare.data.fares : []) as FareItem[];
  const stopItems = (Array.isArray(stops?.data.results) ? stops.data.results : []) as { title: string; link: string }[];
  const routeGuides = (Array.isArray(routeGuide?.data.options) ? routeGuide.data.options : []) as RouteGuide[];
  const pickedRoute = plan?.routes?.options.find((option) => option.mode === plan.routes?.pick?.mode);
  const alternativeRoutes = plan?.routes?.options.filter((option) => option.mode !== plan.routes?.pick?.mode) ?? [];
  const fareFor = (option: RouteOption) => fareItems.find((item) => item.mode === option.mode);
  const tagsFor = (option: RouteOption) => [...(option.mode === plan?.routes?.lowestCarbon ? ["Lowest carbon of these"] : []), ...(option.mode === plan?.routes?.fastest ? ["Fastest"] : [])];
  const guideFor = (option: RouteOption) => {
    const matchedFare = fareFor(option);
    return matchedFare?.routeTitle
      ? routeGuides.find((guide) => guide.title === matchedFare.routeTitle)
      : routeGuides.find((guide) => guide.mode === option.mode);
  };
  const representedGuideIndexes = new Set<number>();
  for (const option of plan?.routes?.options ?? []) {
    const selectedGuide = guideFor(option);
    const index = routeGuides.findIndex((guide, guideIndex) => guide === selectedGuide && !representedGuideIndexes.has(guideIndex));
    if (index >= 0) representedGuideIndexes.add(index);
  }
  const additionalRouteGuides = routeGuides
    .filter((_, index) => !representedGuideIndexes.has(index))
    .sort((a, b) => Number(b.mode === plan?.routes?.fastest) - Number(a.mode === plan?.routes?.fastest));
  const guideTags = (guide: RouteGuide) => guide.mode === plan?.routes?.fastest ? ["Fastest"] : [];
  const unpricedPrimary = !pickedRoute ? additionalRouteGuides[0] : undefined;
  const unpricedAlternatives = !pickedRoute ? additionalRouteGuides.slice(1) : additionalRouteGuides;

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
                setConstraintAnswers([]);
                setReviewedConstraintText("");
              }}
              placeholder="For example: I need to arrive at SFO by 10:00 PM PT on October 25, or be at UCI by 10:00 AM PT."
              aria-label="Travel timing and destination requirements"
            />
          </label>
          {constraintAnswers.length > 0 && (
            <div className="fd-constraint-history" aria-label="Previous travel requirement answers">
              {constraintAnswers.map(({ question, answer }, index) => (
                <div key={`${question}-${index}`}>
                  <span>{question}</span>
                  <p>{answer}</p>
                </div>
              ))}
            </div>
          )}
          {constraintReview?.status === "needs_clarification" && (
            <div className="fd-constraint-question" role="status">
              <b>One detail before S’mile plans</b>
              <p>{constraintReview.followUpQuestion ?? "What exact place, date, time, and time zone should S’mile use?"}</p>
              <textarea key={constraintReview.followUpQuestion} className="dk-in" rows={2} maxLength={500} value={constraintAnswer} onChange={(e) => setConstraintAnswer(e.target.value)} placeholder="Type your answer" aria-label="Answer the travel requirement question" />
            </div>
          )}
          {constraintReview?.status === "ready" && <div className="fd-constraint-ready"><b>Travel requirements confirmed</b><span>{constraintReview.summary}</span></div>}
          <label className="fd-drive">
            <span>Include self-drive</span>
            <input type="checkbox" checked={includeSelfDrive} onChange={(e) => setIncludeSelfDrive(e.target.checked)} />
            <span className="fd-drive-switch" aria-hidden="true"><i /></span>
          </label>
          <p className="dk-note">This is your personal limit. It filters routes but never raises the organizer’s reimbursement cap.</p>
          <button className="dk-btn primary" disabled={!!busy || budgetUsd === "" || Number(budgetUsd) < 0 || (constraintReview?.status === "needs_clarification" && !constraintAnswer.trim())} onClick={doPlan}>
            {busy === "plan" ? "Coordinating your trip…" : constraintReview?.status === "needs_clarification" ? "Answer and compare routes" : "Compare ways to get there"}
          </button>
          <p className="dk-mut">S’mile checks current public route, fare, and weather evidence before comparing your options.</p>
        </>
      )}

      {plan?.routes && (
        <>
          {constraint?.data.summary && <div className="fd-constraint-ready"><b>Travel requirement applied</b><span>{String(constraint.data.summary)}</span></div>}
          {pickedRoute && <RouteInstructions option={pickedRoute} guide={guideFor(pickedRoute)} fare={fareFor(pickedRoute)} origin={originText || zip} event={event} best tags={tagsFor(pickedRoute)} why={plan.routes.pickReason} />}
          {unpricedPrimary && <UnpricedRouteGuide guide={unpricedPrimary} origin={originText || zip} event={event} best tags={guideTags(unpricedPrimary)} />}
          {(alternativeRoutes.length > 0 || unpricedAlternatives.length > 0) && <section className="fd-alternatives"><div className="fd-section-title"><span>Fastest route and alternatives</span><small>Every available live itinerary is shown. Unverified fares stay visible for comparison but cannot be approved.</small></div>{alternativeRoutes.map((option) => <RouteInstructions key={option.mode} option={option} guide={guideFor(option)} fare={fareFor(option)} origin={originText || zip} event={event} tags={tagsFor(option)} />)}{unpricedAlternatives.map((guide, index) => <UnpricedRouteGuide key={`${guide.title}-${index}`} guide={guide} origin={originText || zip} event={event} tags={guideTags(guide)} />)}</section>}
          {plan.routes.carbon && <CarbonCompare carbon={plan.routes.carbon} pick={plan.routes.pick?.mode} fastest={plan.routes.fastest} priced={plan.routes.options.map((o) => o.mode)} carpool={plan.carpool ?? null} />}
          <div className="fd-handoff">
            <div><span>Your choice</span><b>{fmt(plan.routes.travelerBudgetCents ?? 0)} budget</b></div>
            <i aria-hidden="true">→</i>
            <div><span>Organizer policy</span><b>{fmt(plan.routes.cap)} cap · R1</b></div>
            <i aria-hidden="true">→</i>
            <div><span>Finance desk</span><b>{plan.routes.pick ? `${fmt(plan.trip.reimbursementEligibleCents ?? 0)} eligible` : "No approval yet"}</b></div>
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
          {plan.routes.blockReason === "NO_VERIFIED_FARE" && <p className="dk-note">No payment approval was created because no live source stated a complete trip total. Review the route now, then refresh closer to departure or open the live source to confirm the fare.</p>}
          {plan.routes.blockReason === "ORGANIZER_CAP" && <p className="dk-note">No route fits organizer policy R1. The finance controller—not the traveler—receives the exception request.</p>}
          {fare?.status !== "ok" && plan.routes.blockReason !== "NO_VERIFIED_FARE" && <p className="dk-note">A verified live fare is not available for this route yet. S’mile will not estimate or invent a price.{includeSelfDrive ? " Driving cost uses the IRS mileage rate and the live route distance." : ""}</p>}

          {stops?.status === "ok" && stopItems.length > 0 && (
            <section className="fd-stop-options">
              <h3>Near the event</h3>
              <ul className="dk-ul">
              {stopItems.map((r) => (
                <li key={r.link}>
                  <a href={r.link} target="_blank" rel="noreferrer">
                    {r.title}
                  </a>
                </li>
              ))}
              </ul>
            </section>
          )}
          {weather && <p className="dk-mut">Weather at kickoff: {weather.status === "ok" ? `${weather.data.summary}, ${weather.data.tempF}°F` : weather.note || "The event hour is not in the published forecast window yet."}</p>}

          <TripInsights
            from={originCoordinates ?? (homeGeo?.status === "ok" && typeof homeGeo.data.lat === "number" && typeof homeGeo.data.lon === "number" ? { lat: homeGeo.data.lat, lon: homeGeo.data.lon } : undefined)}
            to={event.lat !== undefined && event.lon !== undefined ? { lat: event.lat, lon: event.lon } : undefined}
            startsAt={event.startsAt}
            fromState={originState ?? stateCodeFrom(typeof homeGeo?.data.label === "string" ? homeGeo.data.label : undefined)}
            toState={stateCodeFrom(event.city)}
          />

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
          {plan.carpool && <CarpoolCard carpool={plan.carpool} />}
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
