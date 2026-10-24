import fs from "node:fs";
import path from "node:path";
import { Smile } from "./Smile";

function Shot({ file, placeholder }: { file: string; placeholder: string }) {
  const exists = fs.existsSync(path.join(process.cwd(), "public", file));
  return exists ? <img src={`/${file}`} alt={placeholder} /> : <div className="slot">{placeholder}</div>;
}

export function Why() {
  return (
    <section id="why" className="why">
      <div className="wrap">
        <div className="reveal" style={{ maxWidth: 860 }}>
          <div className="kick">
            Why <Smile />
          </div>
          <h2 className="disp" style={{ fontSize: "clamp(48px,6.5vw,96px)", marginTop: 18 }}>
            One trip. <em>Too many</em> tabs.
          </h2>
        </div>
        <div className="tabs-row">
          <figure className="tabf reveal" style={{ ["--r" as string]: "-3deg" }}>
            <div className="tf-bar">
              <i />
              <i />
              <i />
              <span>Search flights</span>
            </div>
            <div className="tf-img">
              <Shot file="why-flights.png" placeholder="Screenshot: Claude / Google Flights search" />
            </div>
            <figcaption>
              <b>Tab 1 · Search flights</b>Claude and Google Flights find fares, but stop at the ticket.
            </figcaption>
          </figure>
          <div className="plus" aria-hidden="true">
            +
          </div>
          <figure className="tabf reveal" style={{ ["--r" as string]: "2.5deg" }}>
            <div className="tf-bar">
              <i />
              <i />
              <i />
              <span>Ask for a guide</span>
            </div>
            <div className="tf-img">
              <Shot file="why-gemini.png" placeholder="Screenshot: Gemini in Chrome giving a guide" />
            </div>
            <figcaption>
              <b>Tab 2 · Get a guide</b>Gemini in Chrome explains the page, but doesn’t plan the trip.
            </figcaption>
          </figure>
        </div>
        <div className="born reveal">
          <div className="eq" aria-hidden="true">
            =
          </div>
          <div>
            <p className="born-q">So why not all in one?</p>
            <h3 className="disp born-h">
              That’s how <Smile /> was born.
            </h3>
          </div>
        </div>
      </div>
    </section>
  );
}
