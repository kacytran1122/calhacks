"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

type Credentials = { tripId: string; tripToken: string };
type JoinResult = {
  messageUrl: string;
  starterMessage: string;
  expiresAt: string;
};

function credentialsFromHash(): Credentials | null {
  const values = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const tripId = values.get("trip") ?? "";
  const tripToken = values.get("token") ?? "";
  return tripId && tripToken ? { tripId, tripToken } : null;
}

export function ChatClient() {
  const [credentials, setCredentials] = useState<Credentials | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinResult | null>(null);
  const [copied, setCopied] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const credentials = credentialsFromHash();
    setCredentials(credentials);
    const values = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (values.has("trip") || values.has("token")) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    }
    return () => requestRef.current?.abort();
  }, []);

  const requestQr = async () => {
    if (!credentials || loading) return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/chat/photon/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tripId: credentials.tripId, tripToken: credentials.tripToken }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as Partial<JoinResult> & { error?: string };
      if (!response.ok || !body.messageUrl || !body.starterMessage || !body.expiresAt) {
        throw new Error(body.error || "The secure iMessage QR is temporarily unavailable.");
      }
      setResult(body as JoinResult);
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") {
        setError(cause instanceof Error ? cause.message : "The secure iMessage QR is temporarily unavailable.");
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.starterMessage);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setError("Copy was blocked by this browser. Select the message below and copy it manually.");
    }
  };

  return (
    <main className="pj-shell">
      <header className="pj-nav">
        <a href="/landing" className="pj-brand" aria-label="Back to home">S’mile</a>
        <span className="pj-private"><i aria-hidden="true" /> Private iMessage</span>
      </header>

      <section className="pj-hero" aria-labelledby="photon-title">
        <div className="pj-copy">
          <p className="pj-kicker">Your route, sent privately</p>
          <h1 id="photon-title">Message <em>@smile</em><br />from iMessage.</h1>
          <p className="pj-lede">Scan one QR to open your private @smile conversation. The route request is already filled in, and this website never asks for your phone number or email address.</p>
          <ol className="pj-steps" aria-label="How it works">
            <li><span>1</span><div><b>Create the secure QR</b><small>It contains a short-lived code for this trip, not your trip token.</small></div></li>
            <li><span>2</span><div><b>Scan and send</b><small>The message begins with @smile so the assistant can respond.</small></div></li>
            <li><span>3</span><div><b>Tap the route link</b><small>iMessage cannot open a browser tab automatically; @smile replies with the secure map link.</small></div></li>
          </ol>
        </div>

        <section className="pj-card" aria-label="Open @smile in iMessage">
          <div className="pj-card-top">
            <span className="pj-orb" aria-hidden="true">☺</span>
            <div><b>@smile on Messages</b><small>Photon-assigned line · one-to-one conversation</small></div>
          </div>

          {credentials === undefined ? (
            <p className="pj-status" role="status">Checking your trip link…</p>
          ) : !credentials ? (
            <div className="pj-gate">
              <span className="pj-gate-icon" aria-hidden="true">↗</span>
              <h2>Plan a trip first</h2>
              <p>Your current trip result creates a private, expiring QR. No contact details are collected.</p>
              <a className="pj-button primary" href="/finding-events">Find an event and plan my trip</a>
              <small>Already planned? Use “Message @smile privately” in your trip result.</small>
            </div>
          ) : result ? (
            <div className="pj-ready" aria-live="polite">
              <div className="pj-ready-copy">
                <p className="pj-kicker">Your secure QR is ready</p>
                <h2>Scan, then send the message.</h2>
                <p>Send the filled-in request within 15 minutes. @smile will reply with your secure map link.</p>
              </div>
              <figure className="pj-qr" aria-label="QR code that opens a private @smile conversation in Messages">
                <QRCodeSVG value={result.messageUrl} size={220} level="M" marginSize={2} bgColor="#ffffff" fgColor="#201f1d" title="Open @smile in Messages with the route request filled in" />
              </figure>
              <a className="pj-button primary" href={result.messageUrl}>Open Messages</a>
              <div className="pj-message">
                <small>The QR fills in this private request</small>
                <code>{result.starterMessage}</code>
                <button type="button" onClick={copy}>{copied ? "Copied" : "Copy message"}</button>
              </div>
              <p className="pj-warning"><b>One final tap:</b> browsers cannot be opened automatically after an iMessage. Tap the secure route link in @smile’s reply.</p>
            </div>
          ) : (
            <div className="pj-gate">
              <span className="pj-gate-icon" aria-hidden="true">↗</span>
              <h2>Create your Messages QR</h2>
              <p>No phone number or email address is requested. The QR opens your private conversation with an @smile route request ready to send.</p>
              {error && <p className="pj-error" role="alert">{error}</p>}
              <button className="pj-button primary" type="button" disabled={loading} onClick={() => void requestQr()}>
                {loading ? "Creating secure QR…" : error ? "Try again" : "Create Messages QR"}
              </button>
              <p className="pj-fine">The claim code expires after 15 minutes and works for one direct conversation.</p>
            </div>
          )}
          {result && error && <p className="pj-error" role="alert">{error}</p>}
        </section>
      </section>
    </main>
  );
}
