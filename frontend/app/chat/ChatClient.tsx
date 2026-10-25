"use client";

import { useEffect, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";

type Credentials = { tripId: string; tripToken: string };
type JoinResult = {
  assignedPhoneNumber: string;
  messageUrl: string;
  starterMessage: string;
  reused: boolean;
};

function credentialsFromHash(): Credentials | null {
  const values = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const tripId = values.get("trip") ?? "";
  const tripToken = values.get("token") ?? "";
  return tripId && tripToken ? { tripId, tripToken } : null;
}

export function ChatClient() {
  const [credentials, setCredentials] = useState<Credentials | null | undefined>(undefined);
  const [handle, setHandle] = useState("");
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinResult | null>(null);
  const [copied, setCopied] = useState<"number" | "message" | null>(null);

  useEffect(() => setCredentials(credentialsFromHash()), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!credentials || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/chat/photon/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, consent, tripId: credentials.tripId, tripToken: credentials.tripToken }),
      });
      const body = await response.json().catch(() => ({})) as Partial<JoinResult> & { error?: string };
      if (!response.ok || !body.assignedPhoneNumber || !body.messageUrl || !body.starterMessage) {
        throw new Error(body.error || "Private iMessage setup is temporarily unavailable.");
      }
      setResult(body as JoinResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Private iMessage setup is temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  };

  const copy = async (kind: "number" | "message", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1800);
    } catch {
      setError("Copy was blocked by this browser. Select the text below and copy it manually.");
    }
  };

  return (
    <main className="pj-shell">
      <header className="pj-nav">
        <a href="/" className="pj-brand" aria-label="Back to S’mile home">S’mile</a>
        <span className="pj-private"><i aria-hidden="true" /> Private iMessage</span>
      </header>

      <section className="pj-hero" aria-labelledby="photon-title">
        <div className="pj-copy">
          <p className="pj-kicker">Travel together, privately</p>
          <h1 id="photon-title">Message <em>@smile</em><br />from iMessage.</h1>
          <p className="pj-lede">Get route help and meet nearby travelers without joining a public group chat. Photon gives you a private one-to-one line; S’mile shares only matched travelers’ initials.</p>
          <ol className="pj-steps" aria-label="How it works">
            <li><span>1</span><div><b>Connect your sending identity</b><small>Use the exact phone or email checked in Messages → Send &amp; Receive.</small></div></li>
            <li><span>2</span><div><b>Open or scan the Messages link</b><small>The QR is generated locally for the real number Photon assigns to you.</small></div></li>
            <li><span>3</span><div><b>Send the first message</b><small>Begin every question and follow-up with <strong>@smile</strong>.</small></div></li>
          </ol>
        </div>

        <section className="pj-card" aria-label="Connect private iMessage">
          <div className="pj-card-top">
            <span className="pj-orb" aria-hidden="true">☺</span>
            <div><b>S’mile on Messages</b><small>Powered by Photon · one-to-one</small></div>
          </div>

          {credentials === undefined ? (
            <p className="pj-status" role="status">Checking your trip link…</p>
          ) : !credentials ? (
            <div className="pj-gate">
              <span className="pj-gate-icon" aria-hidden="true">↗</span>
              <h2>Plan a trip first</h2>
              <p>Your trip result creates a private, expiring connection link. This prevents automated signups from taking the limited Photon seats.</p>
              <a className="pj-button primary" href="/find">Find an event and plan my trip</a>
              <small>Already planned? Use “Message @smile privately” in your trip result.</small>
            </div>
          ) : result ? (
            <div className="pj-ready" aria-live="polite">
              <div className="pj-ready-copy">
                <p className="pj-kicker">Your private line is ready</p>
                <h2>Scan, then send first.</h2>
                <p>Open this conversation from the same phone number or Apple Account email you entered.</p>
              </div>
              <figure className="pj-qr" aria-label="QR code that opens your assigned S’mile conversation in Messages">
                <QRCodeSVG value={result.messageUrl} size={220} level="M" marginSize={2} bgColor="#ffffff" fgColor="#201f1d" title="Open your private S’mile conversation in Messages" />
              </figure>
              <a className="pj-button primary" href={result.messageUrl}>Open Messages</a>
              <button className="pj-button secondary" type="button" onClick={() => copy("number", result.assignedPhoneNumber)}>
                {copied === "number" ? "Number copied" : `Copy number · ${result.assignedPhoneNumber}`}
              </button>
              <div className="pj-message">
                <small>Copy this, then paste and send it in Messages</small>
                <code>{result.starterMessage}</code>
                <button type="button" onClick={() => copy("message", result.starterMessage)}>{copied === "message" ? "Copied" : "Copy message"}</button>
              </div>
              <p className="pj-warning"><b>Blue bubble check:</b> if the conversation is green, confirm that the identity you entered is active under Messages → Send &amp; Receive. Photon can reply only after you send first.</p>
              {result.reused && <p className="pj-reused">We found your existing private assignment—no extra Photon seat was used.</p>}
            </div>
          ) : (
            <form className="pj-form" onSubmit={submit}>
              <div>
                <p className="pj-kicker">Connect to Photon</p>
                <h2>Which identity sends your iMessages?</h2>
                <p>On iPhone: Settings → Apps → Messages → Send &amp; Receive. Enter the selected phone number or Apple Account email exactly.</p>
              </div>
              <label className="pj-field">
                <span>iMessage phone or Apple Account email</span>
                <input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="(415) 555-0123 or you@icloud.com" autoComplete="username" spellCheck={false} maxLength={254} required />
              </label>
              <label className="pj-consent">
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required />
                <span>I agree that this identity is sent securely to Photon so it can assign my private Messages number. S’mile does not display it to other travelers.</span>
              </label>
              {error && <p className="pj-error" role="alert">{error}</p>}
              <button className="pj-button primary" type="submit" disabled={loading || !handle.trim() || !consent}>
                {loading ? "Asking Photon…" : "Create my private Messages link"}
              </button>
              <p className="pj-fine">The assignment uses one of the project’s limited shared-line seats. <a href="/privacy">Privacy details</a></p>
            </form>
          )}
          {result && error && <p className="pj-error" role="alert">{error}</p>}
        </section>
      </section>
    </main>
  );
}
