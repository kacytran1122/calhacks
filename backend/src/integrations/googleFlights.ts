import { z } from "zod";
import { llmAvailable, structured } from "../llm";
import type { FetchStatus } from "../types";
import { readDatasetSnapshot, triggerDataset, unlock } from "./brightdata";

const GOOGLE_FLIGHTS_DATASET = "gd_mhng7wen1rw0a3gvpf";

export interface LiveFlightQuote {
  status: FetchStatus;
  amountUsd?: number;
  currency: "USD";
  fromAirport: string;
  toAirport: string;
  departDate: string;
  observedAt: string;
  sourceUrl: string;
  bookingUrl?: string;
  provider?: string;
  scope?: string;
  via: string;
  ms: number;
  snapshotId?: string;
  collectionState?: string;
  note?: string;
}

const ExtractedQuote = z.object({
  amountUsd: z.number().positive().max(10_000).nullable(),
  exactQuote: z.string().max(240).nullable(),
  provider: z.string().max(100).nullable(),
  scope: z.string().max(160).nullable(),
});

function isoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime());
}

export function googleFlightsUrl(fromAirport: string, toAirport: string, departDate: string) {
  const varint = (value: number | bigint) => {
    const bytes: number[] = [];
    let remaining = BigInt.asUintN(64, BigInt(value));
    while (remaining > 0x7fn) {
      bytes.push(Number(remaining & 0x7fn) | 0x80);
      remaining >>= 7n;
    }
    bytes.push(Number(remaining));
    return bytes;
  };
  const tag = (field: number, wire: number) => varint((field << 3) | wire);
  const scalar = (field: number, value: number | bigint) => [...tag(field, 0), ...varint(value)];
  const text = (field: number, value: string) => {
    const bytes = [...new TextEncoder().encode(value)];
    return [...tag(field, 2), ...varint(bytes.length), ...bytes];
  };
  const message = (field: number, value: number[]) => [...tag(field, 2), ...varint(value.length), ...value];
  const location = (airport: string) => [...scalar(1, 1), ...text(2, airport.toUpperCase())];
  const flight = [
    ...text(2, departDate),
    ...message(13, location(fromAirport)),
    ...message(14, location(toAirport)),
  ];
  const filter = [
    ...scalar(1, 28),
    ...scalar(2, 2),
    ...message(3, flight),
    ...scalar(8, 1),
    ...scalar(9, 1),
    ...scalar(14, 1),
    ...message(16, scalar(1, -1n)),
    ...scalar(19, 2),
  ];
  const tfs = Buffer.from(filter).toString("base64url");
  const params = new URLSearchParams({ tfs, tfu: "EgYIABABGAA", curr: "USD", hl: "en-US", gl: "US" });
  return `https://www.google.com/travel/flights/search?${params}`;
}

export function dayBefore(iso: string) {
  return new Date(new Date(iso).getTime() - 86_400_000).toISOString().slice(0, 10);
}

function googleFlightUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return /(^|\.)google\.com$/.test(url.hostname) && url.pathname.startsWith("/travel/flights") ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function amount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = value.replace(/,/g, "").match(/(?:USD\s*|\$)(\d+(?:\.\d{1,2})?)/i) ?? value.match(/^(\d+(?:\.\d{1,2})?)$/);
  return match ? Number(match[1]) : undefined;
}

type Candidate = { amountUsd: number; score: number; bookingUrl?: string; provider?: string; observedAt?: string; path: string };

function stringAt(record: Record<string, unknown>, pattern: RegExp) {
  const entry = Object.entries(record).find(([key, value]) => pattern.test(key) && typeof value === "string");
  return entry?.[1] as string | undefined;
}

function candidatesFromDataset(value: unknown): Candidate[] {
  const out: Candidate[] = [];
  const visit = (node: unknown, path: string[], root?: Record<string, unknown>) => {
    if (Array.isArray(node)) return node.forEach((item, index) => visit(item, [...path, String(index)], root));
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const top = root ?? record;
    for (const [key, child] of Object.entries(record)) {
      const next = [...path, key];
      const lower = next.join(":").toLowerCase();
      const leaf = key.toLowerCase().split(":").at(-1) ?? "";
      const n = amount(child);
      const isPrice = /^(price|amount|total|total_price|price_total|price_usd|amount_usd|total_amount|fare|fare_amount|price_value|display_price)$/.test(leaf);
      const contextualValue = /^(value|units)$/.test(leaf) && /pricing|price|fare|total|cost/.test(lower);
      const currency = stringAt(record, /(?:^|:)(?:currency|currency_code)$/i) ?? stringAt(top, /(?:^|:)(?:currency|currency_code)$/i);
      if (n !== undefined && n >= 20 && n <= 10_000 && (isPrice || contextualValue) && (!currency || currency.toUpperCase() === "USD")) {
        let score = 0;
        if (/pricing|provider|booking/.test(lower)) score += 3;
        if (/total/.test(lower)) score += 3;
        if (/price/.test(leaf)) score += 2;
        if (contextualValue) score += 2;
        if (/tax|fee|bag|change|carbon|points|mile/.test(lower)) score -= 5;
        const topUrl = googleFlightUrl(top.url);
        const localUrl = googleFlightUrl(record.url);
        const provider = stringAt(record, /(?:^|:)(?:provider|airline|name)$/i) ?? stringAt(top, /(?:^|:)(?:provider|airline)$/i);
        const observedAt = stringAt(top, /(?:^|:)(?:timestamp|observed_at|fetched_at)$/i);
        out.push({ amountUsd: Math.round(n * 100) / 100, score, bookingUrl: localUrl ?? topUrl, provider, observedAt, path: lower });
      }
      visit(child, next, top);
    }
  };
  visit(value, []);
  return out.sort((a, b) => b.score - a.score || a.amountUsd - b.amountUsd);
}

function pageText(markdown: string) {
  return markdown.replace(/\s+/g, " ").trim().slice(0, 80_000);
}

function quoteContains(quote: string, value: number) {
  const exact = value.toFixed(2);
  return quote.includes(`$${exact}`) || quote.includes(`$${exact.replace(/\.00$/, "")}`) || new RegExp(`USD\\s*${exact.replace(".", "\\.")}`).test(quote);
}

export async function liveGoogleFlightQuote(args: { fromAirport: string; toAirport: string; departDate: string; sourceUrl?: string; snapshotId?: string; timeoutMs?: number }): Promise<LiveFlightQuote> {
  const fromAirport = args.fromAirport.trim().toUpperCase();
  const toAirport = args.toAirport.trim().toUpperCase();
  const departDate = args.departDate;
  const observedAt = new Date().toISOString();
  const sourceUrl = googleFlightsUrl(fromAirport, toAirport, departDate);
  const base = { currency: "USD" as const, fromAirport, toAirport, departDate, observedAt, sourceUrl };
  if (!/^[A-Z]{3}$/.test(fromAirport) || !/^[A-Z]{3}$/.test(toAirport) || !isoDate(departDate)) return { ...base, status: "error", via: "validation", ms: 0, note: "A valid airport pair and travel date are required." };

  const timeoutMs = Math.min(30_000, Math.max(3_000, args.timeoutMs ?? 10_000));
  const started = Date.now();
  const datasetId = process.env.BRIGHTDATA_GOOGLE_FLIGHTS_DATASET_ID || GOOGLE_FLIGHTS_DATASET;
  const requestedSnapshot = args.snapshotId;
  const trigger = requestedSnapshot
    ? { status: "ok" as const, body: { snapshotId: requestedSnapshot }, attempts: 0, ms: 0 }
    : await triggerDataset(datasetId, [{ url: sourceUrl }], Math.min(5_000, timeoutMs));
  const snapshotId = trigger.body?.snapshotId;
  let collectionState = "starting";
  if (trigger.status === "ok" && snapshotId) {
    let checks = 0;
    while (Date.now() - started < timeoutMs - 700) {
      checks += 1;
      const remaining = timeoutMs - (Date.now() - started);
      const snapshot = await readDatasetSnapshot<unknown>(snapshotId, Math.min(4_000, remaining));
      collectionState = snapshot.body?.state ?? collectionState;
      if ((snapshot.status === "ok" || snapshot.status === "empty") && snapshot.body?.records) {
        const best = candidatesFromDataset(snapshot.body.records)[0];
        if (!best) return { ...base, status: "empty", snapshotId, collectionState: "ready", via: "Bright Data Google Flights scraper", ms: Date.now() - started, note: "The live collection completed without a verifiable USD fare." };
        return {
          ...base,
          status: "ok",
          amountUsd: best.amountUsd,
          observedAt: best.observedAt && !Number.isNaN(new Date(best.observedAt).getTime()) ? new Date(best.observedAt).toISOString() : observedAt,
          bookingUrl: best.bookingUrl,
          provider: best.provider ?? "Google Flights",
          scope: "Lowest USD fare returned for this airport pair and date",
          via: "Bright Data Google Flights scraper",
          ms: Date.now() - started,
          snapshotId,
          collectionState: "ready",
        };
      }
      if (snapshot.status === "error" || snapshot.status === "blocked") {
        return { ...base, status: snapshot.status, snapshotId, collectionState, via: "Bright Data Google Flights scraper", ms: Date.now() - started, note: snapshot.error ?? "The live fare collection failed." };
      }
      if (requestedSnapshot && checks >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_200, Math.max(0, timeoutMs - (Date.now() - started) - 700))));
    }
    return { ...base, status: "timeout", snapshotId, collectionState, via: "Bright Data Google Flights scraper", ms: Date.now() - started, note: "The live fare is still being collected. S’mile will keep checking this snapshot." };
  }

  const remaining = timeoutMs - (Date.now() - started);
  if (remaining < 1_500) return { ...base, status: trigger.status, via: "Bright Data Google Flights scraper", ms: Date.now() - started, note: trigger.error ?? "The live collection could not be started." };
  const page = await unlock(sourceUrl, "markdown", { attempts: 1, timeoutMs: remaining });
  if (page.status === "ok" && page.body && llmAvailable()) {
    const text = pageText(page.body);
    try {
      const extracted = await structured(ExtractedQuote, {
        model: "extract",
        system: "Extract the lowest currently displayed bookable USD fare for the exact airport pair and departure date. Use only a price explicitly present in the supplied Google Flights page text. Copy the exact contiguous price phrase. Do not estimate, convert currency, combine fees, or use an unrelated route, date, historical typical-price statistic, baggage fee, or loyalty points.",
        user: JSON.stringify({ fromAirport, toAirport, departDate, page: text }),
        effort: "low",
      });
      if (extracted.amountUsd && extracted.exactQuote && quoteContains(extracted.exactQuote, extracted.amountUsd) && text.toLowerCase().includes(extracted.exactQuote.toLowerCase())) {
        return { ...base, status: "ok", amountUsd: extracted.amountUsd, provider: extracted.provider ?? "Google Flights", scope: extracted.scope ?? "Lowest visible fare for this route and date", via: "Bright Data Web Unlocker → grounded extraction", ms: Date.now() - started };
      }
    } catch {
      // The result below preserves the source failure without inventing a price.
    }
  }

  const note = [trigger.error, page.error, page.status === "ok" ? "No exact route-and-date fare could be verified in the returned page." : undefined].filter(Boolean).join("; ");
  return { ...base, status: trigger.status === "timeout" || page.status === "timeout" ? "timeout" : trigger.status === "blocked" || page.status === "blocked" ? "blocked" : "empty", via: "Bright Data Google Flights scraper + Web Unlocker fallback", ms: Date.now() - started, note };
}
