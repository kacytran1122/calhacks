import type { FetchStatus } from "../types";
import { brightDataKey, unlock } from "./brightdata";

export interface SourceResult<T> {
  source: "luma" | "devpost" | "mlh";
  status: FetchStatus;
  via: "bright-data" | "direct";
  items: T[];
  ms: number;
  note?: string;
}

async function direct(url: string, timeoutMs = 20_000): Promise<{ status: FetchStatus; body?: string; note?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (smile-hackathon-planner)", Accept: "text/html,application/json" } });
    const body = await res.text();
    if (res.status === 403 || res.status === 429) return { status: "blocked", note: `HTTP ${res.status}` };
    if (!res.ok) return { status: "error", note: `HTTP ${res.status}` };
    return body.length ? { status: "ok", body } : { status: "empty" };
  } catch (e) {
    return { status: (e as Error).name === "AbortError" ? "timeout" : "error", note: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

export async function getPublic(url: string): Promise<{ status: FetchStatus; body?: string; via: "bright-data" | "direct"; note?: string }> {
  if (brightDataKey()) {
    const r = await unlock(url);
    if (r.status === "ok" && r.body) return { status: "ok", body: r.body, via: "bright-data" };
    const d = await direct(url);
    return { ...d, via: "direct", note: `Bright Data: ${r.status}${r.errorCode ? ` (${r.errorCode})` : ""}; direct fetch: ${d.status}` };
  }
  return { ...(await direct(url)), via: "direct" };
}

export interface LumaEvent {
  id: string;
  name: string;
  startsAt: string;
  endsAt?: string;
  url: string;
  city?: string;
  venue?: string;
  lat?: number;
  lon?: number;
  calendar?: string;
  guests?: number;
  online: boolean;
}

export async function fetchLuma(lat: number, lon: number, pages = 3): Promise<SourceResult<LumaEvent>> {
  const t0 = Date.now();
  const items: LumaEvent[] = [];
  let cursor: string | undefined;
  let via: "bright-data" | "direct" = "direct";
  let status: FetchStatus = "ok";
  let note: string | undefined;
  for (let p = 0; p < pages; p++) {
    const url = `https://api.lu.ma/discover/get-paginated-events?latitude=${lat}&longitude=${lon}&pagination_limit=50${cursor ? `&pagination_cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await getPublic(url);
    via = r.via;
    if (r.status !== "ok" || !r.body) {
      if (p === 0) {
        status = r.status;
        note = r.note;
      }
      break;
    }
    type Entry = { event: { api_id: string; name: string; start_at: string; end_at?: string; url: string; location_type?: string; geo_address_info?: { city_state?: string; address?: string; full_address?: string }; coordinate?: { latitude: number; longitude: number } }; calendar?: { name?: string }; guest_count?: number };
    let json: { entries?: Entry[]; has_more?: boolean; next_cursor?: string };
    try {
      json = JSON.parse(r.body);
    } catch {
      status = p === 0 ? "error" : status;
      note = "Luma response was not JSON";
      break;
    }
    for (const e of json.entries ?? []) {
      const ev = e.event;
      items.push({
        id: `luma:${ev.api_id}`,
        name: ev.name,
        startsAt: ev.start_at,
        endsAt: ev.end_at,
        url: `https://lu.ma/${ev.url}`,
        city: ev.geo_address_info?.city_state,
        venue: ev.geo_address_info?.address,
        lat: ev.coordinate?.latitude,
        lon: ev.coordinate?.longitude,
        calendar: e.calendar?.name,
        guests: e.guest_count,
        online: ev.location_type !== "offline",
      });
    }
    if (!json.has_more || !json.next_cursor) break;
    cursor = json.next_cursor;
  }
  return { source: "luma", status: items.length ? "ok" : status === "ok" ? "empty" : status, via, items, ms: Date.now() - t0, note };
}

export interface DevpostHackathon {
  id: string;
  name: string;
  url: string;
  location: string;
  dates: string;
  startsAt?: string;
  themes: string[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseDevpostStart(dates: string): string | undefined {
  const m = dates.match(/([A-Za-z]{3})\s+(\d{1,2})/);
  const y = dates.match(/(\d{4})\s*$/);
  if (!m || !y) return undefined;
  const mon = MONTHS.indexOf(m[1]!.toLowerCase());
  if (mon < 0) return undefined;
  const endMon = [...dates.matchAll(/([A-Za-z]{3})\s+\d/g)].map((x) => MONTHS.indexOf(x[1]!.toLowerCase())).pop() ?? mon;
  const year = Number(y[1]) - (endMon < mon ? 1 : 0);
  return new Date(Date.UTC(year, mon, Number(m[2]), 12)).toISOString();
}

export async function fetchDevpost(pages = 3): Promise<SourceResult<DevpostHackathon>> {
  const t0 = Date.now();
  const items: DevpostHackathon[] = [];
  let via: "bright-data" | "direct" = "direct";
  let status: FetchStatus = "ok";
  let note: string | undefined;
  for (let p = 1; p <= pages; p++) {
    const r = await getPublic(`https://devpost.com/api/hackathons?challenge_type[]=in-person&status[]=upcoming&status[]=open&per_page=40&page=${p}`);
    via = r.via;
    if (r.status !== "ok" || !r.body) {
      if (p === 1) {
        status = r.status;
        note = r.note;
      }
      break;
    }
    type H = { id: number; title: string; url: string; displayed_location?: { location?: string }; submission_period_dates?: string; themes?: { name: string }[] };
    let json: { hackathons?: H[]; meta?: { total_count?: number; per_page?: number } };
    try {
      json = JSON.parse(r.body);
    } catch {
      note = "Devpost response was not JSON";
      if (p === 1) status = "error";
      break;
    }
    for (const h of json.hackathons ?? []) {
      const dates = h.submission_period_dates ?? "";
      items.push({ id: `devpost:${h.id}`, name: h.title, url: h.url, location: h.displayed_location?.location ?? "", dates, startsAt: parseDevpostStart(dates), themes: (h.themes ?? []).map((t) => t.name) });
    }
    const total = json.meta?.total_count ?? 0;
    if (p * (json.meta?.per_page ?? 40) >= total) break;
  }
  return { source: "devpost", status: items.length ? "ok" : status === "ok" ? "empty" : status, via, items, ms: Date.now() - t0, note };
}

export interface MlhEvent {
  id: string;
  name: string;
  startsAt: string;
  endsAt?: string;
  url: string;
  location: string;
  physical: boolean;
}

export function resolveMlhEventUrl(event: { slug: string; url?: string; websiteUrl?: string }): string {
  const website = event.websiteUrl?.trim();
  if (website && /^https?:\/\//i.test(website)) return website;
  const listing = event.url?.trim();
  if (listing && /^https?:\/\//i.test(listing)) return listing;
  return `https://www.mlh.com${listing || `/events/${event.slug}`}`;
}

function decodeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function mlhSeason(now = new Date()): number {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

export async function fetchMlh(now = new Date()): Promise<SourceResult<MlhEvent>> {
  const t0 = Date.now();
  const url = `https://www.mlh.com/seasons/${mlhSeason(now)}/events`;
  const r = await getPublic(url);
  if (r.status !== "ok" || !r.body) return { source: "mlh", status: r.status, via: r.via, items: [], ms: Date.now() - t0, note: r.note };
  const tag = r.body.match(/<script[^>]*data-page="app"[^>]*>([\s\S]*?)<\/script>/);
  const attr = tag ? null : r.body.match(/data-page="(\{[^"]+)"/);
  const raw = tag ? tag[1]! : attr ? decodeAttr(attr[1]!) : null;
  if (!raw) return { source: "mlh", status: "empty", via: r.via, items: [], ms: Date.now() - t0, note: "MLH page layout changed: no embedded event data" };
  type E = { id: string; slug: string; name: string; startsAt: string; endsAt?: string; url?: string; websiteUrl?: string; location?: string; formatType?: string };
  let props: { upcomingEvents?: E[] };
  try {
    props = (JSON.parse(raw) as { props?: { upcomingEvents?: E[] } }).props ?? {};
  } catch {
    return { source: "mlh", status: "error", via: r.via, items: [], ms: Date.now() - t0, note: "MLH embedded data was not JSON" };
  }
  const items = (props.upcomingEvents ?? []).map((e) => ({
    id: `mlh:${e.slug}`,
    name: e.name.trim(),
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    url: resolveMlhEventUrl(e),
    location: e.location ?? "",
    physical: e.formatType !== "digital",
  }));
  return { source: "mlh", status: items.length ? "ok" : "empty", via: r.via, items, ms: Date.now() - t0 };
}
