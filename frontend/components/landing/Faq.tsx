"use client";

import { useState } from "react";

const QA = [
  { q: "How do I find an event and plan my trip?", a: "Start by entering a ZIP code, city, state, or address, then choose how far you would like to travel and how much you would like to spend. Select Update nearby events, choose an MLH or tech event, and tell us about any arrival deadlines or other travel needs. If we need a little more information, S’mile will ask a follow-up question before putting your plan together." },
  { q: "Do I have to share my current location?", a: "No, you are welcome to plan from a location you type in. If you would prefer to start from where you are now, choose the current-location option and your browser will ask for permission. You can decline that request and continue with the location you entered." },
  { q: "Can I plan a trip without driving?", a: "Yes, please leave self-drive turned off if you would like to see public transit options. You can turn it on whenever you would like to compare a driving route as well. The routes we can find will depend on your destination, travel date, and the transport schedules available to us." },
  { q: "Are the prices live or predicted?", a: "Live prices come from current travel listings for the route and date shown, while predictions use historical data to suggest a price range for planning. Flight prices are currently available for eligible trips between different U.S. states. If we cannot confirm a current fare, we will let you know, and you will still be able to tell which figures are estimates." },
  { q: "Will S’mile book travel or charge me automatically?", a: "No, planning a trip does not book a ticket or charge you. If an exact fare is available, the web app may ask you to review that amount as part of a payment demonstration, which does not make a real booking or charge. When you are ready to buy a ticket, please follow the travel provider’s link and confirm the final price there." },
  { q: "What does the Chrome extension do?", a: "When you are browsing the MLH season schedule, you can choose Plan trip with S’mile on an event card to plan your journey beside the page. You can also open S’mile from the Chrome toolbar while visiting a collegiate hackathon website. Once you confirm the destination, starting point, and whether you can drive, it shows the fastest available route with clear directions and alternatives. The extension is for route planning, so it does not display fares or take payments." },
  { q: "What if a schedule or fare changes?", a: "Please check the linked travel and event websites before you leave, and update your plan if your travel details change. For eligible saved trips, S’mile can check for large fare changes, hot weather near the venue, or changes to the event’s date or location. These checks do not cover every disruption, so please confirm the latest service information with your transport provider before travelling." },
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
