import type { Cents } from "./types";

export const usd = (dollars: number): Cents => Math.round(dollars * 100);

export const fmt = (c: Cents): string =>
  (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toFixed(2);

export const sum = (xs: Cents[]): Cents => xs.reduce((a, b) => a + b, 0);

/** Every dollar amount written in `text`, in cents. */
export function amountsIn(text: string): number[] {
  return [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => Math.round(Number(m[1]!.replace(/,/g, "")) * 100));
}

/** True when every dollar amount in the reply appears in some tool result. */
export function amountsGrounded(reply: string, toolText: string[]): { ok: boolean; stray: number[] } {
  const allowed = new Set(toolText.flatMap(amountsIn));
  const stray = amountsIn(reply).filter((c) => !allowed.has(c));
  return { ok: stray.length === 0, stray };
}
