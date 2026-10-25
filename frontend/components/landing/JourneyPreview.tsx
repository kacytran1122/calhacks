const route = [
  { mode: "Walk", place: "Home to Davis station", time: "14 min" },
  { mode: "Train", place: "Capitol Corridor to Richmond", time: "1 hr 12 min" },
  { mode: "BART", place: "Richmond to Embarcadero", time: "36 min" },
  { mode: "Walk", place: "Embarcadero to venue", time: "12 min" },
];

export function JourneyPreview() {
  return (
    <section className="journey-preview" id="journey" aria-labelledby="journey-title">
      <div className="wrap journey-preview-grid">
        <div className="journey-copy reveal">
          <div className="kick">One continuous trip</div>
          <h2 id="journey-title" className="disp">From “I want to go” to <em>“I made it.”</em></h2>
          <p className="lede">S’mile keeps the event, route, handoffs, live progress and trip evidence together. Each screen picks up where the last one ended.</p>
          <ol className="journey-checks">
            <li><b>Find the right event</b><span>Start with your location, travel range and budget.</span></li>
            <li><b>Compare complete routes</b><span>See the fastest trip first, then practical alternatives.</span></li>
            <li><b>Travel with context</b><span>Open the map from your private @smile conversation and follow every leg.</span></li>
            <li><b>Finish cleanly</b><span>Receipts and approvals arrive at the finance desk with the trip record.</span></li>
          </ol>
        </div>
        <div className="trip-board reveal" aria-label="Example multimodal trip plan">
          <header className="trip-board-head">
            <div><small>CAL HACKS 13.0</small><strong>Davis to San Francisco</strong></div>
            <span>Arrives 8:41 AM</span>
          </header>
          <div className="trip-board-summary">
            <div><small>Fastest route</small><strong>2 hr 14 min</strong></div>
            <div><small>Current fare</small><strong>$24</strong></div>
            <div><small>Venue</small><strong>68°F</strong></div>
          </div>
          <div className="trip-board-route">
            {route.map((step, index) => (
              <div className="trip-leg" key={step.place}>
                <span className="trip-node" aria-hidden="true">{index + 1}</span>
                <div><small>{step.mode}</small><b>{step.place}</b></div>
                <time>{step.time}</time>
              </div>
            ))}
          </div>
          <footer className="trip-board-foot">
            <span><i /> Route checked</span>
            <span>Alternative routes included</span>
          </footer>
        </div>
      </div>
    </section>
  );
}
