"use client";

import { useState, type FormEvent } from "react";
import { PhoneChat } from "./PhoneChat";
import { Smile } from "./Smile";
import type { TravelOrigin } from "@/lib/travelSession";

type OriginMode = "zip" | "city";
type PendingOrigin = { zip: string; label: string };

export function HeroView({ onNavigate }: { onNavigate: (origin: TravelOrigin) => void }) {
  const [mode, setMode] = useState<OriginMode>("zip");
  const [zip, setZip] = useState("");
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [pendingOrigin, setPendingOrigin] = useState<PendingOrigin | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
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
      setPendingOrigin({ zip: value, label: value });
      setLocationError(null);
      return;
    }

    if (city.trim().length < 3) {
      setMessage({ kind: "error", text: "Enter a U.S. city, state, or city and state." });
      return;
    }

    setBusy(true);
    setMessage({ kind: "hint", text: "Finding the best starting point…" });
    try {
      const response = await fetch(`/api/location/resolve?city=${encodeURIComponent(city.trim())}`);
      const result = (await response.json()) as { zip?: string; label?: string; error?: string };
      if (!response.ok || !result.zip) throw new Error(result.error ?? "We couldn’t find that city.");
      setMessage({ kind: "hint", text: `${result.label ?? city} found.` });
      setPendingOrigin({ zip: result.zip, label: result.label ?? city.trim() });
      setLocationError(null);
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const continueWithEnteredLocation = () => {
    if (pendingOrigin) onNavigate(pendingOrigin);
  };

  const allowCurrentLocation = async () => {
    if (!navigator.geolocation) {
      setLocationError("This browser cannot provide a current location. Use the location you entered instead.");
      return;
    }
    setLocating(true);
    setLocationError(null);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20_000, maximumAge: 300_000 }),
      );
      const coordinates = { lat: position.coords.latitude, lon: position.coords.longitude };
      if (pendingOrigin) onNavigate({ ...pendingOrigin, label: "Current location", coordinates, enteredOrigin: pendingOrigin });
    } catch (error) {
      const code = (error as GeolocationPositionError).code;
      setLocationError(code === 1 ? "Location access is blocked in the browser. Allow it and try again, or use the location you entered." : "We couldn’t get a location from this device. Check that Location Services are on, then try again or use the location you entered.");
    } finally {
      setLocating(false);
    }
  };

  return (
    <section className="hero">
      <div className="wrap hero-grid">
        <div className="hero-l">
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
                <button type="button" aria-pressed={mode === "city"} onClick={() => selectMode("city")}>City or state</button>
              </div>
            </div>
            <form className="zip" onSubmit={onSubmit}>
              {mode === "zip" ? (
                <input key="zip" inputMode="numeric" autoComplete="postal-code" maxLength={5} placeholder="Enter ZIP code" aria-label="Home ZIP code" value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))} autoFocus />
              ) : (
                <input key="city" inputMode="text" autoComplete="address-level2" maxLength={100} placeholder="City, state, or city + state" aria-label="Home city or state" value={city} onChange={(e) => setCity(e.target.value)} autoFocus />
              )}
              <button type="submit" disabled={busy}>
                {busy ? "Locating…" : "Find trips"}{" "}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </form>
            <p className={`note origin-note${message?.kind === "error" ? " error" : ""}`} aria-live="polite">
              {message?.text ?? (mode === "zip" ? "Use the ZIP where your trip begins." : "Enter a city, a state, or both for a more precise match.")}
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
      {pendingOrigin && (
        <div className="location-modal-backdrop">
          <div className="location-modal" role="dialog" aria-modal="true" aria-labelledby="location-modal-title">
            <div className="location-modal-icon" aria-hidden="true">⌖</div>
            <h2 id="location-modal-title">Allow location access?</h2>
            <p>S’mile can use your current location once to find events closest to you.</p>
            <small>Your precise location is not saved.</small>
            {locating && <div className="location-modal-progress" role="status">Getting your location from the browser. This can take up to 20 seconds.</div>}
            {locationError && <div className="location-modal-error" role="alert">{locationError}</div>}
            <div className="location-modal-actions">
              <button type="button" className="location-skip" onClick={continueWithEnteredLocation}>Use {pendingOrigin.label} instead</button>
              <button type="button" className="location-allow" onClick={allowCurrentLocation} disabled={locating}>{locating ? "Checking location…" : "Allow location"}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
