"use client";

import { useState, type FormEvent } from "react";
import { PhoneChat } from "./PhoneChat";
import { Smile } from "./Smile";

type OriginMode = "zip" | "city";

export function HeroView({ onNavigate }: { onNavigate: (href: string) => void }) {
  const [mode, setMode] = useState<OriginMode>("zip");
  const [zip, setZip] = useState("");
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "hint" | "error"; text: string } | null>(null);

  const selectMode = (next: OriginMode) => {
    setMode(next);
    setMessage(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (mode === "zip") {
      const value = zip.trim();
      if (!/^\d{5}$/.test(value)) {
        setMessage({ kind: "error", text: "Enter a 5-digit ZIP code." });
        return;
      }
      onNavigate(`/find?zip=${value}`);
      return;
    }

    if (!city.includes(",")) {
      setMessage({ kind: "error", text: "Add the state, like Galesburg, IL." });
      return;
    }

    setBusy(true);
    setMessage({ kind: "hint", text: "Finding the best starting point…" });
    try {
      const response = await fetch(`/api/location/resolve?city=${encodeURIComponent(city.trim())}`);
      const result = (await response.json()) as { zip?: string; label?: string; error?: string };
      if (!response.ok || !result.zip) throw new Error(result.error ?? "We couldn’t find that city.");
      setMessage({ kind: "hint", text: `${result.label ?? city} found. Loading nearby events…` });
      onNavigate(`/find?zip=${result.zip}`);
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="hero">
      <div className="wrap hero-grid">
        <div className="hero-l">
          <div className="kick">Event travel + reimbursement, one continuous system</div>
          <h1 className="disp" style={{ marginTop: 22 }}>
            Every mile ends in a{" "}
            <em>
              <Smile />.
            </em>
          </h1>
          <div className="hero-sub">
            <p className="lede">Choose how far you’ll go and what you’ll spend. S’mile finds the event, plans the route, asks before booking, then hands clean evidence to the organizer’s finance desk.</p>
            <div className="origin-head">
              <span>Start from</span>
              <div className="origin-modes" role="group" aria-label="Choose how to enter your starting location">
                <button type="button" aria-pressed={mode === "zip"} onClick={() => selectMode("zip")}>ZIP code</button>
                <button type="button" aria-pressed={mode === "city"} onClick={() => selectMode("city")}>City</button>
              </div>
            </div>
            <form className="zip" onSubmit={onSubmit}>
              {mode === "zip" ? (
                <input key="zip" inputMode="numeric" autoComplete="postal-code" maxLength={5} placeholder="Enter ZIP code" aria-label="Home ZIP code" value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))} autoFocus />
              ) : (
                <input key="city" inputMode="text" autoComplete="address-level2" maxLength={100} placeholder="City, state" aria-label="Home city and state" value={city} onChange={(e) => setCity(e.target.value)} autoFocus />
              )}
              <button type="submit" disabled={busy}>
                {busy ? "Locating…" : "Find trips"}{" "}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </form>
            <p className={`note origin-note${message?.kind === "error" ? " error" : ""}`} aria-live="polite">
              {message?.text ?? (mode === "zip" ? "Use the ZIP where your trip begins." : "U.S. cities work best with a state abbreviation.")}
            </p>
          </div>
        </div>
        <div className="hero-r" aria-hidden="true">
          <div className="phone">
            <div className="ph-scr">
              <div className="ph-notch" />
              <div className="ph-head">
                <div style={{ display: "flex", justifyContent: "center", paddingLeft: 8 }}>
                  <span className="av">A</span>
                  <span className="av">J</span>
                  <span className="av">R</span>
                </div>
                <b>Davis → GG Hack</b>
                <small>Group chat · via Photon</small>
              </div>
              <PhoneChat />
              <div className="ph-in">
                <span>
                  Type <b style={{ color: "var(--color-accent-700)" }}>@smile</b> to ask…
                </span>
                <i />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
