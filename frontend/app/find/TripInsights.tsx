"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { HourChart } from "./HourChart";

type Point = { lat: number; lon: number };
type Range = { p10: number; p50: number; p90: number };
type HourPrice = { hour: number; period: string; uber: Range; lyft: Range };
type FlightHour = { hour: number; period: string; factor: number; range: Range; past: number | null };
type PriceOut = {
  rideshare: { uber: Range; lyft: Range; miles: number; minutes: number; departAt: string; departHour: number; period: string; byHour: HourPrice[]; pastByHour: (number | null)[]; cheapestOnTime: HourPrice | null; caveat: string } | null;
  airfare: { from: { code: string; city: string }; to: { code: string; city: string }; miles: number; range: Range; byHour: FlightHour[]; cheapestHour: FlightHour | null; caveat: string } | null;
  drive: { status: string; source: string; miles: number; minutes: number };
  models: { rideshare: { metrics: Record<string, number>; data: Record<string, unknown> }; airfare: { metrics: Record<string, number>; data: Record<string, unknown> } };
};
type Cell = { lat: number; lon: number; feelsLikeF: number; airTempF: number; anomalyF: number; modelSpreadF: number | null; severity: number; confidence: number; rank: number };
type Heat = {
  status: string;
  basis: "forecast" | "climatology";
  center: Point;
  radiusMiles: number;
  cells: Cell[];
  hotspots: Cell[];
  regionMedianF: number | null;
  band: string;
  summary: string;
  method: string[];
  sources: { name: string; url: string }[];
  error?: string;
};

const usd = (v: number) => `$${v.toFixed(v >= 100 ? 0 : 2)}`;

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

/** Feels-like °F → color, using the NWS heat-index bands so a color means the same thing everywhere. */
function heatColor(f: number) {
  if (f >= 103) return "#7f1d1d";
  if (f >= 90) return "#dc2626";
  if (f >= 80) return "#f97316";
  if (f >= 70) return "#facc15";
  if (f >= 60) return "#86efac";
  if (f >= 45) return "#38bdf8";
  return "#6366f1";
}

function RangeBar({ r, max }: { r: Range; max: number }) {
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <div className="ti-bar" aria-hidden="true">
      <span className="ti-band" style={{ left: pct(r.p10), width: `calc(${pct(r.p90)} - ${pct(r.p10)})` }} />
      <span className="ti-mid" style={{ left: pct(r.p50) }} />
    </div>
  );
}

function HeatMapView({ heat }: { heat: Heat }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || !heat.cells.length) return;
    let map: import("leaflet").Map | undefined;
    let cancelled = false;
    import("leaflet").then(({ default: L }) => {
      if (cancelled || !el.current) return;
      map = L.map(el.current, { scrollWheelZoom: false, attributionControl: true }).setView([heat.center.lat, heat.center.lon], 12);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap contributors" }).addTo(map);
      const n = Math.round(Math.sqrt(heat.cells.length));
      const halfLat = heat.radiusMiles / 69 / Math.max(1, n - 1);
      const halfLon = heat.radiusMiles / (69 * Math.cos((heat.center.lat * Math.PI) / 180)) / Math.max(1, n - 1);
      for (const c of heat.cells)
        L.rectangle(
          [
            [c.lat - halfLat, c.lon - halfLon],
            [c.lat + halfLat, c.lon + halfLon],
          ],
          { stroke: false, fillColor: heatColor(c.feelsLikeF), fillOpacity: 0.42 },
        )
          .bindTooltip(`Feels like ${c.feelsLikeF.toFixed(1)}°F · ${c.anomalyF >= 0 ? "+" : ""}${c.anomalyF.toFixed(1)}°F vs area`)
          .addTo(map);
      heat.hotspots.forEach((h, i) =>
        L.circleMarker([h.lat, h.lon], { radius: 9, color: "#2b1b3d", weight: 2, fillColor: "#fff", fillOpacity: 1 })
          .bindTooltip(`#${i + 1} hotspot · feels ${h.feelsLikeF.toFixed(1)}°F · +${h.anomalyF.toFixed(1)}°F · rank ${h.rank.toFixed(2)}`, { permanent: i === 0 })
          .addTo(map!),
      );
      L.circleMarker([heat.center.lat, heat.center.lon], { radius: 6, color: "#2b1b3d", weight: 2, fillColor: "#ffd84d", fillOpacity: 1 }).bindTooltip("Venue").addTo(map);
    });
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [heat]);
  return <div ref={el} className="ti-map" role="img" aria-label={heat.summary} />;
}

export function TripInsights({ from, to, startsAt, timeZone }: { from?: Point; to?: Point; startsAt?: string; timeZone?: string }) {
  const [price, setPrice] = useState<PriceOut | null>(null);
  const [heat, setHeat] = useState<Heat | null>(null);
  const [err, setErr] = useState<{ price?: string; heat?: string }>({});
  const [brand, setBrand] = useState<"uber" | "lyft">("uber");

  useEffect(() => {
    if (!from || !to || !startsAt) return;
    call<PriceOut>("/api/price-estimate", { from, to, startsAt, timeZone }).then(setPrice, (e) => setErr((x) => ({ ...x, price: (e as Error).message })));
    call<Heat>(`/api/heat?lat=${to.lat}&lon=${to.lon}&at=${encodeURIComponent(startsAt)}`).then(setHeat, (e) => setErr((x) => ({ ...x, heat: (e as Error).message })));
  }, [from?.lat, from?.lon, to?.lat, to?.lon, startsAt, timeZone]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!from || !to || !startsAt) return null;
  const rows = price
    ? [
        ...(price.rideshare ? [{ label: "Uber", sub: `${price.rideshare.miles} mi · ${price.rideshare.minutes} min`, r: price.rideshare.uber }, { label: "Lyft", sub: `${price.rideshare.miles} mi · ${price.rideshare.minutes} min`, r: price.rideshare.lyft }] : []),
        ...(price.airfare ? [{ label: `Flight ${price.airfare.from.code} → ${price.airfare.to.code}`, sub: `${price.airfare.miles} mi between airports`, r: price.airfare.range }] : []),
      ]
    : [];
  const max = Math.max(1, ...rows.map((x) => x.r.p90)) * 1.05;
  const rs = price?.models.rideshare;

  return (
    <div className="ti">
      <h3>Price outlook</h3>
      <p className="dk-mut">Predicted ranges for prices that move with time and demand. These are estimates for planning — you still approve an exact live price before anything is booked.</p>
      {err.price && <p className="dk-note">Price outlook unavailable: {err.price}</p>}
      {!price && !err.price && <p className="dk-mut">Running the price models…</p>}
      {price && rows.length === 0 && <p className="dk-note">No demand-based estimate is available for this route. Live route evidence above is still used for planning.</p>}
      {rows.length > 0 && (
        <table className="dk-table tight ti-prices">
          <tbody>
            {rows.map((x) => (
              <tr key={x.label}>
                <td>
                  <b>{x.label}</b>
                  <div className="dk-mut">{x.sub}</div>
                </td>
                <td className="ti-barcell">
                  <RangeBar r={x.r} max={max} />
                </td>
                <td className="r num">
                  <b>{usd(x.r.p50)}</b>
                  <div className="dk-mut">
                    {usd(x.r.p10)}–{usd(x.r.p90)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {price?.rideshare && price.rideshare.byHour.length > 0 && (
        <>
          <div className="dk-row" style={{ marginTop: 10 }}>
            <div className="dk-seg">
              <button className={brand === "uber" ? "on" : ""} onClick={() => setBrand("uber")}>
                Uber
              </button>
              <button className={brand === "lyft" ? "on" : ""} onClick={() => setBrand("lyft")}>
                Lyft
              </button>
            </div>
            <span className="dk-mut ti-small">
              You’d leave in the <b>{price.rideshare.period}</b>.
              {price.rideshare.cheapestOnTime && price.rideshare.cheapestOnTime.hour !== price.rideshare.departHour
                ? ` Leaving in the ${price.rideshare.cheapestOnTime.period} instead would be about ${usd(price.rideshare.cheapestOnTime[brand].p50)}.`
                : " That’s already the cheapest time that still gets you there on time."}
            </span>
          </div>
          <HourChart
            title={`${brand === "uber" ? "Uber" : "Lyft"} price by departure hour: past pattern vs predicted`}
            past={price.rideshare.pastByHour}
            pastLabel="past: what riders paid per mile at that hour (NYC, similar trips), × your distance"
            bars={price.rideshare.byHour.map((h) => ({ hour: h.hour, period: h.period, ...h[brand] }))}
            mine={price.rideshare.departHour}
            best={price.rideshare.cheapestOnTime?.hour}
          />
        </>
      )}
      {price?.airfare && price.airfare.byHour.length > 0 && (
        <HourChart
          title={`Flight ${price.airfare.from.code} → ${price.airfare.to.code} by departure hour: past pattern vs predicted`}
          past={price.airfare.byHour.map((h) => h.past)}
          pastLabel="past: how nonstop fares varied by departure hour, × this route's fare"
          bars={price.airfare.byHour.map((h) => ({ hour: h.hour, period: h.period, ...h.range }))}
          best={price.airfare.cheapestHour?.hour}
        />
      )}
      {price?.rideshare && <p className="dk-mut ti-small">{price.rideshare.caveat} Leaving {new Date(price.rideshare.departAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })} · road distance from {price.drive.source}.</p>}
      {price?.airfare && <p className="dk-mut ti-small">{price.airfare.caveat}</p>}
      {rs && (
        <p className="dk-mut ti-small">
          Rideshare model: {Number(rs.data.rows_train).toLocaleString()} trips · typical error {usd(rs.metrics.mae_p50 ?? 0)} on {Number(rs.metrics.n_test).toLocaleString()} unseen trips (simple rate card: {usd(rs.metrics.mae_baseline ?? 0)}).
        </p>
      )}

      <h3>Heat at the venue</h3>
      {err.heat && <p className="dk-note">Heat map unavailable: {err.heat}</p>}
      {!heat && !err.heat && <p className="dk-mut">Collecting temperatures around the venue…</p>}
      {heat && heat.status !== "ok" && <p className="dk-note">Venue heat evidence is not available for this event hour yet. No heat estimate is shown.</p>}
      {heat && heat.status === "ok" && (
        <>
          <HeatMapView heat={heat} />
          <div className="ti-legend">
            {[
              ["< 60°F", "#38bdf8"],
              ["60s", "#86efac"],
              ["70s", "#facc15"],
              ["80–89 caution", "#f97316"],
              ["90–102 extreme caution", "#dc2626"],
              ["103+ danger", "#7f1d1d"],
            ].map(([label, color]) => (
              <span key={label}>
                <i style={{ background: color }} />
                {label}
              </span>
            ))}
          </div>
          <p>{heat.summary}</p>
          {heat.hotspots.length > 0 && (
            <ol className="dk-ul">
              {heat.hotspots.map((h, i) => (
                <li key={i}>
                  Feels {h.feelsLikeF.toFixed(1)}°F (+{h.anomalyF.toFixed(1)}°F vs area) · severity {h.severity.toFixed(2)} × confidence {h.confidence.toFixed(2)} = <b>{h.rank.toFixed(2)}</b>
                </li>
              ))}
            </ol>
          )}
          <details className="ti-method">
            <summary>How this map is made</summary>
            <ul className="dk-ul">
              {heat.method.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <p className="dk-mut">
              Sources:{" "}
              {heat.sources.map((s, i) => (
                <span key={s.name}>
                  {i > 0 && " · "}
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.name}
                  </a>
                </span>
              ))}
              . Relative planning evidence, not calibrated measurements.
            </p>
          </details>
        </>
      )}
    </div>
  );
}
