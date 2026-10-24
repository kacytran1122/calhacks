import type { Cents } from "./types";

export const usd = (dollars: number): Cents => Math.round(dollars * 100);

export const fmt = (c: Cents): string =>
  (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toFixed(2);

export const sum = (xs: Cents[]): Cents => xs.reduce((a, b) => a + b, 0);
