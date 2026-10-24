import { Smile, SmileWord } from "./Smile";

export function Cta() {
  return (
    <section className="cta" id="approve">
      <span className="blob b1" aria-hidden="true" />
      <span className="blob b2" aria-hidden="true" />
      <div className="wrap reveal" style={{ textAlign: "center", position: "relative" }}>
        <h2 className="disp" style={{ fontSize: "clamp(56px,8.5vw,128px)" }}>
          Add <Smile /> to <em>your trip.</em>
        </h2>
        <a className="cta-btn" href="/find">
          Get started
        </a>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer>
      <div className="wrap">
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <b>
            <SmileWord size="footer" />
          </b>
          , Every mile ends in a smile.
        </span>
        <a href="/desk" style={{ color: "inherit" }}>
          Organizer desk →
        </a>
      </div>
    </footer>
  );
}
