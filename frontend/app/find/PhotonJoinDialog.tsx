"use client";

import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

type JoinResult = {
  assignedPhoneNumber: string;
  messageUrl: string;
  starterMessage: string;
  reused: boolean;
};

type PhotonJoinDialogProps = {
  tripId: string;
  tripToken: string;
  eventName: string;
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PhotonJoinDialog({ tripId, tripToken, eventName }: PhotonJoinDialogProps) {
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinResult | null>(null);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const readyHeadingRef = useRef<HTMLHeadingElement>(null);
  const requestRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setHandle("");
    setConsent(false);
    setLoading(false);
    setError(null);
    setResult(null);
    setCopied(false);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    reset();
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [reset]);

  const launch = () => {
    reset();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => !item.hidden);
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [close, open]);

  useEffect(() => {
    if (result) readyHeadingRef.current?.focus();
  }, [result]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (loading) return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/chat/photon/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, consent, tripId, tripToken }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as Partial<JoinResult> & { error?: string };
      if (!response.ok || !body.assignedPhoneNumber || !body.messageUrl || !body.starterMessage) {
        throw new Error(body.error || "Private iMessage setup is temporarily unavailable.");
      }
      setResult(body as JoinResult);
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") {
        setError(cause instanceof Error ? cause.message : "Private iMessage setup is temporarily unavailable.");
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  const copyStarter = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.starterMessage);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copy was blocked by this browser. Select the message and copy it manually.");
    }
  };

  const keepFocusInside = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab" && event.currentTarget === document.activeElement) event.preventDefault();
  };

  return (
    <>
      <button ref={triggerRef} type="button" className="fd-photon-trigger" onClick={launch}>
        Message @smile privately in iMessage <span aria-hidden="true">→</span>
      </button>
      {open && createPortal(
        <div className="fd-photon-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <div
            ref={dialogRef}
            className="fd-photon-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="photon-dialog-title"
            aria-describedby="photon-dialog-description"
            aria-busy={loading}
            onKeyDown={keepFocusInside}
          >
            <button type="button" className="fd-photon-close" aria-label="Close iMessage setup" onClick={close}>×</button>
            <div className="fd-photon-top">
              <span className="fd-photon-orb" aria-hidden="true">☺</span>
              <div><b>S’mile on iMessage</b><small>Private travel help for {eventName}</small></div>
            </div>

            {result ? (
              <div className="fd-photon-ready" aria-live="polite">
                <p className="fd-photon-kicker">Your private line is ready</p>
                <h2 id="photon-dialog-title" ref={readyHeadingRef} tabIndex={-1}>Scan, then send first</h2>
                <p id="photon-dialog-description">Scan with your phone, or open Messages on this device. Send the starter message so Photon can reply.</p>
                <figure className="fd-photon-qr" aria-label="QR code that opens your assigned S’mile conversation in Messages">
                  <QRCodeSVG value={result.messageUrl} size={220} level="M" marginSize={2} bgColor="#ffffff" fgColor="#2b1b3d" title="Open your private S’mile conversation in Messages" />
                </figure>
                <a className="dk-btn primary fd-photon-open" href={result.messageUrl}>Open Messages</a>
                <div className="fd-photon-message">
                  <small>Copy, paste, and send this first</small>
                  <code>{result.starterMessage}</code>
                  <button type="button" onClick={copyStarter}>{copied ? "Message copied" : "Copy starter message"}</button>
                </div>
                <p className="fd-photon-note"><b>Blue bubble check:</b> use the same phone number or Apple Account email you entered. Include <b>@smile</b> in every follow-up.</p>
                {result.reused && <p className="fd-photon-reused">Your existing private assignment was reused.</p>}
                {error && <p className="fd-photon-error" role="alert">{error}</p>}
              </div>
            ) : (
              <form className="fd-photon-form" onSubmit={submit}>
                <p className="fd-photon-kicker">Connect privately</p>
                <h2 id="photon-dialog-title">Open your S’mile chat</h2>
                <p id="photon-dialog-description">Enter the exact identity selected under Settings → Apps → Messages → Send &amp; Receive.</p>
                <label className="fd-photon-field">
                  <span>iMessage phone or Apple Account email</span>
                  <input ref={inputRef} value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="(415) 555-0123 or you@icloud.com" autoComplete="username" spellCheck={false} maxLength={254} required />
                </label>
                <label className="fd-photon-consent">
                  <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required />
                  <span>I agree that this identity is sent securely to Photon so it can assign my private Messages number. It is not shown to other travelers.</span>
                </label>
                {error && <p className="fd-photon-error" role="alert">{error}</p>}
                <button className="dk-btn primary fd-photon-submit" type="submit" disabled={loading || !handle.trim() || !consent}>
                  {loading ? "Creating your private line…" : "Create QR code"}
                </button>
                <p className="fd-photon-fine">You send the first message. Every message to the assistant must include <b>@smile</b>.</p>
              </form>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
