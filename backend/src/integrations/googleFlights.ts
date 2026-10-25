import { z } from "zod";
import { llmAvailable, structured } from "../llm";
import type { FetchStatus } from "../types";
import { readDatasetSnapshot, triggerDataset, unlock } from "./brightdata";

const GOOGLE_FLIGHTS_DATASET = "gd_mhng7wen1rw0a3gvpf";
const snapshotQueries = new Map<string, { query: string; expires: number }>();

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
  fromAirport: z.string().length(3).nullable(),
  toAirport: z.string().length(3).nullable(),
  departDate: z.string().nullable(),
  provider: z.string().max(100).nullable(),
  scope: z.string().max(160).nullable(),
});

function isoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function googleFlightsUrl(fromAirport: string, toAirport: string, departDate: string) {
  if (!/^[A-Z]{3}$/i.test(fromAirport) || !/^[A-Z]{3}$/i.test(toAirport) || fromAirport.toUpperCase() === toAirport.toUpperCase() || !isoDate(departDate)) throw new Error("A valid, distinct airport pair and calendar departure date are required.");
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
  const match = value.trim().replace(/,/g, "").match(/^(?:(?:USD\s*|US\$\s*|\$\s*))?(\d+(?:\.\d{1,2})?)(?:\s*USD)?$/i);
  return match ? Number(match[1]) : undefined;
}

type Candidate = { amountUsd: number; score: number; bookingUrl?: string; provider?: string; observedAt?: string; path: string };
type FlightQuery = { fromAirport: string; toAirport: string; departDate: string };
const canonicalKey = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

function flightQueryFromUrl(value: unknown): FlightQuery | undefined {
  const source = googleFlightUrl(value);
  if (!source) return undefined;
  try {
    const encoded = new URL(source).searchParams.get("tfs");
    if (!encoded || encoded.length > 8_000) return undefined;
    const fields = (bytes: Uint8Array) => {
      const out = new Map<number, Uint8Array[]>();
      let offset = 0;
      const integer = () => {
        let n = 0;
        for (let shift = 0; shift < 70; shift += 7) {
          const b = bytes[offset++];
          if (b === undefined) throw new Error("Truncated query");
          if (shift < 28) n += (b & 127) * 2 ** shift;
          if (!(b & 128)) return n;
        }
        throw new Error("Invalid query");
      };
      while (offset < bytes.length) {
        const tag = integer();
        const wire = tag & 7;
        if (wire === 0) integer();
        else if (wire === 2) {
          const length = integer();
          if (offset + length > bytes.length) throw new Error("Truncated query");
          const value = bytes.slice(offset, offset + length);
          offset += length;
          out.set(tag >> 3, [...(out.get(tag >> 3) ?? []), value]);
        } else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
        else throw new Error("Unsupported query");
      }
      return out;
    };
    const legs = fields(Buffer.from(encoded, "base64url")).get(3);
    if (legs?.length !== 1) return undefined;
    const leg = fields(legs[0]!);
    const airport = (field: number) => {
      const location = leg.get(field)?.[0];
      const code = location ? fields(location).get(2)?.[0] : undefined;
      return code ? new TextDecoder().decode(code).toUpperCase() : "";
    };
    const date = leg.get(2)?.[0];
    const departDate = date ? new TextDecoder().decode(date) : "";
    const fromAirport = airport(13);
    const toAirport = airport(14);
    return /^[A-Z]{3}$/.test(fromAirport) && /^[A-Z]{3}$/.test(toAirport) && isoDate(departDate) ? { fromAirport, toAirport, departDate } : undefined;
  } catch {
    return undefined;
  }
}

function queryContext(record: Record<string, unknown>, parent: Partial<FlightQuery>): Partial<FlightQuery> {
  const code = (value: unknown): string | undefined => {
    if (typeof value === "string" && /^[A-Z]{3}$/i.test(value.trim())) return value.trim().toUpperCase();
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      return code(object.iata ?? object.iata_code ?? object.airport_code ?? object.code);
    }
    return undefined;
  };
  const context = { ...parent };
  const apply = (key: keyof FlightQuery, value: string | undefined) => {
    if (value) context[key] = context[key] && context[key] !== value ? "conflicting route metadata" : value;
  };
  for (const [rawKey, value] of Object.entries(record)) {
    const key = canonicalKey(rawKey);
    if (/^(?:url|input_url|source_url)$/i.test(key)) {
      const parsed = flightQueryFromUrl(value);
      if (parsed) for (const [field, text] of Object.entries(parsed)) apply(field as keyof FlightQuery, text);
    }
    if (/^(?:from_airport|origin_airport|departure_airport|origin|from)$/i.test(key)) apply("fromAirport", code(value));
    if (/^(?:to_airport|destination_airport|arrival_airport|destination|to)$/i.test(key)) apply("toAirport", code(value));
    if (/^(?:depart_date|departure_date|outbound_date|travel_date)$/i.test(key) && typeof value === "string" && isoDate(value.slice(0, 10))) apply("departDate", value.slice(0, 10));
    if (key === "route" && typeof value === "string") {
      const pair = value.trim().match(/^([A-Z]{3})\s*(?:→|->|-|to)\s*([A-Z]{3})$/i);
      if (pair) {
        apply("fromAirport", pair[1]!.toUpperCase());
        apply("toAirport", pair[2]!.toUpperCase());
      }
    }
  }
  return context;
}

function stringAt(record: Record<string, unknown>, pattern: RegExp) {
  const entry = Object.entries(record).find(([key, value]) => pattern.test(canonicalKey(key)) && typeof value === "string");
  return entry?.[1] as string | undefined;
}

function candidatesFromDataset(value: unknown, query: FlightQuery, requireIdentity: boolean): Candidate[] {
  const out: Candidate[] = [];
  const visit = (node: unknown, path: string[], root?: Record<string, unknown>, parent: Partial<FlightQuery> = {}, parentCurrency?: string) => {
    if (Array.isArray(node)) return node.forEach((item, index) => visit(item, [...path, String(index)], root, parent, parentCurrency));
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const top = root ?? record;
    const context = queryContext(record, parent);
    if (Object.entries(context).some(([key, value]) => value !== query[key as keyof FlightQuery])) return;
    const matched = context.fromAirport === query.fromAirport && context.toAirport === query.toAirport && context.departDate === query.departDate;
    const currency = stringAt(record, /(?:^|:)(?:currency|currency_code)$/i)?.toUpperCase() ?? parentCurrency;
    if (currency && currency !== "USD") return;
    const totalFields = /^(total|total_price|price_total|total_amount)$/;
    const hasTotal = Object.entries(record).some(([key, value]) => totalFields.test(canonicalKey(key)) && (amount(value) !== undefined || (value && typeof value === "object" && amount((value as Record<string, unknown>).value) !== undefined)));
    for (const [key, child] of Object.entries(record)) {
      const next = [...path, key];
      const lower = next.map(canonicalKey).join(":");
      const leaf = canonicalKey(key).split(":").at(-1) ?? "";
      if (/(?:^|:|_)(?:tax(?:es)?|fee(?:s)?|bag(?:gage)?|change|carbon|points|miles|history|historical|typical|predicted|estimate(?:d)?|price_range|base|seat(?:s)?|upgrade(?:s)?|insurance|meal(?:s)?|wifi|ancillary|extras|statistics|counts)(?:$|:|_)/.test(lower)) continue;
      if (hasTotal && /^(price|fare|amount|price_usd|amount_usd|fare_amount|price_value|display_price)$/.test(leaf)) continue;
      const n = amount(child);
      const isPrice = /^(price|total_price|price_total|price_usd|amount_usd|total_amount|fare|fare_amount|price_value|display_price)$/.test(leaf)
        || /^(amount|total)$/.test(leaf) && /pricing|price|fare|booking|itinerary|offer|provider/.test(lower);
      const contextualValue = /^(value|units)$/.test(leaf) && /pricing|price|fare|booking|itinerary|offer|provider/.test(lower);
      if (n !== undefined && n > 0 && n <= 10_000 && (isPrice || contextualValue) && (!requireIdentity || matched)) {
        let score = 0;
        if (/pricing|provider|booking/.test(lower)) score += 3;
        if (/total/.test(lower)) score += 3;
        if (/price/.test(leaf)) score += 2;
        if (contextualValue) score += 2;
        const topUrl = googleFlightUrl(top.url);
        const localUrl = googleFlightUrl(record.url);
        const provider = stringAt(record, /(?:^|:)(?:provider|airline|name)$/i) ?? stringAt(top, /(?:^|:)(?:provider|airline)$/i);
        const observedAt = stringAt(top, /(?:^|:)(?:timestamp|observed_at|fetched_at)$/i);
        out.push({ amountUsd: Math.round(n * 100) / 100, score, bookingUrl: localUrl ?? topUrl, provider, observedAt, path: lower });
      }
      visit(child, next, top, context, currency);
    }
  };
  visit(value, []);
  return out.sort((a, b) => a.amountUsd - b.amountUsd || b.score - a.score);
}

function pageText(markdown: string) {
  return markdown.replace(/\s+/g, " ").trim().slice(0, 80_000);
}

export function quoteContainsUsdAmount(quote: string, value: number) {
  const prices = quote.matchAll(/(?:^|[^A-Za-z0-9])(?:USD\s*|US\$\s*|\$\s*)((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?!\d|,\d|\.\d)/gi);
  return [...prices].some((match) => Number(match[1]!.replace(/,/g, "")) === value);
}

export async function liveGoogleFlightQuote(args: { fromAirport: string; toAirport: string; departDate: string; sourceUrl?: string; snapshotId?: string; timeoutMs?: number }): Promise<LiveFlightQuote> {
  const fromAirport = args.fromAirport.trim().toUpperCase();
  const toAirport = args.toAirport.trim().toUpperCase();
  const departDate = args.departDate;
  const observedAt = new Date().toISOString();
  const valid = /^[A-Z]{3}$/.test(fromAirport) && /^[A-Z]{3}$/.test(toAirport) && fromAirport !== toAirport && isoDate(departDate);
  const sourceUrl = valid ? googleFlightsUrl(fromAirport, toAirport, departDate) : "https://www.google.com/travel/flights/";
  const base = { currency: "USD" as const, fromAirport, toAirport, departDate, observedAt, sourceUrl };
  if (!valid) return { ...base, status: "error", via: "validation", ms: 0, note: "A valid, distinct airport pair and calendar departure date are required." };

  const timeoutMs = Math.min(30_000, Math.max(3_000, args.timeoutMs ?? 10_000));
  const started = Date.now();
  const datasetId = process.env.BRIGHTDATA_GOOGLE_FLIGHTS_DATASET_ID || GOOGLE_FLIGHTS_DATASET;
  const requestedSnapshot = args.snapshotId;
  const queryKey = `${fromAirport}:${toAirport}:${departDate}`;
  for (const [id, binding] of snapshotQueries) if (binding.expires <= started) snapshotQueries.delete(id);
  const existing = requestedSnapshot ? snapshotQueries.get(requestedSnapshot) : undefined;
  if (existing && existing.query !== queryKey) return { ...base, status: "error", via: "validation", ms: 0, note: "This fare collection belongs to a different airport pair or departure date." };
  const trigger = requestedSnapshot
    ? { status: "ok" as const, body: { snapshotId: requestedSnapshot }, attempts: 0, ms: 0 }
    : await triggerDataset(datasetId, [{ url: sourceUrl }], Math.min(5_000, timeoutMs));
  const snapshotId = trigger.body?.snapshotId;
  if (!requestedSnapshot && snapshotId) {
    if (snapshotQueries.size >= 1_000) snapshotQueries.delete(snapshotQueries.keys().next().value!);
    snapshotQueries.set(snapshotId, { query: queryKey, expires: started + 3_600_000 });
  }
  let collectionState = "starting";
  let datasetNote: string | undefined;
  if (trigger.status === "ok" && snapshotId) {
    let checks = 0;
    while (Date.now() - started < timeoutMs - 700) {
      checks += 1;
      const remaining = timeoutMs - (Date.now() - started);
      const snapshot = await readDatasetSnapshot<unknown>(snapshotId, Math.min(4_000, remaining));
      collectionState = snapshot.body?.state ?? collectionState;
      if ((snapshot.status === "ok" || snapshot.status === "empty") && snapshot.body?.records) {
        const best = candidatesFromDataset(snapshot.body.records, { fromAirport, toAirport, departDate }, Boolean(requestedSnapshot && !existing))[0];
        if (!best) {
          collectionState = "ready";
          datasetNote = "The structured collection completed without a verifiable USD fare.";
          break;
        }
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
    if (!datasetNote) return { ...base, status: "timeout", snapshotId, collectionState, via: "Bright Data Google Flights scraper", ms: Date.now() - started, note: "The live fare is still being collected. S’mile will keep checking this snapshot." };
  }

  const remaining = datasetNote ? Math.max(8_000, timeoutMs - (Date.now() - started)) : timeoutMs - (Date.now() - started);
  if (remaining < 1_500) return { ...base, status: trigger.status, via: "Bright Data Google Flights scraper", ms: Date.now() - started, note: trigger.error ?? "The live collection could not be started." };
  const page = await unlock(sourceUrl, "markdown", { attempts: 1, timeoutMs: remaining });
  if (page.status === "ok" && page.body && llmAvailable()) {
    const text = pageText(page.body);
    try {
      const extracted = await structured(ExtractedQuote, {
        model: "extract",
        system: "Extract the lowest currently displayed bookable USD fare for one adult, economy, one-way, for the exact airport pair and departure date. Identify the airports and calendar departure date from the page and return null when they cannot be verified or differ from the request. Use only a price explicitly present in the supplied Google Flights page text. Copy the exact contiguous price phrase. Do not estimate, convert currency, combine fees, or use an unrelated route, date, historical typical-price statistic, baggage fee, or loyalty points.",
        user: JSON.stringify({ fromAirport, toAirport, departDate, page: text }),
        effort: "low",
      });
      if (extracted.amountUsd && extracted.exactQuote && extracted.fromAirport === fromAirport && extracted.toAirport === toAirport && extracted.departDate === departDate && quoteContainsUsdAmount(extracted.exactQuote, extracted.amountUsd) && text.toLowerCase().includes(extracted.exactQuote.toLowerCase())) {
        return { ...base, status: "ok", amountUsd: extracted.amountUsd, provider: extracted.provider ?? "Google Flights", scope: extracted.scope ?? "Lowest visible fare for this route and date", via: "Bright Data Web Unlocker → grounded extraction", ms: Date.now() - started, snapshotId, collectionState };
      }
    } catch {
      // The result below preserves the source failure without inventing a price.
    }
  }

  const note = [datasetNote, trigger.error, page.error, page.status === "ok" ? "No exact route-and-date fare could be verified in the returned page." : undefined].filter(Boolean).join("; ");
  return { ...base, status: trigger.status === "timeout" || page.status === "timeout" ? "timeout" : trigger.status === "blocked" || page.status === "blocked" ? "blocked" : "empty", via: "Bright Data Google Flights scraper + Web Unlocker fallback", ms: Date.now() - started, snapshotId, collectionState, note };
}
