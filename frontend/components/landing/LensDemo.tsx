"use client";

import { useState } from "react";
import { EventThumb } from "./EventThumb";
import { Smile } from "./Smile";

export function LensDemo() {
  const [phase, setPhase] = useState<"idle" | "busy" | "ready">("idle");

  const run = () => {
    if (phase === "ready") {
      location.hash = "how";
      return;
    }
    setPhase("busy");
    setTimeout(() => setPhase("ready"), 900);
  };

  return (
    <section className="ext" id="lens">
      <div className="wrap ext-grid">
        <div className="reveal">
          <div className="kick">Chrome extension</div>
          <h2 className="disp" style={{ fontSize: "clamp(48px,6vw,88px)", marginTop: 18 }}>
            The event page <em>is</em> the itinerary.
          </h2>
          <p className="lede" style={{ marginTop: 22 }}>
            <Smile /> Lens spots the date, venue and kickoff on the page you&apos;re already reading. It never touches accounts, cookies or payment fields.
          </p>
        </div>
        <div className="browser reveal">
          <div className="bar">
            <i />
            <i />
            <i />
            <div className="url">goldengatehack.dev</div>
            <div className="ext-ico">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M7.5 14c1.2 1.8 2.7 2.7 4.5 2.7s3.3-.9 4.5-2.7" />
              </svg>
            </div>
          </div>
          <div className="evpage">
            <EventThumb />
            <p style={{ margin: "14px 0 22px", fontSize: 15 }}>
              36 hours of building at <span className="hl">Fort Mason Center, San Francisco</span> · <span className="hl">Nov 14, 9:00 am</span>
            </p>
            <div className="blk" style={{ width: "92%" }} />
            <div className="blk" style={{ width: "78%" }} />
            <div className="blk" style={{ width: "85%" }} />
            <div className="blk" style={{ width: "40%" }} />
          </div>
          <div className="popup">
            <div className="kick" style={{ fontSize: 10 }}>
              <Smile /> Lens
            </div>
            <div style={{ font: "600 24px/1.1 var(--font-heading)", margin: "10px 0 4px" }}>Plan this page</div>
            <div style={{ fontSize: 13, color: "var(--mut)" }}>
              {phase === "ready" ? (
                <>
                  <span style={{ color: "var(--color-accent-700)" }}>Ready.</span> Best match for kickoff:
                </>
              ) : (
                "Event, venue and start time detected."
              )}
            </div>
            {phase === "ready" && (
              <div style={{ marginTop: 8 }}>
                <div className="prow">
                  <span>Train + BART</span>
                  <b className="num">$24</b>
                </div>
                <div className="prow">
                  <span>Arrive</span>
                  <b className="num">8:41 am</b>
                </div>
                <div className="prow">
                  <span>Buddies</span>
                  <b>3 aboard</b>
                </div>
              </div>
            )}
            <button className="pbtn" onClick={run} disabled={phase === "busy"}>
              {phase === "idle" && "Plan from 95616"}
              {phase === "busy" && "Comparing routes…"}
              {phase === "ready" && (
                <>
                  Open in <Smile />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
