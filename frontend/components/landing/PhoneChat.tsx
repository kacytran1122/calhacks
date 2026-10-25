"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Smile } from "./Smile";

type Msg = { k: "me" | "bot"; n: string; t: ReactNode };

const Mn = ({ children }: { children: ReactNode }) => <span className="mn">{children}</span>;

const SEQ: Msg[] = [
  { k: "me", n: "You", t: <><Mn>@smile</Mn> what’s the best way from Davis to Golden Gate Hack by 9?</> },
  { k: "bot", n: "", t: <><Mn>@You</Mn> Train + BART is best: $24, arrives 8:41. Driving is cheaper but Bay Bridge traffic adds ~30 min after 8.</> },
  { k: "me", n: "You", t: <><Mn>@smile</Mn> is the 6:58 usually late?</> },
  { k: "bot", n: "", t: <><Mn>@You</Mn> Late 1 in 8 Saturdays, by ~4 min. Your BART transfer still has 11 min buffer, so you’re safe.</> },
  { k: "me", n: "You", t: <><Mn>@smile</Mn> anyone nearby taking the same route?</> },
  { k: "bot", n: "", t: <><Mn>@You</Mn> Two nearby travelers match this route. I’ll show initials only after they plan, too.</> },
  { k: "me", n: "You", t: <><Mn>@smile</Mn> add a coffee stop please</> },
  { k: "bot", n: "", t: <><Mn>@You</Mn> Jack London coffee adds 9 minutes. Your trip is ready for approval; nothing is charged until you approve.</> },
];

export function PhoneChat() {
  const [shown, setShown] = useState<number[]>([]);
  const [typing, setTyping] = useState<Msg["k"] | null>(null);

  useEffect(() => {
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      if (i >= SEQ.length) {
        timer = setTimeout(() => {
          setShown([]);
          i = 0;
          step();
        }, 3500);
        return;
      }
      const m = SEQ[i]!;
      setTyping(m.k);
      timer = setTimeout(
        () => {
          setTyping(null);
          const idx = i;
          setShown((s) => [...s, idx].slice(-5));
          i++;
          timer = setTimeout(step, m.k === "bot" ? 2600 : 1500);
        },
        m.k === "bot" ? 1300 : 800,
      );
    };
    step();
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="ph-msgs">
      {shown.map((idx) => {
        const m = SEQ[idx]!;
        return (
          <div key={`${idx}-${m.n}`} className={`pb ${m.k}`}>
            <small>{m.k === "bot" ? <Smile /> : m.n}</small>
            {m.t}
          </div>
        );
      })}
      {typing && (
        <div className={`pb typing ${typing}`}>
          <i />
          <i />
          <i />
        </div>
      )}
    </div>
  );
}
