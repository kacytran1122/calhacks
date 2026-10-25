"use client";

export type CarbonEstimate = { mode: string; kg: number; miles: number; formula: string; basis: string; riders?: number; hypothetical?: boolean; factor: { label: string; kgPerUnit: number; unit: string; source: "epa" | "carb"; note?: string } };
export type CarbonComparison = { estimates: CarbonEstimate[]; lowest: string | null; driveAloneKg: number; method: string[]; sources: { name: string; url: string }[] };
export type Carpool = { riders: string[]; people: number; hypothetical: boolean; perTravelerKg: number | null; driveAloneKg: number; savedKgPerTraveler: number | null; formula: string | null };

const NAME: Record<string, string> = { train: "Train + local transit", bus: "Bus", carpool: "Carpool", drive: "Drive alone", rideshare: "Rideshare", flight: "Flight + airport rides" };
const kg = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })} kg`;

/**
 * CO₂e per traveler for every way to get there, one bar per mode on a shared scale. Every number
 * shows its formula, factor and source next to it; nothing is labeled low-carbon without that.
 */
export function CarbonCompare({ carbon, pick, fastest, priced, carpool }: { carbon: CarbonComparison; pick?: string; fastest?: string; priced: string[]; carpool: Carpool | null }) {
  if (!carbon.estimates.length) return null;
  const max = Math.max(...carbon.estimates.map((e) => e.kg), 0.1);
  const chosen = carbon.estimates.find((e) => e.mode === pick);
  const saved = chosen ? Math.round((carbon.driveAloneKg - chosen.kg) * 10) / 10 : 0;
  const sourceOf = (e: CarbonEstimate) => carbon.sources[e.factor.source === "epa" ? 0 : 1];
  const label = (e: CarbonEstimate) =>
    e.mode === "carpool" ? (carpool && !carpool.hypothetical ? `Carpool with ${carpool.riders.join(", ")} (${e.riders} travelers)` : `Carpool (if ${(e.riders ?? 2) - 1} more traveler joins)`) : NAME[e.mode] ?? e.mode;

  return (
    <section className="cc" aria-label="Estimated emissions by way to get there">
      <h3>Emissions by way to get there</h3>
      {chosen && (
        <p className="cc-lead">
          Your recommended route emits about <b>{kg(chosen.kg)} CO₂e</b> per traveler
          {saved > 0 ? (
            <>
              , <b>{kg(saved)} less</b> than driving alone.
            </>
          ) : (
            "."
          )}{" "}
          Estimates: emission factor × distance.
        </p>
      )}
      <table className="dk-table tight cc-table">
        <thead>
          <tr>
            <th>Way to get there</th>
            <th className="cc-barcell">kg CO₂e per traveler</th>
          </tr>
        </thead>
        <tbody>
          {carbon.estimates.map((e) => (
            <tr key={e.mode} className={e.mode === pick ? "sel" : undefined}>
              <td>
                <b>{label(e)}</b>
                <span className="cc-tags">
                  {e.mode === pick && <span className="cc-tag pick">Recommended</span>}
                  {e.mode === carbon.lowest && <span className="cc-tag">Lowest carbon</span>}
                  {e.mode === fastest && <span className="cc-tag">Fastest</span>}
                  {!priced.includes(e.mode) && e.mode !== "carpool" && <span className="cc-tag muted">no verified fare</span>}
                </span>
                <small className="cc-formula">
                  {e.formula}.{" "}
                  <a href={sourceOf(e)?.url} target="_blank" rel="noreferrer">
                    {e.factor.source === "epa" ? `EPA: ${e.factor.label}` : "CARB ride-hailing inventory"}
                  </a>
                  .{e.factor.note ? ` ${e.factor.note}` : ""} Distance: {e.basis}.
                </small>
              </td>
              <td className="cc-barcell">
                <div className="cc-bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, (e.kg / max) * 100)}%` }} />
                </div>
                <span className="num">{kg(e.kg)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="ti-method">
        <summary>How these numbers are calculated</summary>
        <ul className="dk-ul ti-small">
          {carbon.method.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <p className="dk-mut ti-small">
          Sources:{" "}
          {carbon.sources.map((s, i) => (
            <span key={s.url}>
              {i > 0 && " · "}
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.name}
              </a>
            </span>
          ))}
        </p>
      </details>
    </section>
  );
}

/** A matched carpool: who, how much each traveler emits, and what that saves against driving alone. */
export function CarpoolCard({ carpool }: { carpool: Carpool }) {
  if (carpool.hypothetical || carpool.perTravelerKg === null || carpool.savedKgPerTraveler === null) return null;
  return (
    <div className="cc-pool">
      <b>
        Carpool with {carpool.riders.join(", ")}: {carpool.people} travelers in one car
      </b>
      <p>
        About {kg(carpool.perTravelerKg)} CO₂e each instead of {kg(carpool.driveAloneKg)} driving alone, saving <b>{kg(carpool.savedKgPerTraveler)} per passenger</b>.
      </p>
      {carpool.formula && <small className="cc-formula">{carpool.formula}, EPA passenger-car factor; includes pickup detours.</small>}
    </div>
  );
}
