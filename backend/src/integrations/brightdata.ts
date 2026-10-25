import type { FetchStatus } from "../types";

const API = "https://api.brightdata.com";

export interface BdResult<T = string> {
  status: FetchStatus;
  body?: T;
  attempts: number;
  ms: number;
  errorCode?: string;
  error?: string;
}

export function brightDataKey(): string | undefined {
  return process.env.BRIGHTDATA_API_TOKEN || process.env.BRIGHTDATA_API_KEY || undefined;
}

type ZoneType = "unblocker" | "serp";
type ActiveZone = { name: string; type: string };
const zoneCache = new Map<ZoneType, string>();
const zonePromiseCache = new Map<ZoneType, Promise<string>>();

export function selectActiveZone(zones: ActiveZone[], type: ZoneType): string | undefined {
  const accepted = type === "unblocker" ? new Set(["unblocker", "web_unlocker"]) : new Set(["serp"]);
  return zones.find((candidate) => accepted.has(candidate.type.toLowerCase()))?.name;
}

async function zone(key: string, type: ZoneType): Promise<string> {
  const configured = type === "unblocker"
    ? process.env.BRIGHTDATA_UNLOCKER_ZONE || process.env.BRIGHTDATA_ZONE
    : process.env.BRIGHTDATA_SERP_ZONE;
  if (configured) return configured;
  const cached = zoneCache.get(type);
  if (cached) return cached;
  const running = zonePromiseCache.get(type);
  if (running) return running;
  const lookup = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetch(`${API}/zone/get_active_zones`, { signal: ctrl.signal, headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(`zone lookup failed: HTTP ${res.status}`);
      const name = selectActiveZone((await res.json()) as ActiveZone[], type);
      if (!name) throw new Error(`no active ${type === "unblocker" ? "Web Unlocker" : "SERP API"} zone on this Bright Data account`);
      zoneCache.set(type, name);
      return name;
    } finally {
      clearTimeout(timer);
    }
  })();
  zonePromiseCache.set(type, lookup);
  try {
    return await lookup;
  } finally {
    zonePromiseCache.delete(type);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request(
  url: string,
  extra: Record<string, string>,
  { attempts = 3, timeoutMs = 45_000, minBytes = 200, zoneType = "unblocker" as ZoneType } = {},
): Promise<BdResult> {
  const key = brightDataKey();
  const t0 = Date.now();
  if (!key) return { status: "error", attempts: 0, ms: 0, error: "BRIGHTDATA_API_TOKEN is not set" };
  let lastCode: string | undefined;
  let lastErr: string | undefined;
  let lastStatus: FetchStatus = "error";
  for (let i = 1; i <= attempts; i++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const zoneName = await zone(key, zoneType);
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${API}/request`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          zone: zoneName,
          url,
          format: "raw",
          ...(zoneType === "unblocker" ? { country: "us" } : {}),
          ...extra,
        }),
      });
      const body = await res.text();
      lastCode = res.headers.get("x-brd-error-code") ?? undefined;
      if (res.ok && body.length >= minBytes) return { status: "ok", body, attempts: i, ms: Date.now() - t0 };
      lastErr = res.headers.get("x-brd-error") ?? `HTTP ${res.status}, ${body.length} bytes`;
      lastStatus = lastCode || res.status === 403 || res.status === 429 ? "blocked" : res.ok ? "empty" : "error";
    } catch (e) {
      const timedOut = (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError";
      lastStatus = timedOut ? "timeout" : "error";
      lastErr = timedOut ? `Bright Data did not respond within ${Math.round(timeoutMs / 1000)} seconds` : (e as Error).message;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (i < attempts) await sleep(1500 * i);
  }
  return { status: lastStatus, attempts, ms: Date.now() - t0, errorCode: lastCode, error: lastErr };
}

export function unlock(url: string, format: "html" | "markdown" = "html", options?: { attempts?: number; timeoutMs?: number }): Promise<BdResult> {
  return request(url, format === "markdown" ? { data_format: "markdown" } : {}, options);
}

export async function scrapeDataset<T = unknown>(datasetId: string, input: Record<string, unknown>[], timeoutMs = 12_000): Promise<BdResult<T>> {
  const key = brightDataKey();
  const t0 = Date.now();
  if (!key) return { status: "error", attempts: 0, ms: 0, error: "BRIGHTDATA_API_TOKEN is not set" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({ dataset_id: datasetId, format: "json", include_errors: "true" });
    const res = await fetch(`${API}/datasets/v3/scrape?${params}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const text = await res.text();
    if (res.status === 202) {
      let snapshotId: string | undefined;
      try {
        snapshotId = (JSON.parse(text) as { snapshot_id?: string }).snapshot_id;
      } catch {
        snapshotId = undefined;
      }
      return { status: "timeout", attempts: 1, ms: Date.now() - t0, error: snapshotId ? `Bright Data is still collecting snapshot ${snapshotId}` : "Bright Data is still collecting this result" };
    }
    if (!res.ok) return { status: res.status === 403 || res.status === 429 ? "blocked" : "error", attempts: 1, ms: Date.now() - t0, error: `Bright Data scraper HTTP ${res.status}: ${text.slice(0, 240)}` };
    try {
      const body = JSON.parse(text) as T;
      const empty = Array.isArray(body) && body.length === 0;
      return { status: empty ? "empty" : "ok", body, attempts: 1, ms: Date.now() - t0 };
    } catch {
      return { status: "error", attempts: 1, ms: Date.now() - t0, error: "Bright Data scraper response was not JSON" };
    }
  } catch (e) {
    const timedOut = (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError";
    return { status: timedOut ? "timeout" : "error", attempts: 1, ms: Date.now() - t0, error: timedOut ? `Bright Data did not return Google Flights data within ${Math.round(timeoutMs / 1000)} seconds` : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export async function triggerDataset(datasetId: string, input: Record<string, unknown>[], timeoutMs = 5_000): Promise<BdResult<{ snapshotId: string }>> {
  const key = brightDataKey();
  const t0 = Date.now();
  if (!key) return { status: "error", attempts: 0, ms: 0, error: "BRIGHTDATA_API_TOKEN is not set" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({ dataset_id: datasetId, format: "json", notify: "false", include_errors: "true" });
    const res = await fetch(`${API}/datasets/v3/trigger?${params}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const text = await res.text();
    if (!res.ok) return { status: res.status === 403 || res.status === 429 ? "blocked" : "error", attempts: 1, ms: Date.now() - t0, error: `Bright Data trigger HTTP ${res.status}: ${text.slice(0, 240)}` };
    const snapshotId = (JSON.parse(text) as { snapshot_id?: string }).snapshot_id;
    if (!snapshotId || !/^s(?:d)?_[A-Za-z0-9]+$/.test(snapshotId)) return { status: "error", attempts: 1, ms: Date.now() - t0, error: "Bright Data did not return a valid snapshot ID" };
    return { status: "ok", body: { snapshotId }, attempts: 1, ms: Date.now() - t0 };
  } catch (e) {
    const timedOut = (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError";
    return { status: timedOut ? "timeout" : "error", attempts: 1, ms: Date.now() - t0, error: timedOut ? "Bright Data did not start the collection within five seconds" : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export async function readDatasetSnapshot<T = unknown>(snapshotId: string, timeoutMs = 5_000): Promise<BdResult<{ snapshotId: string; state: string; records?: T }>> {
  const key = brightDataKey();
  const t0 = Date.now();
  if (!key) return { status: "error", attempts: 0, ms: 0, error: "BRIGHTDATA_API_TOKEN is not set" };
  if (!/^s(?:d)?_[A-Za-z0-9]+$/.test(snapshotId)) return { status: "error", attempts: 0, ms: 0, error: "Invalid Bright Data snapshot ID" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const progressResponse = await fetch(`${API}/datasets/v3/progress/${snapshotId}`, { signal: ctrl.signal, headers: { Authorization: `Bearer ${key}` } });
    if (!progressResponse.ok) return { status: progressResponse.status === 403 || progressResponse.status === 429 ? "blocked" : "error", attempts: 1, ms: Date.now() - t0, error: `Bright Data progress HTTP ${progressResponse.status}` };
    const progress = await progressResponse.json() as { status?: string; error_message?: string };
    if (progress.status !== "ready") {
      const failed = progress.status === "failed" || progress.status === "canceled";
      return { status: failed ? "error" : "timeout", body: { snapshotId, state: progress.status ?? "running" }, attempts: 1, ms: Date.now() - t0, error: failed ? progress.error_message ?? `Bright Data snapshot ${progress.status}` : undefined };
    }
    const resultResponse = await fetch(`${API}/datasets/v3/snapshot/${snapshotId}?format=json`, { signal: ctrl.signal, headers: { Authorization: `Bearer ${key}` } });
    const text = await resultResponse.text();
    if (!resultResponse.ok) return { status: resultResponse.status === 403 || resultResponse.status === 429 ? "blocked" : "error", attempts: 1, ms: Date.now() - t0, error: `Bright Data snapshot HTTP ${resultResponse.status}: ${text.slice(0, 240)}` };
    const records = JSON.parse(text) as T;
    return { status: Array.isArray(records) && records.length === 0 ? "empty" : "ok", body: { snapshotId, state: "ready", records }, attempts: 1, ms: Date.now() - t0 };
  } catch (e) {
    const timedOut = (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError";
    return { status: timedOut ? "timeout" : "error", attempts: 1, ms: Date.now() - t0, error: timedOut ? "Bright Data snapshot status timed out" : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export interface SerpOrganic {
  link: string;
  title: string;
  description?: string;
  display_link?: string;
  rank?: number;
}

export async function serp(query: string, attempts = 3, timeoutMs = 12_000): Promise<BdResult<SerpOrganic[]>> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us`;
  let last: BdResult = { status: "error", attempts: 0, ms: 0 };
  let used = 0;
  const t0 = Date.now();
  for (let i = 0; i < attempts; i++) {
    last = await request(url, { data_format: "parsed_light" }, { attempts: 1, timeoutMs, minBytes: 2, zoneType: "serp" });
    used++;
    if (last.status === "ok" && last.body) {
      try {
        const json = JSON.parse(last.body) as { organic?: SerpOrganic[] };
        const organic = json.organic ?? [];
        return { status: organic.length ? "ok" : "empty", body: organic, attempts: used, ms: Date.now() - t0 };
      } catch {
        last = { ...last, status: "error", error: "SERP body was not JSON" };
      }
    }
    if (last.status === "error" && last.error?.includes("not set")) break;
    if (i < attempts - 1) await sleep(1200);
  }
  return { status: last.status, attempts: used, ms: Date.now() - t0, errorCode: last.errorCode, error: last.error };
}
