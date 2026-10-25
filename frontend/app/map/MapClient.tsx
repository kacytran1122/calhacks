"use client";

import { useEffect, useState } from "react";

declare global {
  interface Window { L?: unknown }
}

export function RideCheckoutDialog() {
  return (
    <dialog id="ride-checkout-dialog" className="ride-checkout" aria-labelledby="ride-checkout-title" aria-describedby="ride-checkout-description" aria-modal="true">
      <div className="ride-checkout-head">
        <span className="ride-checkout-kicker">Visa simulation</span>
        <h2 id="ride-checkout-title" tabIndex={-1}>Finished this ride?</h2>
        <p id="ride-checkout-description">Confirm that you have left the vehicle before creating a demo receipt.</p>
      </div>
      <div className="ride-checkout-body">
        <div className="ride-checkout-journey"><small>Planned ride</small><b id="ride-checkout-service" /><span id="ride-checkout-journey" /></div>
        <p id="ride-checkout-preview" className="ride-checkout-context" />
        <p className="ride-checkout-notice">This simulation does not buy or validate a ticket or pay the operator. Follow the operator’s actual payment rules for your journey.</p>
        <form id="ride-checkout-form" noValidate>
          <label className="ride-checkout-check"><input id="ride-checkout-completed" type="checkbox" /><span id="ride-checkout-completed-label">I have left this vehicle.</span></label>
          <label className="ride-checkout-amount" htmlFor="ride-checkout-amount">Demo amount (USD)<span className="ride-checkout-money"><b aria-hidden="true">$</b><input id="ride-checkout-amount" type="text" inputMode="decimal" autoComplete="off" maxLength={12} placeholder="Enter an amount" aria-describedby="ride-checkout-amount-help" /></span></label>
          <p id="ride-checkout-amount-help" className="ride-checkout-help">Enter a demo amount from $0.01 to $1,000.00 USD. This is not a live fare, and no card details are needed.</p>
          <label className="ride-checkout-check"><input id="ride-checkout-consent" type="checkbox" /><span>I understand this creates a demo record and moves no funds.</span></label>
          <button id="ride-checkout-pay" className="ride-checkout-pay" type="submit" disabled>Pay with Visa (simulation)</button>
        </form>
        <div id="ride-checkout-status" className="ride-checkout-status" role="status" aria-live="polite" />
        <button id="ride-checkout-retry" className="ride-checkout-secondary" type="button" hidden>Check saved receipts again</button>
        <section id="ride-checkout-receipt" className="ride-checkout-receipt" aria-labelledby="ride-checkout-receipt-title" hidden>
          <span className="ride-checkout-receipt-mark" aria-hidden="true">✓</span>
          <h3 id="ride-checkout-receipt-title">Your demo receipt</h3>
          <b id="ride-checkout-receipt-amount" className="ride-checkout-receipt-amount" />
          <dl>
            <div><dt>Service</dt><dd id="ride-checkout-receipt-service" /></div>
            <div><dt>Planned boarding point</dt><dd id="ride-checkout-receipt-from" /></div>
            <div><dt>Planned destination</dt><dd id="ride-checkout-receipt-to" /></div>
            <div><dt>Created</dt><dd id="ride-checkout-receipt-date" /></div>
            <div><dt>Reference</dt><dd id="ride-checkout-receipt-id" /></div>
          </dl>
          <p className="ride-checkout-receipt-warning">Simulation only. No funds moved. Exit was confirmed by the traveler, not verified by GPS or an operator. This is not an operator receipt and is not valid for reimbursement.</p>
          <button id="ride-checkout-download" className="ride-checkout-secondary" type="button">Download demo receipt (.txt)</button>
          <button id="ride-checkout-continue" className="ride-checkout-pay" type="button">Continue trip</button>
        </section>
        <button id="ride-checkout-skip" className="ride-checkout-skip" type="button">Skip without payment and continue</button>
        <button id="ride-checkout-dismiss" className="ride-checkout-dismiss" type="button">Still on board, return to route</button>
        <p className="ride-checkout-storage">Demo receipts are retained for up to 30 days. Recovery uses this browser’s private cookie; clearing it can prevent access. Download a copy to keep it longer.</p>
      </div>
    </dialog>
  );
}

export function TripReceiptDialog() {
  return (
    <dialog id="trip-receipt-dialog" className="ride-checkout trip-receipt" aria-labelledby="trip-receipt-title" aria-describedby="trip-receipt-description" aria-modal="true">
      <div className="ride-checkout-head">
        <span className="ride-checkout-kicker">Whole-trip summary · simulation</span>
        <h2 id="trip-receipt-title" tabIndex={-1}>Your trip, in one receipt.</h2>
        <p id="trip-receipt-description">A summary of the demo payments recorded for this journey. Creating this summary makes no additional payment.</p>
      </div>
      <div className="ride-checkout-body">
        <div className="ride-checkout-journey"><small>Planned journey</small><span id="trip-receipt-journey" /></div>
        <div id="trip-receipt-status" className="ride-checkout-status" role="status" aria-live="polite" />
        <section id="trip-receipt-content" aria-label="Consolidated demo receipt" hidden>
          <div className="trip-receipt-total"><span>Recorded demo total</span><b id="trip-receipt-total" /></div>
          <p id="trip-receipt-empty" className="ride-checkout-context" hidden>No simulated payments recorded. This is not the actual cost of your journey.</p>
          <ul id="trip-receipt-legs" className="trip-receipt-legs" aria-label="Vehicle legs and demo payments" />
          <p id="trip-receipt-missing" className="ride-checkout-context" />
          <dl className="trip-receipt-meta"><div><dt>Summary reference</dt><dd id="trip-receipt-reference" /></div><div><dt>Created</dt><dd id="trip-receipt-created" /></div></dl>
          <p className="ride-checkout-receipt-warning">Simulation only. No funds moved. This summary is not an operator receipt, does not validate a ticket, and is not valid for reimbursement. Completion was confirmed by the traveler, not verified by GPS or an operator.</p>
          <button id="trip-receipt-download" className="ride-checkout-secondary" type="button">Download trip receipt (.txt)</button>
          <button id="trip-receipt-done" className="ride-checkout-pay" type="button">Done</button>
        </section>
        <button id="trip-receipt-retry" className="ride-checkout-secondary" type="button" hidden>Try generating the summary again</button>
        <button id="trip-receipt-dismiss" className="ride-checkout-dismiss" type="button">Return to route</button>
        <p className="ride-checkout-storage">Demo receipts are retained for up to 30 days. Recovery uses this browser’s private cookie; clearing it can prevent access. Download a copy to keep it longer.</p>
      </div>
    </dialog>
  );
}

export function MapClient() {
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = (src: string, module = false) => new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      if (module) script.type = "module";
      script.dataset.smileMapRuntime = "true";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.body.appendChild(script);
    });

    const start = async () => {
      try {
        const current = new URL(window.location.href);
        const handoff = current.searchParams.get("handoff");
        if (handoff) {
          if (!/^phm1_[A-Za-z0-9_-]{43}$/.test(handoff)) throw new Error("This route handoff is invalid or expired.");
          const response = await fetch(`/api/map/handoff?token=${encodeURIComponent(handoff)}`, { cache: "no-store" });
          const body = await response.json().catch(() => ({})) as {
            error?: string;
            mode?: string;
            includeSelfDrive?: boolean;
            destination?: { query?: string; label?: string; lat?: number; lon?: number };
          };
          if (!response.ok) {
            throw new Error(body.error || (response.status === 503
              ? "Route handoff is temporarily unavailable. Reload in a moment."
              : "This route handoff is invalid or expired. Ask @smile for a new link."));
          }
          const destination = body.destination;
          const label = destination?.label || destination?.query;
          if (typeof destination?.lat === "number" && Number.isFinite(destination.lat)) current.searchParams.set("lat", String(destination.lat));
          if (typeof destination?.lon === "number" && Number.isFinite(destination.lon)) current.searchParams.set("lon", String(destination.lon));
          if (label) current.searchParams.set("to", label);
          if (body.mode && ["drive", "rideshare", "train", "bus", "flight"].includes(body.mode)) current.searchParams.set("mode", body.mode);
          current.searchParams.set("includeSelfDrive", String(body.includeSelfDrive ?? body.mode === "drive"));
          current.searchParams.delete("handoff");
          window.history.replaceState(window.history.state, "", `${current.pathname}${current.search}${current.hash}`);
        }
        setPreparing(false);
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (!window.L) await load("/map-assets/leaflet.js");
        if (!cancelled) await load(`/map-assets/map.js?v=9`, true);
      } catch (cause) {
        if (!cancelled) {
          setPreparing(false);
          setRuntimeError(cause instanceof Error ? cause.message : "The map could not start. Check your connection and reload this page.");
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      document.querySelectorAll<HTMLScriptElement>('script[data-smile-map-runtime="true"]').forEach((script) => script.remove());
    };
  }, []);

  if (preparing) {
    return <main id="app" className="map-app"><section className="permission-card"><div className="permission-icon" aria-hidden="true">↗</div><div><b>Opening your route</b><span>Verifying the private @smile handoff…</span></div></section></main>;
  }

  if (runtimeError) {
    return <main id="app" className="map-app"><section className="permission-card" role="alert"><div className="permission-icon" aria-hidden="true">!</div><div><b>Route unavailable</b><span>{runtimeError}</span></div><a href="/finding-events">Return to event search</a></section></main>;
  }

  return (
    <main id="app" className="map-app">
      <div id="map" aria-label="Interactive street map" />

      <header className="topbar">
        <form id="planner-form" className="planner-card" role="search">
          <div className="planner-head">
            <div><span>Route</span><b id="planner-title">Choose start and destination</b></div>
            <button id="toggle-planner" className="icon-button" type="button" aria-label="Collapse route planner" aria-expanded="true">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
            </button>
          </div>
          <div id="planner-summary" className="planner-summary hidden"><span id="summary-text" /><button id="edit-route" type="button">Edit</button></div>
          <div id="planner-body">
            <div className="point-stack" aria-label="Trip locations">
              <div className="point-row" data-field="start">
                <span className="point-node start-node" aria-hidden="true" />
                <label><small>Start</small><input id="start-input" autoComplete="off" enterKeyHint="search" defaultValue="My live location" aria-label="Starting point" /></label>
                <button id="use-live-start" className="row-action active" type="button" aria-label="Use my live location as starting point" title="Use live location">⌖</button>
              </div>
              <div id="waypoint-fields" />
              <div className="point-row" data-field="destination">
                <span className="point-node destination-node" aria-hidden="true" />
                <label><small>Destination</small><input id="destination-input" autoComplete="off" enterKeyHint="search" placeholder="Search destination" aria-label="Destination" /></label>
                <button className="row-action search-field" type="submit" aria-label="Search destination">⌕</button>
              </div>
            </div>
            <div className="planner-tools">
              <button id="add-stop" type="button">＋ Add stop</button>
              <label className="departure-field"><span>Leave</span><input id="departure-time" type="datetime-local" aria-label="Departure time" /></label>
            </div>
            <button id="plan-route" className="plan-button" type="button" disabled>Find my routes</button>
          </div>
        </form>
        <p id="search-hint" className="map-hint">Select a field, then search or press and hold the map</p>
        <div id="search-results" className="search-results hidden" aria-live="polite" />
      </header>

      <section id="permission-card" className="permission-card">
        <div className="permission-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 21s6-5.1 6-11a6 6 0 1 0-12 0c0 5.9 6 11 6 11Z"/><circle cx="12" cy="10" r="2"/></svg>
        </div>
        <div><b>Use your live location</b><span>Turn on GPS for precise progress and automatic rerouting. Your location stays in this browser.</span></div>
        <button id="location-permission" type="button">Use live GPS</button>
      </section>

      <div className="map-controls" aria-label="Map controls">
        <button id="recenter" className="round-button" type="button" aria-label="Recenter on my location" title="My location">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>
        </button>
        <button id="orientation" className="round-button" type="button" aria-label="Point map in travel direction" title="Follow heading">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 6 16-6-3-6 3 6-16Z"/></svg>
        </button>
      </div>

      <section id="route-setup" className="bottom-sheet hidden" aria-label="Route choices">
        <div className="grabber" aria-hidden="true" />
        <div className="destination-row">
          <div><span id="route-kicker">Route options</span><b id="destination-name">Selected location</b><small id="destination-address" /></div>
          <button id="close-route" className="icon-button" type="button" aria-label="Close route"><svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg></button>
        </div>
        <div className="mode-tabs" role="tablist" aria-label="Travel mode">
          <button className="mode-tab" data-mode="drive" role="tab" aria-selected="false" type="button"><span>↗</span>Drive</button>
          <button className="mode-tab" data-mode="taxi" role="tab" aria-selected="false" type="button"><span>▰</span>Taxi</button>
          <button className="mode-tab" data-mode="walk" role="tab" aria-selected="false" type="button"><span>●</span>Walk</button>
          <button className="mode-tab active" data-mode="transit" role="tab" aria-selected="true" type="button"><span>▣</span>Transit</button>
          <button className="mode-tab" data-mode="flight" role="tab" aria-selected="false" type="button"><span>✈</span>Flight</button>
        </div>
        <div id="route-status" className="route-status" aria-live="polite">Waiting for your location…</div>
        <button id="start-navigation" className="primary-button" type="button" disabled>Start trip</button>
        <div id="route-options" className="route-options" />
        <div id="leg-list" className="leg-list" aria-label="Journey steps" />
        <p id="route-source" className="route-source" />
      </section>

      <section id="navigation-panel" className="navigation-panel hidden" aria-label="Route guidance">
        <div className="instruction-card">
          <div id="maneuver-icon" className="maneuver-icon" aria-hidden="true">↑</div>
          <div className="instruction-copy"><span id="step-distance">Starting route</span><b id="step-instruction">Continue to the route</b></div>
          <button id="end-navigation" className="end-button" type="button">End guidance</button>
        </div>
        <div className="progress-card">
          <div className="journey-head">
            <div><span>Remaining</span><b id="remaining-distance">—</b></div>
            <div><span>Arrival</span><b id="arrival-time">—</b></div>
            <div><span>GPS</span><b id="gps-accuracy">—</b></div>
          </div>
          <div className="overall-progress" aria-label="Overall journey progress"><i id="overall-progress-fill" /></div>
          <div className="street-labels"><span id="current-street">Current position</span><span id="progress-percent">0%</span><span id="route-destination">Destination</span></div>
          <div id="active-leg-summary" className="active-leg-summary" />
          <div className="leg-controls"><button id="previous-leg" type="button">Previous step</button><button id="next-leg" type="button">Next step</button></div>
        </div>
      </section>

      <div id="toast" className="toast hidden" role="status" />
      <RideCheckoutDialog />
      <TripReceiptDialog />
    </main>
  );
}
