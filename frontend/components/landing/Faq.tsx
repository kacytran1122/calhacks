"use client";

import { useState, type ReactNode } from "react";
import { Smile } from "./Smile";

const QA: { q: ReactNode; a: ReactNode }[] = [
  { q: "Do I need a new app?", a: <>No. <Smile /> lives in a Chrome extension and your group chat. Open an event page or type @smile. That’s it.</> },
  { q: "Where do the facts come from?", a: "Official transit, weather and location feeds, plus permitted public event pages. Every answer shows its source and how fresh it is." },
  { q: <>Can <Smile /> spend more than we agreed?</>, a: "Never. Trip funds stay locked until you approve the exact quote you saw. If the price changes, it asks again." },
  { q: "Who can see my profile?", a: "Only your trip group. Buddies are matched by route and schedule. Your details aren’t shared to make a match." },
  { q: "What if my train is late?", a: <><Smile /> watches live delays, reroutes when your transfer is at risk, and pings the whole group with a new plan.</> },
];

export function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" className="faq">
      <div className="wrap" style={{ maxWidth: 980 }}>
        <h2 className="disp reveal" style={{ fontSize: "clamp(48px,6.5vw,96px)", textAlign: "center" }}>
          Frequently Asked <em>Questions</em>
        </h2>
        <div className="faq-list reveal">
          {QA.map((x, i) => (
            <div key={i} className={`qa${open === i ? " open" : ""}`}>
              <button className="qa-q" aria-expanded={open === i} onClick={() => setOpen(open === i ? -1 : i)}>
                <span>{x.q}</span>
                <i aria-hidden="true" />
              </button>
              <div className="qa-a">
                <div>
                  <p>{x.a}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
