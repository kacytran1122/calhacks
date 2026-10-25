"use client";

import { useEffect, useState } from "react";
import { SmileWord } from "./Smile";

const LINKS = [
  { href: "#journey", label: "The journey" },
  { href: "#how", label: "How it works" },
  { href: "#lens", label: "Extension" },
  { href: "#faq", label: "FAQ" },
];

export function Header() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const sections = LINKS.map((l) => document.querySelector(l.href));
    const spy = () => {
      const y = innerHeight * 0.4;
      let k = -1;
      sections.forEach((s, i) => {
        if (s && s.getBoundingClientRect().top <= y) k = i;
      });
      setActive(k);
    };
    addEventListener("scroll", spy, { passive: true });
    spy();
    return () => removeEventListener("scroll", spy);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onResize = () => innerWidth > 860 && setOpen(false);
    addEventListener("keydown", onKey);
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <header className={`top${open ? " menu-open" : ""}`}>
      <div className="wrap">
        <a className="brand" href="/landing" aria-label="S’mile home">
          <SmileWord />
        </a>
        <nav className="links" id="nav">
          {LINKS.map((l, i) => (
            <a key={l.href} href={l.href} className={i === active ? "on" : undefined}>
              {l.label}
            </a>
          ))}
        </nav>
        <div className="top-r">
          <a className="btn btn-primary" href="#plan">
            Plan a trip
          </a>
          <button className="burger" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="mnav" onClick={() => setOpen(!open)}>
            <i />
            <i />
            <i />
          </button>
        </div>
      </div>
      <nav className="mnav" id="mnav" aria-label="Mobile">
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} onClick={() => setOpen(false)}>
            {l.label}
          </a>
        ))}
        <a className="mnav-cta" href="#plan" onClick={() => setOpen(false)}>
          Plan a trip
        </a>
      </nav>
    </header>
  );
}
