import { eventStore, type EventListing } from "../eventStore";
import { cityToPoint, haversineMiles, zipToPoint } from "../integrations/geo";
import { fetchDevpost, fetchLuma, fetchMlh, type SourceResult } from "../integrations/sources";

export interface DiscoverOptions {
  zip: string;
  radiusMiles?: number;
  query?: string;
  kinds?: EventListing["kind"][];
  groups?: EventGroup[];
  days?: number;
  now?: Date;
}

export type EventGroup = "mlh" | "tech";

export function isMlhEvent(event: Pick<EventListing, "source" | "alsoOn">): boolean {
  return event.source === "mlh" || event.alsoOn?.includes("mlh") === true;
}

export function matchesEventGroups(event: Pick<EventListing, "source" | "alsoOn" | "kind">, groups?: EventGroup[]): boolean {
  if (!groups?.length) return true;
  return (groups.includes("mlh") && isMlhEvent(event)) || (groups.includes("tech") && event.kind === "tech");
}

export interface DiscoverResult {
  origin: { zip: string; label?: string; lat: number; lon: number };
  radiusMiles: number;
  events: EventListing[];
  outsideRadius: EventListing[];
  unplaced: EventListing[];
  sources: { source: string; status: string; via: string; count: number; ms: number; note?: string }[];
  store: "tigerdata" | "local";
  storeNote?: string;
  classifiedBy: "claude" | "keywords";
}

export function splitEventMatches(events: EventListing[], radiusMiles: number) {
  const placed = events.filter((event) => event.distanceMiles !== undefined);
  return {
    events: placed.filter((event) => event.distanceMiles! <= radiusMiles),
    outsideRadius: placed.filter((event) => event.distanceMiles! > radiusMiles).sort((a, b) => a.distanceMiles! - b.distanceMiles!),
  };
}

const TECH = /\b(ai|a\.i\.|ml|llms?|gpt|genai|agents?|tech|startups?|founders?|developers?|devs?|code|coding|engineer(ing)?|data|cloud|web3|crypto|blockchain|robot(ics)?|build(ers|ing)?|product|ux|saas|cyber|security|python|javascript|react|open[- ]source|demo day|pitch|venture|vc|hardware|software|quantum)\b/i;
const HACK = /hack|hackathon|buildathon|game jam|datathon|ideathon/i;

const HUBS = [
  { name: "San Francisco", lat: 37.7749, lon: -122.4194 },
  { name: "San Jose", lat: 37.3382, lon: -121.8863 },
  { name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
  { name: "San Diego", lat: 32.7157, lon: -117.1611 },
  { name: "Seattle", lat: 47.6062, lon: -122.3321 },
  { name: "Austin", lat: 30.2672, lon: -97.7431 },
  { name: "Chicago", lat: 41.8781, lon: -87.6298 },
  { name: "New York", lat: 40.7128, lon: -74.006 },
  { name: "Boston", lat: 42.3601, lon: -71.0589 },
];

const norm = (s: string) => s.toLowerCase().replace(/\b(20\d\d|\d+(\.\d+)?|[ivx]+)\b/g, "").replace(/[^a-z]+/g, " ").trim();
const sameEvent = (a: EventListing, b: EventListing) => {
  const na = norm(a.name);
  const nb = norm(b.name);
  if (!na || !nb || !(na === nb || na.startsWith(nb) || nb.startsWith(na))) return false;
  if (!a.startsAt || !b.startsAt) return true;
  return Math.abs(new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()) < 3 * 86_400_000;
};

async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

export function mergeLumaSources(results: Awaited<ReturnType<typeof fetchLuma>>[], hubNames: string[]) {
  const seen = new Set<string>();
  const items = results.flatMap((result) => result.items).filter((event) => !seen.has(event.id) && seen.add(event.id));
  const failed = results.find((result) => result.status !== "ok" && result.status !== "empty");
  return {
    ...results[0]!,
    status: items.length ? "ok" as const : failed?.status ?? "empty" as const,
    via: results.some((result) => result.via === "bright-data") ? "bright-data" as const : "direct" as const,
    items,
    ms: Math.max(...results.map((result) => result.ms)),
    note: [results.map((result) => result.note).filter(Boolean).join("; ") || undefined, hubNames.length ? `also searched from ${hubNames.join(", ")}` : undefined].filter(Boolean).join("; ") || undefined,
  };
}

export async function discoverEvents(opts: DiscoverOptions): Promise<DiscoverResult> {
  const now = opts.now ?? new Date();
  const radiusMiles = opts.radiusMiles ?? 150;
  const days = opts.days ?? 90;
  const kinds = opts.kinds ?? ["hackathon", "tech"];
  const fetchedAt = now.toISOString();
  const terms = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const rawInWindow = (startsAt?: string, endsAt?: string) => {
    if (!startsAt) return false;
    return new Date(endsAt ?? startsAt).getTime() >= now.getTime() - 86_400_000 && new Date(startsAt).getTime() <= now.getTime() + days * 86_400_000;
  };
  const rawMatches = (...values: (string | undefined)[]) => !terms.length || terms.every((term) => values.join(" ").toLowerCase().includes(term));

  const home = await zipToPoint(opts.zip);
  if (home.status !== "ok") throw new Error(`couldn't find ZIP ${opts.zip} (${home.status}${home.error ? `: ${home.error}` : ""})`);
  const origin = { zip: opts.zip, label: home.label, lat: home.lat!, lon: home.lon! };

  const hubs = HUBS.filter((h) => {
    const d = haversineMiles(origin, h);
    return d > 25 && d <= radiusMiles;
  })
    .sort((a, b) => haversineMiles(origin, a) - haversineMiles(origin, b))
    .slice(0, 1);
  const [lumaHome, devpost, mlh, ...lumaHubs] = await Promise.all([
    fetchLuma(origin.lat, origin.lon),
    fetchDevpost(),
    fetchMlh(now),
    ...hubs.map((h) => fetchLuma(h.lat, h.lon)),
  ]);
  const luma = mergeLumaSources([lumaHome, ...lumaHubs], hubs.map((hub) => hub.name));
  const sources = [luma, devpost, mlh].map((r: SourceResult<unknown>) => ({ source: r.source, status: r.status, via: r.via, count: r.items.length, ms: r.ms, note: r.note }));

  const all: EventListing[] = [];
  for (const e of luma.items) {
    if (e.online || !rawInWindow(e.startsAt, e.endsAt) || !rawMatches(e.name, e.city, e.venue, e.calendar)) continue;
    all.push({
      key: e.id, source: "luma", name: e.name, startsAt: e.startsAt, endsAt: e.endsAt, city: e.city, venue: e.venue, lat: e.lat, lon: e.lon,
      locationPrecision: e.lat !== undefined ? "exact" : "unknown", url: e.url,
      thumbnailUrl: e.thumbnailUrl,
      kind: HACK.test(e.name) ? "hackathon" : TECH.test(`${e.name} ${e.calendar ?? ""}`) ? "tech" : "other",
      themes: e.calendar ? [e.calendar] : [], fetchedAt, via: luma.via,
    });
  }
  const mlhListings: EventListing[] = mlh.items
    .filter((e) => e.physical && rawInWindow(e.startsAt, e.endsAt) && rawMatches(e.name, e.location))
    .map((e) => ({ key: e.id, source: "mlh", name: e.name, startsAt: e.startsAt, endsAt: e.endsAt, city: e.location, locationPrecision: "unknown", url: e.url, thumbnailUrl: e.thumbnailUrl, kind: "hackathon", fetchedAt, via: mlh.via }));
  await pool(mlhListings, 24, async (l) => {
    const g = await cityToPoint(l.city ?? "");
    if (g.status === "ok") Object.assign(l, { lat: g.lat, lon: g.lon, locationPrecision: "city" as const });
  });
  all.push(...mlhListings);

  const devpostListings: EventListing[] = devpost.items
    .filter((h) => rawInWindow(h.startsAt) && rawMatches(h.name, h.location, ...(h.themes ?? [])))
    .map((h) => ({ key: h.id, source: "devpost", name: h.name, startsAt: h.startsAt, venue: h.location, locationPrecision: "unknown", url: h.url, thumbnailUrl: h.thumbnailUrl, kind: "hackathon", themes: h.themes, fetchedAt, via: devpost.via }));
  for (const l of devpostListings) {
    const twin = all.find((o) => o.lat !== undefined && sameEvent(o, l));
    if (twin) Object.assign(l, { lat: twin.lat, lon: twin.lon, city: twin.city, locationPrecision: twin.locationPrecision });
  }
  all.push(...devpostListings);

  const rank = { exact: 0, city: 1, unknown: 2 } as const;
  const merged: EventListing[] = [];
  for (const l of [...all].sort((a, b) => rank[a.locationPrecision] - rank[b.locationPrecision])) {
    const m = merged.find((o) => sameEvent(o, l));
    if (m) {
      if (l.source !== m.source) m.alsoOn = [...new Set([...(m.alsoOn ?? []), l.source])];
      if (l.source === "mlh") m.url = l.url;
      if (l.thumbnailUrl && (!m.thumbnailUrl || l.source === "mlh")) m.thumbnailUrl = l.thumbnailUrl;
      if (l.source === "devpost" && l.venue && !m.venue) m.venue = l.venue;
      if (l.kind === "hackathon") m.kind = "hackathon";
    } else merged.push({ ...l });
  }

  const classifiedBy = "keywords" as const;

  for (const e of merged) if (e.lat !== undefined && e.lon !== undefined) e.distanceMiles = Math.round(haversineMiles(origin, { lat: e.lat, lon: e.lon }));

  const matches = (e: EventListing) => terms.every((t) => `${e.name} ${e.city ?? ""} ${e.venue ?? ""} ${(e.themes ?? []).join(" ")}`.toLowerCase().includes(t));
  const inWindow = (e: EventListing) => {
    if (!e.startsAt) return false;
    const t = new Date(e.endsAt ?? e.startsAt).getTime();
    return t >= now.getTime() - 86_400_000 && new Date(e.startsAt).getTime() <= now.getTime() + days * 86_400_000;
  };
  const eligible = merged.filter((e) => kinds.includes(e.kind) && matchesEventGroups(e, opts.groups) && inWindow(e) && matches(e));
  const split = splitEventMatches(eligible, radiusMiles);
  const events = split.events.sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? "") || (a.distanceMiles ?? 0) - (b.distanceMiles ?? 0));
  const outsideRadius = terms.length ? split.outsideRadius.slice(0, 5) : [];
  const unplaced = terms.length ? merged.filter((e) => e.locationPrecision === "unknown" && kinds.includes(e.kind) && matchesEventGroups(e, opts.groups) && inWindow(e) && matches(e)).slice(0, 10) : [];

  const store = eventStore();
  let storeNote: string | undefined;
  try {
    const visible = [...events, ...outsideRadius, ...unplaced];
    const prev = await store.previous(visible.map((e) => e.key));
    for (const e of visible) {
      const p = prev.get(e.key);
      if (!p) continue;
      const notes: string[] = [];
      if (p.startsAt && e.startsAt && Math.abs(new Date(p.startsAt).getTime() - new Date(e.startsAt).getTime()) > 3_600_000)
        notes.push(`date moved from ${new Date(p.startsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`);
      if (p.venue && e.venue && p.venue !== e.venue) notes.push(`venue changed from "${p.venue}"`);
      if (notes.length) e.change = `${notes.join("; ")} (since ${new Date(p.fetchedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;
    }
    await store.save(visible);
  } catch (e) {
    storeNote = `snapshot not saved: ${(e as Error).message}`;
  }

  return { origin, radiusMiles, events, outsideRadius, unplaced, sources, store: store.kind, storeNote, classifiedBy };
}
