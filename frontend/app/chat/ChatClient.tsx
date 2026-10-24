"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatMsg } from "@/lib/chat";

const CHAT = "davis-gg-hack";
const PEOPLE = ["Ari Lee", "Jun Park", "Rae Kim"];
const TRIES = ["@smile 95616", "@smile 95616 is anyone else going?", "@smile 94720", "@smile who am I riding with?"];

const usd = (c: number) => `$${(c / 100).toFixed(2).replace(/\.00$/, "")}`;
const ini = (n: string) =>
  n
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3) || "?";

export function ChatClient() {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [typing, setTyping] = useState(false);
  const [me, setMe] = useState(PEOPLE[1]!);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Private approve links for replies to messages sent from this device (never shared with the room).
  const [approvals, setApprovals] = useState<Record<string, string>>({});
  const end = useRef<HTMLDivElement>(null);

  const apply = (v: { messages: ChatMsg[]; typing: boolean }) => {
    setMsgs(v.messages);
    setTyping(v.typing);
  };

  // Poll so a second tab (or a second person) sees the same room.
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`/api/chat?chatId=${CHAT}`)
        .then((r) => r.json())
        .then((v) => live && apply(v))
        .catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs.length, typing]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setErr(null);
    setText("");
    // Show the message straight away; @smile may take a while to collect live evidence.
    setMsgs((m) => [...m, { id: `local-${Date.now()}`, from: me, initials: ini(me), text: t, at: new Date().toISOString() }]);
    if (/(^|\s)@smile\b/i.test(t)) setTyping(true);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: CHAT, from: me, text: t }) });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error ?? r.statusText);
      apply(v);
      setApprovals((a) => ({ ...a, ...v.approvals }));
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setSending(false);
    }
  };

  const clear = async () => apply(await (await fetch(`/api/chat?chatId=${CHAT}`, { method: "DELETE" })).json());

  const members = [...new Set([...PEOPLE, ...msgs.filter((m) => !m.bot).map((m) => m.from)])];

  return (
    <main className="ch">
      <header className="ch-top">
        <a href="/" className="ch-back" aria-label="Back to S’mile">
          ←
        </a>
        <div className="ch-avs" aria-hidden="true">
          {members.slice(0, 4).map((m) => (
            <span key={m} className="ch-av">
              {ini(m)}
            </span>
          ))}
        </div>
        <div className="ch-title">
          <b>Davis → GG Hack</b>
          <small>Group chat · web preview of the Photon iMessage surface</small>
        </div>
        <button className="ch-clear" onClick={clear} type="button">
          Clear
        </button>
      </header>

      <section className="ch-log" aria-live="polite">
        {msgs.length === 0 && (
          <p className="ch-empty">
            Mention <span className="mn">@smile</span> with your home ZIP, and the event link if you have one. S’mile replies with the best way there, the price and the chance you miss kickoff. If others in this chat are taking the same ride, it groups you by initials only.
          </p>
        )}
        {msgs.map((m) => {
          const mine = !m.bot && m.from === me;
          return (
            <div key={m.id} className={`ch-row ${m.bot ? "bot" : mine ? "me" : "them"}`}>
              {!mine && <span className={`ch-av sm ${m.bot ? "bot" : ""}`}>{m.bot ? "☺" : m.initials}</span>}
              <div className="ch-col">
                {!mine && <small className="ch-name">{m.bot ? "S’mile" : m.from}</small>}
                <div className="ch-bub">{m.text}</div>
                {m.card && (
                  <div className="ch-card">
                    <div className="ch-card-h">
                      <span className="ch-mode">{m.card.mode}</span>
                      <b>{usd(m.card.priceCents)}</b>
                      <small>cap {usd(m.card.capCents)}</small>
                    </div>
                    <dl>
                      <dt>Event</dt>
                      <dd>{m.card.eventName}</dd>
                      <dt>P(miss kickoff)</dt>
                      <dd>{m.card.pMiss === null ? "no history yet" : `${Math.round(m.card.pMiss * 100)}% · ${m.card.historyTrips} past trips`}</dd>
                      <dt>Buddies</dt>
                      <dd>
                        {m.card.buddies.length ? (
                          m.card.buddies.map((b) => (
                            <span key={b} className="ch-av xs">
                              {b}
                            </span>
                          ))
                        ) : (
                          <span className="ch-mut">none yet</span>
                        )}
                      </dd>
                    </dl>
                    {approvals[m.id] ? (
                      <>
                        <a className="ch-approve" href={approvals[m.id]}>
                          Approve {usd(m.card.priceCents)} →
                        </a>
                        <small className="ch-only">Only you can see this link</small>
                      </>
                    ) : (
                      <span className="ch-mut">Approve link sent privately to {m.text.match(/^@(\S+)/)?.[1] ?? "the traveler"}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {typing && (
          <div className="ch-row bot">
            <span className="ch-av sm bot">☺</span>
            <div className="ch-bub ch-dots" aria-label="S’mile is planning">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        <div ref={end} />
      </section>

      <div className="ch-foot">
        <div className="ch-as">
          <span className="ch-mut">Typing as</span>
          {PEOPLE.map((p) => (
            <button key={p} type="button" className={`ch-pill ${p === me ? "on" : ""}`} onClick={() => setMe(p)}>
              {p.split(" ")[0]}
            </button>
          ))}
        </div>
        <div className="ch-tries">
          {TRIES.map((t) => (
            <button key={t} type="button" className="ch-try" onClick={() => setText(t)}>
              {t}
            </button>
          ))}
        </div>
        {err && <p className="ch-err">{err}</p>}
        <form className="ch-in" onSubmit={send}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type @smile to ask…" aria-label="Message" maxLength={1000} />
          <button type="submit" disabled={sending || !text.trim()}>
            Send
          </button>
        </form>
      </div>
    </main>
  );
}
