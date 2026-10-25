"use client";

import { useState } from "react";
import { Smile } from "./Smile";

type Artwork = "cal" | "sbu" | "ox" | "hacktx";
type PreviewEvent = { name: string; city: string; date: string; url: string; art: Artwork };

const EVENTS: PreviewEvent[] = [
  { name: "Cal Hacks 13.0", city: "San Francisco, CA", date: "OCT 23–25", url: "calhacks.io", art: "cal" },
  { name: "SBUHacks", city: "Stony Brook, NY", date: "OCT 23–25", url: "Official SBUHacks event page", art: "sbu" },
  { name: "OxHack ’26", city: "Oxford, England", date: "OCT 24–25", url: "Official OxHack event page", art: "ox" },
  { name: "HackTX 26", city: "Austin, TX", date: "OCT 24–25", url: "hacktx.com", art: "hacktx" },
];

function EventArtwork({ kind }: { kind: Artwork }) {
  if (kind === "hacktx") return (
    <svg viewBox="0 0 220 150" fill="none" aria-hidden="true">
      <rect width="220" height="150" fill="#f7f7ee" />
      <path d="M56 121C35 103 43 60 71 53C92 47 101 62 88 71M163 32C188 48 177 79 156 74C142 71 146 56 158 62M63 122C98 133 148 127 163 110" stroke="#635d32" strokeWidth="3" strokeLinecap="round" />
      <path d="M61 58C43 44 44 37 40 31C58 31 70 38 61 58M163 73C187 72 190 84 192 93C173 93 158 89 163 73M83 124C75 105 64 108 58 112C62 128 73 132 83 124M154 35C149 16 161 12 169 12C171 25 168 34 154 35" fill="#8a9b74" />
      <text x="110" y="122" textAnchor="middle" fill="#514b2c" fontFamily="Georgia,serif" fontSize="130" fontWeight="bold">H</text>
    </svg>
  );
  if (kind === "ox") return (
    <svg viewBox="0 0 220 150" fill="none" aria-hidden="true">
      <rect width="220" height="150" fill="#180b52" />
      <path d="M55 21L187 89L39 132L55 21Z" fill="#2b5d42" stroke="#9be733" strokeWidth="3" />
      <path d="M58 35L166 90L49 121M63 31L52 118M80 44L68 114M99 55L86 109M119 65L107 102M140 77L130 99M55 49L165 94M53 71L133 108M49 94L93 119" stroke="#8bd83f" opacity=".35" />
      <text x="110" y="82" textAnchor="middle" fill="#b7ffb7" fontFamily="monospace" fontSize="28" fontWeight="bold">OXHACK</text>
      <text x="173" y="45" fill="#d7fc9f" fontFamily="monospace" fontSize="20">26</text>
    </svg>
  );
  if (kind === "sbu") return (
    <svg viewBox="0 0 220 150" fill="none" aria-hidden="true">
      <rect width="220" height="150" fill="#3b61ff" />
      <circle cx="110" cy="77" r="61" fill="#eeeeeb" stroke="#fff" strokeWidth="3" />
      <path d="M53 53H167M50 68H170M50 83H170M56 98H164M69 28V125M87 19V135M105 15V139M123 17V137M141 25V128" stroke="#c2c5cc" strokeWidth="1" />
      <path d="M77 53H135L143 101H70L77 53Z" fill="#c0c9cc" stroke="#283a46" strokeWidth="3" />
      <path d="M84 60H128L132 87H79L84 60Z" fill="#bcf1fa" stroke="#283a46" strokeWidth="2" />
      <path d="M71 103H145L155 111H61L71 103Z" fill="#7f8f98" stroke="#283a46" strokeWidth="3" strokeLinejoin="round" />
      <text x="105" y="79" textAnchor="middle" fill="#29415b" fontFamily="monospace" fontWeight="bold" fontSize="14">SBU</text>
      <path d="M169 18V36M160 27H178M37 108V124M29 116H45" stroke="#b5f6d4" strokeWidth="3" />
    </svg>
  );
  return (
    <svg viewBox="0 0 220 150" fill="none" aria-hidden="true">
      <rect width="220" height="150" fill="#191b3d" />
      <g strokeLinecap="round" opacity=".8">
        {Array.from({ length: 12 }, (_, i) => <path key={i} d={`M64 47L${(64 + Math.cos(i * Math.PI / 6) * 32).toFixed(3)} ${(47 + Math.sin(i * Math.PI / 6) * 32).toFixed(3)}`} stroke={i % 2 ? "#e2b29b" : "#91c6be"} strokeWidth="1.5" />)}
        {Array.from({ length: 10 }, (_, i) => <path key={i} d={`M166 58L${(166 + Math.cos(i * Math.PI / 5) * 25).toFixed(3)} ${(58 + Math.sin(i * Math.PI / 5) * 25).toFixed(3)}`} stroke="#ccb281" strokeWidth="1.5" />)}
      </g>
      <circle cx="27" cy="24" r="2" fill="#f2d590" /><circle cx="196" cy="115" r="2" fill="#f2d590" /><circle cx="142" cy="17" r="1.5" fill="#f2d590" />
      <text x="110" y="86" textAnchor="middle" fill="#fff8e9" fontFamily="Georgia,serif" fontSize="27" fontStyle="italic">Cal</text>
      <text x="110" y="111" textAnchor="middle" fill="#fff8e9" fontFamily="monospace" fontSize="27" fontWeight="bold">HACKS</text>
      <text x="110" y="132" textAnchor="middle" fill="#ddd4c1" fontFamily="monospace" fontSize="18">13.0</text>
    </svg>
  );
}

function ForestDrawing() {
  return (
    <svg className="lens-forest" viewBox="0 0 1000 640" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="1000" height="640" fill="#bedee4" />
      <g fill="#eaf5f6" stroke="#d3e8e9" strokeWidth="2">
        <path d="M88 101C69 80 85 53 110 57C110 20 162 13 175 45C199 33 232 52 229 78C262 77 272 109 249 122H94Z" />
        <path d="M421 112C397 89 415 57 444 60C454 20 505 18 523 50C554 39 582 65 573 93C603 91 615 119 597 136H426Z" />
        <path d="M700 77C685 57 702 32 725 37C735 5 777 7 788 32C818 23 845 47 832 72C861 75 862 98 848 105H704Z" />
      </g>
      <g fill="#f5fbfb">
        <path d="M215 172C198 154 205 126 231 126C238 94 281 91 296 115C323 102 349 122 348 143C373 145 377 166 363 179H218Z" />
        <path d="M605 211C586 192 602 166 622 169C632 132 674 134 689 158C714 149 737 169 733 192C760 194 762 215 747 224H608Z" />
      </g>
      <path d="M0 588C180 523 269 596 422 551C567 508 710 527 1000 568V640H0Z" fill="#9fbc92" />
      <path d="M0 637C168 554 291 623 404 592C588 545 798 603 1000 589V640H0Z" fill="#7b9d7c" />
      <path d="M162 640L186 291L228 279L210 640Z" fill="#746b43" />
      <path d="M200 455L85 327L106 302L205 400M211 389L343 241L366 265L211 452" fill="#746b43" />
      <path d="M30 258C-23 199 18 126 87 137C123 75 214 87 234 145C310 105 388 155 374 215C441 248 407 326 342 331C342 396 263 418 222 374C156 413 87 378 90 329C31 348-9 302 30 258Z" fill="#a3a781" />
      <path d="M18 357C-22 313 10 263 56 273C80 223 158 236 169 282C220 258 263 295 253 339C294 357 285 412 238 416C240 461 178 485 145 449C89 469 43 444 45 405C9 413-14 385 18 357Z" fill="#939465" />
      <path d="M239 365C216 322 251 290 291 302C311 256 372 262 389 302C433 289 473 324 462 363C501 384 482 434 441 434C435 478 378 494 350 460C307 489 259 457 262 423C223 421 213 388 239 365Z" fill="#6f9278" />
      <path d="M63 436C23 399-10 428-4 466C-31 500 4 540 39 531C56 567 109 571 132 540C165 559 204 539 204 506C241 477 213 430 176 438C149 405 91 407 63 436Z" fill="#5b6441" />
      <path d="M86 0L53 49M208 0L247 49" stroke="#5a5136" strokeWidth="3" />
      <path d="M25 46L262 43L266 113L20 117Z" fill="#bd8b54" />
      <path d="M27 59L255 57M25 101L254 99M25 78L39 79M245 83L263 83" stroke="#927044" strokeWidth="2" />
      <text x="142" y="88" textAnchor="middle" fill="#453e29" fontFamily="Georgia,serif" fontWeight="bold" fontSize="21">Hello, fellow wanderer…</text>
      <text x="664" y="397" textAnchor="middle" fill="#4a4328" fontFamily="Georgia,serif" fontWeight="bold" fontSize="133">HackTX</text>
      <path d="M445 422C561 453 737 451 849 421" fill="none" stroke="#4a4328" strokeWidth="4" />
      <text x="652" y="479" textAnchor="middle" fill="#4a4328" fontFamily="Georgia,serif" fontWeight="bold" fontSize="31">10.24 — 10.25</text>
      <path d="M112 456L123 542M187 452L184 536" stroke="#a34e65" strokeWidth="3" />
      <path d="M103 534L200 527L207 620L101 627Z" fill="#efd875" transform="rotate(-7 154 577)" />
      <text x="151" y="563" textAnchor="middle" fill="#50462c" fontFamily="Georgia,serif" fontSize="15">Apply by</text>
      <text x="151" y="590" textAnchor="middle" fill="#50462c" fontFamily="Georgia,serif" fontWeight="bold" fontSize="25">Sept 15</text>
    </svg>
  );
}

export function LensDemo() {
  const [view, setView] = useState<"schedule" | "event">("schedule");
  const [selected, setSelected] = useState(EVENTS[3]!);
  const [includeDrive, setIncludeDrive] = useState(true);
  const selectEvent = (event: PreviewEvent) => { setSelected(event); setView("event"); };

  return (
    <section className="ext lens-section" id="lens">
      <div className="wrap">
        <div className="lens-intro reveal">
          <div>
            <div className="kick">Chrome extension</div>
            <h2 className="disp">Found your event?<br /><em>Let’s get you there.</em></h2>
          </div>
          <a className="lens-install" href="https://chromewebstore.google.com/" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" /><path d="M12 8h9.16M8.54 14 3.96 6.07M15.46 14l-4.58 7.94" /></svg>
            Get the extension
          </a>
        </div>
        <figure className="lens-preview reveal">
          <figcaption className="lens-preview-toolbar">
            <span><span className="lens-preview-dot" /> Illustrated extension preview</span>
            <div className="lens-preview-tabs" role="tablist" aria-label="Extension preview">
              <button id="lens-schedule-tab" role="tab" aria-selected={view === "schedule"} aria-controls="lens-schedule-panel" onClick={() => setView("schedule")}>MLH event list</button>
              <button id="lens-event-tab" role="tab" aria-selected={view === "event"} aria-controls="lens-event-panel" onClick={() => setView("event")}>Trip planner</button>
            </div>
          </figcaption>
          <div className="lens-browser">
            <div className="lens-browser-bar" aria-hidden="true">
              <span className="lens-browser-dots"><i /><i /><i /></span>
              <span className="lens-browser-url">{view === "schedule" ? "mlh.com/seasons/2027/events" : selected.url}</span>
              <span className="lens-browser-smile">☺</span>
            </div>
            {view === "schedule" ? (
              <div id="lens-schedule-panel" role="tabpanel" aria-labelledby="lens-schedule-tab" className="lens-schedule">
                <div className="lens-schedule-head">
                  <span className="lens-mlh-mark">MLH<span>MAJOR LEAGUE HACKING</span></span>
                  <div><span>2027 SEASON</span><h3>Your next great weekend.</h3></div>
                </div>
                <div className="lens-event-grid">
                  {EVENTS.map((event) => (
                    <article className={`lens-event-card lens-art-${event.art}`} key={event.name}>
                      <div className="lens-card-cover">
                        <EventArtwork kind={event.art} />
                        <button className="lens-plan-pill" aria-label={`Preview trip planner for ${event.name}`} onClick={() => selectEvent(event)}>Plan trip with S’mile</button>
                      </div>
                      <div className="lens-event-badge"><EventArtwork kind={event.art} /></div>
                      <div className="lens-card-copy">
                        <h4>{event.name}</h4>
                        <span className="lens-card-meta"><span aria-hidden="true">▣</span>{event.date}</span>
                        <span className="lens-card-meta"><span aria-hidden="true">⌾</span>{event.city}</span>
                        <span className="lens-in-person">IN PERSON</span>
                      </div>
                    </article>
                  ))}
                </div>
                <p className="lens-schedule-note">Choose a “Plan trip” button to explore the illustrated planner.</p>
              </div>
            ) : (
              <div id="lens-event-panel" role="tabpanel" aria-labelledby="lens-event-tab" className={`lens-event-scene lens-scene-${selected.art}`}>
                {selected.art === "hacktx" ? <ForestDrawing /> : <div className="lens-event-poster" aria-hidden="true"><EventArtwork kind={selected.art} /><span>{selected.name}</span></div>}
                <aside className="lens-planner" aria-label="Illustrated trip planner">
                  <header className="lens-planner-top">
                    <span className="lens-mini-brand"><Smile /></span>
                    <button className="lens-close" aria-label="Return to illustrated MLH event list" onClick={() => setView("schedule")}>×</button>
                    <h3>Let’s get you there.</h3>
                    <p>The fastest route first. Clear alternatives after it.</p>
                  </header>
                  <div className="lens-planner-body">
                    <div className="lens-selected-event">
                      <span className="lens-selected-art"><EventArtwork kind={selected.art} /></span>
                      <span><b>{selected.name}</b><small>{selected.city}</small></span>
                    </div>
                    <div className="lens-preview-label">EVENT DESTINATION</div>
                    <div className="lens-preview-field">{selected.city}</div>
                    <div className="lens-consent"><b>Use your location to build this route?</b><span>Choose current location, or enter where your trip starts.</span></div>
                    <div className="lens-location-button">Allow &amp; use my current location</div>
                    <div className="lens-divider">or enter a starting point</div>
                    <div className="lens-origin-example"><span>ZIP, city or address</span><b>Use this</b></div>
                    <div className="lens-preview-label">WILL YOU SELF-DRIVE?</div>
                    <div className="lens-drive-choices" role="group" aria-label="Self-drive preview">
                      <button aria-pressed={includeDrive} onClick={() => setIncludeDrive(true)}><b>Yes, include driving</b><small>Compare a road route too</small></button>
                      <button aria-pressed={!includeDrive} onClick={() => setIncludeDrive(false)}><b>No self-drive</b><small>Public transit only</small></button>
                    </div>
                    <a href="/" className="lens-real-plan">Plan your trip <span aria-hidden="true">→</span></a>
                  </div>
                </aside>
              </div>
            )}
          </div>
        </figure>
      </div>
    </section>
  );
}
