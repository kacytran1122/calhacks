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

let zoneCache: string | undefined;
async function zone(key: string): Promise<string> {
  if (process.env.BRIGHTDATA_ZONE) return process.env.BRIGHTDATA_ZONE;
  if (zoneCache) return zoneCache;
  const res = await fetch(`${API}/zone/get_active_zones`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`zone lookup failed: HTTP ${res.status}`);
  const zones = (await res.json()) as { name: string; type: string }[];
  const z = zones.find((x) => x.type === "unblocker");
  if (!z) throw new Error("no Web Unlocker zone on this Bright Data account — add one in the control panel");
  zoneCache = z.name;
  return z.name;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request(
  url: string,
  extra: Record<string, string>,
  { attempts = 3, timeoutMs = 45_000, minBytes = 200 } = {},
): Promise<BdResult> {
  const key = brightDataKey();
  const t0 = Date.now();
  if (!key) return { status: "error", attempts: 0, ms: 0, error: "BRIGHTDATA_API_TOKEN is not set" };
  let lastCode: string | undefined;
  let lastErr: string | undefined;
  let lastStatus: FetchStatus = "error";
  for (let i = 1; i <= attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API}/request`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ zone: await zone(key), url, format: "raw", country: "us", ...extra }),
      });
      const body = await res.text();
      lastCode = res.headers.get("x-brd-error-code") ?? undefined;
      if (res.ok && body.length >= minBytes) return { status: "ok", body, attempts: i, ms: Date.now() - t0 };
      lastErr = res.headers.get("x-brd-error") ?? `HTTP ${res.status}, ${body.length} bytes`;
      lastStatus = lastCode || res.status === 403 || res.status === 429 ? "blocked" : res.ok ? "empty" : "error";
    } catch (e) {
      lastStatus = (e as Error).name === "AbortError" ? "timeout" : "error";
      lastErr = (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts) await sleep(1500 * i);
  }
  return { status: lastStatus, attempts, ms: Date.now() - t0, errorCode: lastCode, error: lastErr };
}

export function unlock(url: string, format: "html" | "markdown" = "html"): Promise<BdResult> {
  return request(url, format === "markdown" ? { data_format: "markdown" } : {});
}

export interface SerpOrganic {
  link: string;
  title: string;
  description?: string;
  display_link?: string;
  rank?: number;
}

export async function serp(query: string, attempts = 3): Promise<BdResult<SerpOrganic[]>> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us&brd_json=1`;
  let last: BdResult = { status: "error", attempts: 0, ms: 0 };
  let used = 0;
  const t0 = Date.now();
  for (let i = 0; i < attempts; i++) {
    last = await request(url, {}, { attempts: 1, minBytes: 2 });
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
    await sleep(1200);
  }
  return { status: last.status, attempts: used, ms: Date.now() - t0, errorCode: last.errorCode, error: last.error };
}
