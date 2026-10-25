"use client";

import { useState } from "react";

export type HourBar = { hour: number; period: string; p10: number; p50: number; p90: number };

const hourLabel = (h: number) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);
const usd = (v: number) => `$${v.toFixed(v >= 100 ? 0 : 2)}`;

/**
 * Typical (median) price for each hour of the day as a line with dots, on an axis zoomed to the
 * prices so the differences between times of day are visible. The p10–p90 range is in the readout
 * and the period table. One series, one color; the traveler's hour and the cheapest workable hour
 * are marked and labeled.
 */
export function HourChart({ bars, mine, best, title, past, pastLabel }: { bars: HourBar[]; mine?: number; best?: number; title: string; past?: (number | null)[]; pastLabel?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!bars.length) return null;
  const W = 560;
  const H = 170;
  const pad = { l: 40, r: 8, t: 10, b: 22 };
  const pastVals = (past ?? []).filter((v): v is number => typeof v === "number");
  const lo0 = Math.min(...bars.map((b) => b.p50), ...pastVals);
  const hi0 = Math.max(...bars.map((b) => b.p50), ...pastVals);
  const span = Math.max(hi0 - lo0, hi0 * 0.04);
  const lo = Math.max(0, lo0 - span * 0.25);
  const hi = hi0 + span * 0.25;
  const slot = (W - pad.l - pad.r) / bars.length;
  const cx = (i: number) => pad.l + i * slot + slot / 2;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));
  const ticks = [lo, (lo + hi) / 2, hi].map((v) => Math.round(v));
  const line = bars.map((b, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)},${y(b.p50).toFixed(1)}`).join(" ");
  // Past pattern: break the line where an hour had too little data, instead of drawing through it.
  const pastLine = (past ?? [])
    .map((v, i) => (typeof v === "number" ? `${i && typeof past?.[i - 1] === "number" ? "L" : "M"}${cx(i).toFixed(1)},${y(v).toFixed(1)}` : ""))
    .join(" ");
  const shown = hover ?? mine ?? best ?? null;
  const focus = bars.find((b) => b.hour === shown);
  const byPeriod = Object.values(
    bars.reduce<Record<string, { period: string; low: number; high: number; hours: number[] }>>((acc, b) => {
      const p = (acc[b.period] ??= { period: b.period, low: b.p50, high: b.p50, hours: [] });
      p.low = Math.min(p.low, b.p50);
      p.high = Math.max(p.high, b.p50);
      p.hours.push(b.hour);
      return acc;
    }, {}),
  );

  return (
    <figure className="hc">
      <figcaption className="hc-title">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="hc-svg" role="img" aria-label={`${title}. ${bars.map((b) => `${hourLabel(b.hour)} ${usd(b.p50)}`).join(", ")}`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="hc-grid" />
            <text x={pad.l - 6} y={y(t) + 4} className="hc-axis" textAnchor="end">
              ${t}
            </text>
          </g>
        ))}
        {pastLine && <path d={pastLine} className="hc-past" />}
        <path d={line} className="hc-line" />
        {bars.map((b, i) => {
          const cls = b.hour === mine ? "hc-dot mine" : b.hour === best ? "hc-dot best" : "hc-dot";
          const big = b.hour === mine || b.hour === best || hover === b.hour;
          return (
            <g key={b.hour} onMouseEnter={() => setHover(b.hour)} onFocus={() => setHover(b.hour)} tabIndex={0} aria-label={`${hourLabel(b.hour)}: ${usd(b.p50)}, range ${usd(b.p10)} to ${usd(b.p90)}`}>
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={H - pad.t - pad.b} fill="transparent" />
              {hover === b.hour && <line x1={cx(i)} x2={cx(i)} y1={pad.t} y2={H - pad.b} className="hc-cross" />}
              {typeof past?.[i] === "number" && <circle cx={cx(i)} cy={y(past[i] as number)} r={hover === b.hour ? 4 : 2.5} className="hc-past-dot" />}
              <circle cx={cx(i)} cy={y(b.p50)} r={big ? 6 : 4} className={cls} />
              {(i % 3 === 0 || b.hour === mine || b.hour === best) && (
                <text x={cx(i)} y={H - 6} className="hc-axis" textAnchor="middle">
                  {hourLabel(b.hour)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="hc-key">
        {mine !== undefined && (
          <span>
            <i className="mine" /> your departure ({hourLabel(mine)})
          </span>
        )}
        {best !== undefined && best !== mine && (
          <span>
            <i className="best" /> cheapest that still works ({hourLabel(best)})
          </span>
        )}
        <span>
          <i className="dot" /> predicted for your trip
        </span>
        {pastVals.length > 0 && (
          <span>
            <i className="past" /> {pastLabel ?? "past pattern"}
          </span>
        )}
      </div>
      {focus && (
        <p className="hc-focus">
          <b>{hourLabel(focus.hour)}</b> · {focus.period}: predicted about <b>{usd(focus.p50)}</b>, likely {usd(focus.p10)}–{usd(focus.p90)}
          {typeof past?.[bars.indexOf(focus)] === "number" && <> · past pattern {usd(past[bars.indexOf(focus)] as number)}</>}
        </p>
      )}
      <table className="dk-table tight hc-periods">
        <thead>
          <tr>
            <th>Time of day</th>
            <th className="r">Typical price</th>
          </tr>
        </thead>
        <tbody>
          {byPeriod.map((p) => (
            <tr key={p.period} className={mine !== undefined && p.hours.includes(mine) ? "sel" : undefined}>
              <td>
                {p.period} <span className="dk-mut">({hourLabel(Math.min(...p.hours))}–{hourLabel((Math.max(...p.hours) + 1) % 24)})</span>
              </td>
              <td className="r num">{p.low === p.high ? usd(p.low) : `${usd(p.low)}–${usd(p.high)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
