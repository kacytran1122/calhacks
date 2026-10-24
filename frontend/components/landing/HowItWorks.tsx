"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { EventThumb } from "./EventThumb";
import { Smile } from "./Smile";

const Row = ({ l, r, num }: { l: string; r: ReactNode; num?: boolean }) => (
  <div className="prow">
    <span>{l}</span>
    {num ? <b className="num">{r}</b> : <span style={{ color: "var(--color-accent-700)" }}>{r}</span>}
  </div>
);

const STEPS: { title: string; body: ReactNode; panel: ReactNode }[] = [
  { title: "Event detected", body: <>Open the event page. <Smile /> Lens finds the name, venue and kickoff time.</>, panel: <EventThumb /> },
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
  const auto = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    auto.current = setInterval(() => setCur((c) => (c + 1) % STEPS.length), 3200);
    return () => {
      if (auto.current) clearInterval(auto.current);
    };
  }, []);

  const go = (i: number) => {
    if (auto.current) clearInterval(auto.current);
    setCur(i);
  };
  const s = STEPS[cur]!;

  return (
    <section id="how">
      <div className="wrap">
        <div className="reveal">
          <div className="kick">How it works</div>
          <h2 className="disp" style={{ fontSize: "clamp(48px,6.5vw,96px)", marginTop: 18 }}>
            Eight stops.
            <br />
            <em>One</em> yes.
          </h2>
        </div>
        <div className="line reveal">
          <div className="track">
            <div className="fill" style={{ width: `${(cur / (STEPS.length - 1)) * 94}%` }} />
            {STEPS.map((st, i) => (
              <button key={st.title} className={`stn${i <= cur ? " on" : ""}${i === cur ? " cur" : ""}`} onClick={() => go(i)}>
                <i className="num">{i + 1}</i>
                <span>{st.title}</span>
              </button>
            ))}
          </div>
          <div className="detail">
            <div>
              <div className="kick num">Stop 0{cur + 1}</div>
              <h3 style={{ marginTop: 14 }}>{s.title}</h3>
              <p className="lede">{s.body}</p>
            </div>
            <div className="panel">{s.panel}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
