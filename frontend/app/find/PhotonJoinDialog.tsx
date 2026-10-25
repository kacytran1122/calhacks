"use client";

import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

type JoinResult = {
  messageUrl: string;
  starterMessage: string;
  expiresAt: string;
};

type PhotonJoinDialogProps = {
  tripId: string;
  tripToken: string;
  eventName: string;
};

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function PhotonJoinDialog({ tripId, tripToken, eventName }: PhotonJoinDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinResult | null>(null);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requestRef = useRef<AbortController | null>(null);

  const requestQr = useCallback(async () => {
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/chat/photon/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tripId, tripToken }),
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
  }, [tripId, tripToken]);

  const reset = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
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
    void requestQr();
  };

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => headingRef.current?.focus(), 0);

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
    if (open && (result || error)) headingRef.current?.focus();
  }, [error, open, result]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const copyStarter = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.starterMessage);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
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
            <button type="button" className="fd-photon-close" aria-label="Close iMessage QR" onClick={close}>×</button>
            <div className="fd-photon-top">
              <span className="fd-photon-orb" aria-hidden="true">☺</span>
              <div><b>@smile on iMessage</b><small>Your route to {eventName}</small></div>
            </div>

            {result ? (
              <div className="fd-photon-ready" aria-live="polite">
                <p className="fd-photon-kicker">Your secure QR is ready</p>
                <h2 id="photon-dialog-title" ref={headingRef} tabIndex={-1}>Scan, then send the message</h2>
                <p id="photon-dialog-description">The QR opens the dedicated @smile conversation with your one-time route request already filled in. Send it within 15 minutes.</p>
                <figure className="fd-photon-qr" aria-label="QR code that opens the dedicated @smile conversation in Messages">
                  <QRCodeSVG value={result.messageUrl} size={220} level="M" marginSize={2} bgColor="#ffffff" fgColor="#2b1b3d" title="Open @smile in Messages with the route request filled in" />
                </figure>
                <a className="dk-btn primary fd-photon-open" href={result.messageUrl}>Open Messages</a>
                <div className="fd-photon-message">
                  <small>The QR fills in this private request</small>
                  <code>{result.starterMessage}</code>
                  <button type="button" onClick={copyStarter}>{copied ? "Message copied" : "Copy message"}</button>
                </div>
                <p className="fd-photon-note"><b>One final tap:</b> iMessage cannot open a website tab automatically. After you send, @smile replies with a secure map link; tap that link to open your route.</p>
                {error && <p className="fd-photon-error" role="alert">{error}</p>}
              </div>
            ) : error ? (
              <div className="fd-photon-form">
                <p className="fd-photon-kicker">QR not ready</p>
                <h2 id="photon-dialog-title" ref={headingRef} tabIndex={-1}>Try the secure handoff again</h2>
                <p id="photon-dialog-description" className="fd-photon-error" role="alert">{error}</p>
                <button className="dk-btn primary fd-photon-submit" type="button" onClick={() => void requestQr()}>Try again</button>
                <p className="fd-photon-fine">This website never asks for your phone number or email address.</p>
              </div>
            ) : (
              <div className="fd-photon-form" role="status">
                <p className="fd-photon-kicker">Preparing iMessage</p>
                <h2 id="photon-dialog-title" ref={headingRef} tabIndex={-1}>Creating your secure QR…</h2>
                <p id="photon-dialog-description">No phone number or email address is requested. Your trip token stays on the server.</p>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
