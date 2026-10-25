"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SmileWord } from "@/components/landing/Smile";
import { HACKER_TABLES, ITEMS, search, type Item } from "./items";
import { BLOCKED, FLOOR, ROOMS, STAGE, VIEWS, type Pt, type View } from "./palace";
import type { Hold, VenueScene } from "./scene";
import { route, standFor, walkLength } from "./walk";

const sponsors = ITEMS.filter((i) => i.kind === "sponsor").sort((a, b) => (a.number ?? 999) - (b.number ?? 999) || a.at[0] - b.at[0]);
const places = ITEMS.filter((i) => i.kind === "place").sort((a, b) => a.name.localeCompare(b.name));
const outline = (poly: Pt[]) => `M${poly.map((p) => p.join(" ")).join("L")}Z`;
/** An unhurried walk, m/s, for "about N min". */
const STROLL = 1.2;

const PAD: { hold: Hold; label: string; glyph: string }[] = [
  { hold: "forward", label: "Walk forward", glyph: "↑" },
  { hold: "left", label: "Turn left", glyph: "↺" },
  { hold: "back", label: "Step back", glyph: "↓" },
  { hold: "right", label: "Turn right", glyph: "↻" },
];

export function VenueClient() {
  const host = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const you = useRef<SVGGElement>(null);
  const scene = useRef<VenueScene | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Item | null>(null);
  const [away, setAway] = useState<number | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  const [trail, setTrail] = useState<Pt[] | null>(null);
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const results = useMemo(() => search(query), [query]);

  useEffect(() => {
    let disposed = false;
    let s: VenueScene | undefined;
    import("./scene")
      .then(({ VenueScene }) => {
        if (disposed || !host.current || !layer.current) return;
        s = new VenueScene(host.current, layer.current, {
          onPick: (item) => setPicked(item),
          onMove: ([x, y], yaw) => you.current?.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${((-yaw * 180) / Math.PI).toFixed(1)})`),
          onRoute: setTrail,
          onArrive: (item) => setArrived(item.id),
        });
        scene.current = s;
        setReady(true);
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      s?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    const s = scene.current;
    s?.select(picked);
    setArrived(null);
    setAway(picked && s ? walkLength(route(s.position(), standFor(picked))) : null);
  }, [picked]);

  const pick = (item: Item) => {
    setPicked(item);
    setQuery("");
    setBrowsing(false);
  };
  const goTo = (v: View) => {
    setPicked(null);
    setQuery("");
    setBrowsing(false);
    scene.current?.goTo(v);
  };
  const fullScreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen?.();
  };
  const onMap = (e: React.MouseEvent<SVGSVGElement>) => {
    const ctm = e.currentTarget.getScreenCTM();
    if (!ctm || !scene.current) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    scene.current.walkToPoint([p.x, p.y]);
  };
  const press = (h: Hold, on: boolean) => scene.current?.hold(h, on);
  // Keyboard users get a short step or turn per press of a pad button.
  const nudge = (h: Hold) => {
    press(h, true);
    setTimeout(() => press(h, false), 350);
  };

  return (
    <div className="vn">
      <header className="vn-top">
        <a href="/" className="brand" aria-label="S’mile home">
          <SmileWord />
        </a>
        <div className="vn-title">
          <b>Cal Hacks 13.0 venue</b>
          <span>Inside the Palace of Fine Arts · main floor</span>
        </div>
        <div className="vn-tools">
          <button className="vn-btn" onClick={() => goTo(VIEWS[0]!)} disabled={!ready}>
            Back to the entrance
          </button>
          <button className="vn-btn" onClick={fullScreen}>
            Full screen
          </button>
        </div>
      </header>

      <div className="vn-stage" ref={stage}>
        <div className="vn-canvas" ref={host}>
          <div className="vn-labels" ref={layer} />
        </div>

        <section className="vn-where" aria-label="Where to?">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Where to? A sponsor, place or spot" aria-label="Search the venue" />
          <button className="vn-browse" onClick={() => setBrowsing((b) => !b)} aria-expanded={browsing}>
            {browsing ? "Close" : "Browse"}
          </button>
          {results.length > 0 && (
            <ul className="vn-results" role="listbox">
              {results.map((r, i) =>
                r.kind === "note" ? (
                  <li key={i} className="note">
                    {r.text}
                  </li>
                ) : r.kind === "view" ? (
                  <li key={i}>
                    <button onClick={() => goTo(r.view)}>
                      <b>{r.view.name}</b>
                      <span>walk to this spot</span>
                    </button>
                  </li>
                ) : (
                  <li key={i}>
                    <button onClick={() => pick(r.item)}>
                      <b>
                        {r.item.number ? `${r.item.number} · ` : ""}
                        {r.item.name}
                      </b>
                      <span>{r.item.kind === "zone" ? "area" : r.item.sub}</span>
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
          {browsing && !results.length && (
            <div className="vn-lists">
              <h4>Spots</h4>
              <div className="vn-spots">
                {VIEWS.map((v) => (
                  <button key={v.name} onClick={() => goTo(v)}>
                    {v.name}
                  </button>
                ))}
              </div>
              <h4>Places</h4>
              <ul className="vn-grid">
                {places.map((p) => (
                  <li key={p.id}>
                    <button onClick={() => pick(p)}>{p.name}</button>
                  </li>
                ))}
              </ul>
              <h4>Sponsors</h4>
              <ul className="vn-grid">
                {sponsors.map((s) => (
                  <li key={s.id}>
                    <button onClick={() => pick(s)}>
                      {s.number ? <i>{s.number}</i> : null}
                      {s.number ? s.name : `Sponsor table · ${s.sub?.replace(/^near /, "")}`}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="vn-note">
                {HACKER_TABLES} of the 304 hacker tables are on the main floor. Hacker table numbers aren’t on the floor plan yet. The mezzanine upstairs (Mezzanine #2–#4, rooms M5–M8 and 41 more tables) isn’t mapped yet.
              </p>
            </div>
          )}
        </section>

        <svg className="vn-map" viewBox="0 0 2000 1000" onClick={onMap} role="img" aria-label="Map of the main floor. You’re the arrow; tap anywhere to walk there.">
          <path d={outline(FLOOR)} className="floor" />
          {[...BLOCKED.map((b) => b.poly), ...ROOMS.map((r) => r.poly), STAGE.poly].map((p, i) => (
            <path key={i} d={outline(p)} className="solid" />
          ))}
          {trail && <polyline points={trail.map((p) => p.join(",")).join(" ")} className="trail" />}
          {picked && <circle cx={picked.at[0]} cy={picked.at[1]} r={36} className="goal" />}
          <g ref={you} transform={`translate(${VIEWS[0]!.at.join(" ")})`}>
            <path d="M0 -70 L46 46 L0 24 L-46 46 Z" className="you" />
          </g>
        </svg>

        {picked && (
          <div className="vn-card" role="status">
            <button className="close" onClick={() => setPicked(null)} aria-label="Close">
              ×
            </button>
            <span className="kind">{picked.kind === "sponsor" ? "Sponsor booth" : picked.kind === "zone" ? "Area" : "Place"}</span>
            <b>
              {picked.number ? `${picked.number} · ` : ""}
              {picked.name}
            </b>
            {picked.sub && <span>{picked.sub}</span>}
            {picked.kind === "sponsor" && !picked.number && <small>Sponsor not confirmed for this booth yet.</small>}
            {arrived === picked.id ? (
              <p className="here">You’re here.</p>
            ) : (
              ready && (
                <>
                  {away !== null && (
                    <small>
                      {Math.round(away)} m walk · about {Math.max(1, Math.round(away / STROLL / 60))} min
                    </small>
                  )}
                  <button className="go" onClick={() => scene.current?.walkTo(picked)}>
                    Walk me there
                  </button>
                </>
              )
            )}
          </div>
        )}

        {ready && (
          <div className="vn-pad" role="group" aria-label="Move">
            {PAD.map((b) => (
              <button
                key={b.hold}
                className={b.hold}
                aria-label={b.label}
                onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), press(b.hold, true))}
                onPointerUp={() => press(b.hold, false)}
                onPointerCancel={() => press(b.hold, false)}
                onClick={(e) => e.detail === 0 && nudge(b.hold)}
              >
                {b.glyph}
              </button>
            ))}
          </div>
        )}

        {!ready && <div className="vn-loading">{failed ? "This device can’t show the 3D view (WebGL is unavailable)." : "Opening the doors…"}</div>}
      </div>

      <p className="vn-help">Drag to look around. Walk with W A S D or the arrow keys (Shift to hurry), tap the floor or the map to walk there, or pick a destination and S’mile walks you over.</p>
      <p className="vn-source">
        Built from the Cal Hacks 13.0 floor plan: tables and pins are placed exactly as on the plan; walls and rooms are traced, so allow a few feet. The building’s height, roof and windows are drawn for a sense of the space, not measured. Sponsor names are shown where they could be matched to a booth.
      </p>
    </div>
  );
}
