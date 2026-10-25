"use client";

import { useState, type ReactNode } from "react";
import { EventThumb } from "./EventThumb";
import { Smile } from "./Smile";

const Row = ({ l, r, num }: { l: string; r: ReactNode; num?: boolean }) => (
  <div className="prow">
    <span>{l}</span>
    {num ? <b className="num">{r}</b> : <span style={{ color: "var(--color-accent-700)" }}>{r}</span>}
  </div>
);

const STEPS: { title: string; body: ReactNode; panel: ReactNode; image?: string; imageAlt?: string }[] = [
  { title: "Event detected", body: <>Open the event page. <Smile /> Lens finds the name, venue and kickoff time.</>, panel: <EventThumb />, image: "/how/1-find.webp", imageAlt: "Event results with buttons to plan a trip" },
  {
    title: "Origin entered",
    body: "Start with a ZIP or a U.S. city and state. No account, no profile form.",
    panel: (
      <>
        <div style={{ font: "700 42px/1 var(--font-heading)" }}>Davis, CA</div>
        <div style={{ fontSize: 14, color: "var(--mut)", marginTop: 8 }}>95616 · 72 miles to venue</div>
      </>
    ),
  },
  {
    title: "Evidence collected",
    body: "Schedules, live delays, weather and the event page, each stamped with its source and freshness.",
    panel: (
      <>
        <Row l="Capitol Corridor GTFS" r="fresh · 40s" />
        <Row l="Weather, SF" r="fresh · 6m" />
        <Row l="Event page" r="verified" />
      </>
    ),
  },
  {
    title: "Routes compared",
    body: "Train, rideshare and bus, scored on fare, time and the chance you miss kickoff.",
    image: "/how/3-compare.webp",
    imageAlt: "Complete route choices compared on the trip results screen",
    panel: (
      <>
        <Row l="Train + BART" r="$24 · 12%" num />
        <Row l="Shared ride" r="$19 · 22%" num />
        <Row l="Bus + Muni" r="$14 · 18%" num />
      </>
    ),
  },
  {
    title: "Stops discovered",
    body: "Worthwhile detours under ten minutes: breakfast, a view, a charger.",
    panel: (
      <>
        <div style={{ font: "600 24px var(--font-heading)" }}>Jack London coffee</div>
        <div style={{ fontSize: 14, color: "var(--mut)" }}>+9 min · 4.7 · on your transfer</div>
      </>
    ),
  },
  {
    title: "Buddies matched",
    body: "Travelers on your route, matched without exposing profiles.",
    panel: (
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ display: "flex", paddingLeft: 8 }}>
          <span className="av">A</span>
          <span className="av">J</span>
          <span className="av">R</span>
        </div>
        <span style={{ fontSize: 15 }}>3 on your 6:58 am train</span>
      </div>
    ),
  },
  {
    title: "Traveler approves",
    body: "Nothing is booked or paid until you say yes to the exact quote you saw.",
    panel: (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ font: "600 22px var(--font-heading)" }}>Approve $24 trip</span>
        <span className="chip" style={{ borderColor: "var(--gold)", color: "var(--color-accent-700)" }}>Awaiting you</span>
      </div>
    ),
  },
  {
    title: "Finance handoff",
    body: "The same trip, quote and policy record move to the organizer desk. Receipts, check-in and settlement are reconciled before reimbursement.",
    image: "/how/8-paid.webp",
    imageAlt: "Trip finance status showing the traveler budget and organizer policy",
    panel: (
      <>
        <Row l="Traveler-approved quote" r="$24.00" num />
        <Row l="Organizer policy R1" r="eligible" />
        <Row l="Finance evidence" r="awaiting receipt" />
      </>
    ),
  },
];

export function HowItWorks() {
  const [cur, setCur] = useState(0);
  const s = STEPS[cur]!;

  return (
    <section id="how">
      <div className="wrap">
        <div className="reveal">
          <div className="kick">How it works</div>
          <h2 className="disp" style={{ fontSize: "clamp(48px,6.5vw,96px)", marginTop: 18 }}>
            You choose the event.
            <br />
            We’ll help you <em>get there.</em>
          </h2>
        </div>
        <div className="how-experience reveal">
          <div className="how-steps" role="tablist" aria-label="Trip journey steps">
            {STEPS.map((st, i) => (
              <button key={st.title} role="tab" aria-selected={i === cur} className={`how-step${i === cur ? " active" : ""}`} onClick={() => setCur(i)}>
                <span className={`how-thumb how-thumb-${i + 1}${st.image ? " has-image" : ""}`} style={st.image ? { backgroundImage: `url(${st.image})` } : undefined} aria-hidden="true"><i>{String(i + 1).padStart(2, "0")}</i></span>
                <span><small>Step {String(i + 1).padStart(2, "0")}</small><b>{st.title}</b></span>
              </button>
            ))}
          </div>
          <div className="how-feature" role="tabpanel" aria-live="polite">
            <div className={`how-picture how-picture-${cur + 1}${s.image ? " has-image" : ""}`}>
              {s.image ? <img className="how-screen-capture" src={s.image} alt={s.imageAlt ?? ""} /> : (
                <div className="how-word-frame" aria-hidden="true">
                  <small>Journey step</small>
                  <strong>{String(cur + 1).padStart(2, "0")}</strong>
                  <span>{s.title}</span>
                </div>
              )}
              <div className="how-photo-caption"><small>Trip stage</small><b>{s.title}</b></div>
            </div>
            <div className="how-feature-copy">
              <div className="kick num">Step {String(cur + 1).padStart(2, "0")} of {String(STEPS.length).padStart(2, "0")}</div>
              <h3>{s.title}</h3>
              <p className="lede">{s.body}</p>
              <div className="how-data-card">{s.panel}</div>
              <div className="how-progress" aria-label={`Step ${cur + 1} of ${STEPS.length}`}><i style={{ width: `${((cur + 1) / STEPS.length) * 100}%` }} /></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
