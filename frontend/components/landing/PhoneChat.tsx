"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Smile } from "./Smile";

type Msg = { k: "them" | "bot"; n: string; t: ReactNode };

const Mn = ({ children }: { children: ReactNode }) => <span className="mn">{children}</span>;

const SEQ: Msg[] = [
  { k: "them", n: "Ari", t: "Who else is coming to Golden Gate Hack from Davis?" },
  { k: "them", n: "Jun", t: <>Me! <Mn>@smile</Mn> what’s the best way to get there by 9?</> },
  { k: "bot", n: "", t: <><Mn>@Jun</Mn> Train + BART is best: $24, arrives 8:41. Driving is cheaper but Bay Bridge traffic adds ~30 min after 8.</> },
  { k: "them", n: "Rae", t: <><Mn>@smile</Mn> is the 6:58 usually late?</> },
  { k: "bot", n: "", t: <><Mn>@Rae</Mn> Late 1 in 8 Saturdays, by ~4 min. Your BART transfer still has 11 min buffer, so you’re safe.</> },
  { k: "them", n: "Ari", t: <><Mn>@smile</Mn> anything worth stopping for?</> },
  { k: "bot", n: "", t: <><Mn>@Ari</Mn> Jack London coffee, right at your transfer: +9 min, 4.7★. Also light rain at 7am, so bring a jacket.</> },
  { k: "them", n: "Jun", t: <><Mn>@smile</Mn> add the coffee stop please</> },
  { k: "bot", n: "", t: <><Mn>@all</Mn> Done. Your trip is ready for approval: $24 each, nothing is charged until you tap approve.</> },
  { k: "them", n: "Rae", t: "Approved. See you on car 3!" },
];

/** Animated group chat in the hero phone: typing dots, then the message, keeping the last five. */
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
        <div className="pb typing them">
          <i />
          <i />
          <i />
        </div>
      )}
    </div>
  );
}
