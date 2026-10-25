"use client";

import { useState } from "react";

const QA = [
  { q: "How do I find an event and plan my trip?", a: "Enter a ZIP code, city, state, or address, then choose your travel radius and budget. Update nearby events, select an MLH or tech event, and add any arrival deadlines or other travel needs. If a detail is unclear, S’mile asks a follow-up question before using it in your plan." },
  { q: "Do I have to share my current location?", a: "You can plan from the place you enter. If you choose current location, your browser asks for permission and S’mile uses the coordinates it returns as the starting point. You can decline location access and continue with a typed location." },
  { q: "Can I plan a trip without driving?", a: "Yes. Leave self-drive off to request public-transit options. Include self-drive if you also want to compare a road route. Available routes depend on the event’s location, the travel date, and the schedules covered by our route providers." },
  { q: "Are the prices live or predicted?", a: "A verified fare is a price found on a current public source for the route and date shown. A prediction is a planning estimate from historical data and is labelled separately, with a range rather than a guaranteed price. Flight pricing is currently available for eligible trips between different U.S. states. If a live fare cannot be verified, S’mile says so instead of presenting the forecast as a quote." },
  { q: "Will S’mile book travel or charge me automatically?", a: "Planning a route does not purchase a ticket. The web app can request your approval for an exact verified amount and pass the trip’s evidence to an organizer’s reimbursement workflow. Payment and booking demonstrations use a sandbox or simulation; a forecast is never a payment authorization. Use the linked travel provider to confirm availability and complete a real purchase." },
  { q: "What does the Chrome extension do?", a: "On the MLH season schedule, choose Plan trip with S’mile on an event card. On a collegiate hackathon website, open S’mile from the Chrome toolbar. Confirm the destination, choose your starting point and self-drive preference, then compare the fastest available route with alternatives and step-by-step directions. The extension shows routes without fares or checkout." },
  { q: "What if a schedule or fare changes?", a: "Check the source links before you leave and request a fresh plan when your travel details change. For eligible saved trips, scheduled checks can flag a significant fare change, venue heat, or a change to the event’s date or venue. Transit disruptions still need to be checked with the operator before you travel." },
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
            <div key={x.q} className={`qa${open === i ? " open" : ""}`}>
              <button id={`faq-question-${i}`} className="qa-q" aria-expanded={open === i} aria-controls={`faq-answer-${i}`} onClick={() => setOpen(open === i ? -1 : i)}>
                <span>{x.q}</span>
                <i aria-hidden="true" />
              </button>
              <div id={`faq-answer-${i}`} className="qa-a" role="region" aria-labelledby={`faq-question-${i}`} inert={open !== i}>
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
