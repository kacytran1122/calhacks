import type { ReactNode } from "react";
import { Smile } from "./Smile";

const STEPS: { title: string; body: ReactNode }[] = [
  { title: "Event detected", body: <>Open the event page. <Smile /> Lens finds the name, venue and kickoff time.</> },
  { title: "Origin entered", body: "Start with a ZIP or a U.S. city and state. No account or profile form." },
  { title: "Evidence collected", body: "Schedules, delays, weather and event details are checked with their sources and freshness." },
  { title: "Routes compared", body: "Train, rideshare and bus are compared by fare, time and the chance of missing kickoff." },
  { title: "Stops discovered", body: "Useful stops such as breakfast, a viewpoint or a charger are added without disrupting the trip." },
  { title: "Buddies matched", body: "Hackers and technologists on the same route can connect without exposing their profiles." },
  { title: "Traveler approves", body: "Nothing is booked or paid until the traveler approves the exact quote." },
  { title: "Finance handoff", body: "The approved trip, policy record and receipts move to the organizer desk for reimbursement." },
];

const PICTURES = [
  { src: "/how/1-find.webp", step: "01", title: "Find the event", alt: "Event results with buttons to plan a trip" },
  { src: "/how/3-compare.webp", step: "04", title: "Compare the route", alt: "Complete route choices on the trip results screen" },
  { src: "/how/8-paid.webp", step: "08", title: "Complete the handoff", alt: "Trip finance status showing the traveler budget and organizer policy" },
];

export function HowItWorks() {
  return (
    <section id="how">
      <div className="wrap">
        <div className="reveal">
          <div className="kick">How it works</div>
          <h2 className="disp how-title">
            You choose the event.
            <br />
            We’ll help you <em>get there.</em>
          </h2>
        </div>
        <div className="how-images reveal" aria-label="S’mile journey screenshots">
          {PICTURES.map((picture) => (
            <figure key={picture.src}>
              <img src={picture.src} alt={picture.alt} />
              <figcaption><small>Step {picture.step}</small><b>{picture.title}</b></figcaption>
            </figure>
          ))}
        </div>
        <ol className="how-word-steps reveal">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><h3>{step.title}</h3><p>{step.body}</p></div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
