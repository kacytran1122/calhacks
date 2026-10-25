import { z } from "zod";
import { authorize } from "../permissions";
import type { State } from "../store";
import { newId } from "../store";
import type { Evidence, FetchStatus } from "../types";
import { unlock } from "../integrations/brightdata";
import { addressToPoint } from "../integrations/geo";
import { llmAvailable, structured } from "../llm";

export interface EventFacts {
  name?: string;
  startsAt?: string;
  venue?: string;
  address?: string;
  lat?: number;
  lon?: number;
  extractedBy: "json-ld" | "claude" | "lens-hints";
  verified: boolean;
}

export interface LensHints {
  title?: string;
  jsonLd?: unknown[];
  url: string;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

function flatten(nodes: unknown[]): Obj[] {
  const out: Obj[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isObj(n)) return;
    out.push(n);
    if (Array.isArray(n["@graph"])) (n["@graph"] as unknown[]).forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

const isEventType = (t: unknown) => (Array.isArray(t) ? t : [t]).some((x) => typeof x === "string" && /Event$|Hackathon/i.test(x));

export function eventFromJsonLd(nodes: unknown[]): Omit<EventFacts, "extractedBy" | "verified"> | null {
  const ev = flatten(nodes).find((n) => isEventType(n["@type"]));
  if (!ev) return null;
  const locRaw = Array.isArray(ev.location) ? ev.location[0] : ev.location;
  const loc = isObj(locRaw) ? locRaw : undefined;
  const addr = loc?.address;
  const address =
    typeof addr === "string"
      ? addr
      : isObj(addr)
        ? [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean).join(", ")
        : undefined;
  const geo = isObj(loc?.geo) ? (loc!.geo as Obj) : undefined;
  return {
    name: typeof ev.name === "string" ? ev.name : undefined,
    startsAt: typeof ev.startDate === "string" ? new Date(ev.startDate).toISOString() : undefined,
    venue: typeof loc?.name === "string" ? loc.name : typeof locRaw === "string" ? locRaw : undefined,
    address,
    lat: geo?.latitude !== undefined ? Number(geo.latitude) : undefined,
    lon: geo?.longitude !== undefined ? Number(geo.longitude) : undefined,
  };
}

export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      out.push(JSON.parse(m[1]!.trim()));
    } catch {}
  }
  return out;
}

const PageFacts = z.object({
  found: z.boolean().describe("false if this page isn't about a single in-person event"),
  name: z.string(),
  startsAtIso: z.string().describe("ISO 8601 with timezone offset, or empty if not stated"),
  venue: z.string(),
  address: z.string().describe("street address with city, or empty"),
  quotes: z.array(z.string()).describe("verbatim sentences from the page that state the date/time and the venue"),
});

const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();

export async function scoutEvent(state: State, url: string, hints?: LensHints): Promise<{ evidence: Evidence; facts?: EventFacts }> {
  authorize(state, { kind: "agent", id: "scout" }, "web.read", url);
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  const page = await unlock(url, "html");
  let facts: EventFacts | undefined;
  let status: FetchStatus = page.status;
  const notes: string[] = [`Bright Data Web Unlocker: ${page.status} after ${page.attempts} attempt(s), ${(page.ms / 1000).toFixed(1)}s${page.errorCode ? `, x-brd-error-code=${page.errorCode}` : ""}`];

  if (page.status === "ok" && page.body) {
    const ld = eventFromJsonLd(jsonLdBlocks(page.body));
    if (ld?.name && ld.startsAt) {
      facts = { ...ld, extractedBy: "json-ld", verified: true };
      notes.push("Found schema.org Event JSON-LD on the page.");
    } else if (llmAvailable()) {
      const md = await unlock(url, "markdown");
      const text = md.status === "ok" && md.body ? md.body : page.body.replace(/<[^>]+>/g, " ");
      try {
        const out = await structured(PageFacts, {
          model: "extract",
          system: "Extract the event's facts from this public web page. Quote the page verbatim for every fact. If a fact isn't on the page, leave it empty — never guess.",
          user: text.slice(0, 60_000),
          effort: "low",
        });
        const page_ = norm(text);
        const quotesOk = out.quotes.length > 0 && out.quotes.every((q) => page_.includes(norm(q)));
        if (out.found && quotesOk && out.name) {
          facts = { name: out.name, startsAt: out.startsAtIso ? new Date(out.startsAtIso).toISOString() : undefined, venue: out.venue || undefined, address: out.address || undefined, extractedBy: "claude", verified: true };
          notes.push(`No JSON-LD; Claude extracted the facts and every quote was found on the page.`);
        } else {
          status = "empty";
          notes.push(out.found ? "Claude's quotes didn't match the page text, so its answer was discarded." : "Page doesn't describe a single in-person event.");
        }
      } catch (e) {
        status = "error";
        notes.push(`Extraction failed: ${(e as Error).message}`);
      }
    } else {
      status = "empty";
      notes.push("No JSON-LD on the page and no ANTHROPIC_API_KEY to read the prose.");
    }
  }

  const hintFacts = hints?.jsonLd ? eventFromJsonLd(hints.jsonLd) : null;
  if (hintFacts?.name) {
    if (!facts) {
      facts = { ...hintFacts, extractedBy: "lens-hints", verified: false };
      notes.push("Using what Lens read from your open tab — UNVERIFIED, because Bright Data couldn't confirm the page.");
    } else if (hintFacts.startsAt && facts.startsAt && hintFacts.startsAt !== facts.startsAt) {
      notes.push(`Sources disagree: your tab says ${hintFacts.startsAt}, the fetched page says ${facts.startsAt}. Trusting the fetched page (fresher, not cached in your browser).`);
    }
  }

  if (facts && (facts.lat === undefined || facts.lon === undefined) && facts.address) {
    authorize(state, { kind: "agent", id: "scout" }, "feeds.read", facts.address);
    const g = await addressToPoint(facts.address);
    if (g.status === "ok") {
      facts.lat = g.lat;
      facts.lon = g.lon;
      notes.push(`Geocoded the venue with the ${g.source}.`);
    } else notes.push(`Couldn't geocode "${facts.address}" (${g.status}).`);
  }

  const evidence: Evidence = {
    id: newId("EV-scout"),
    kind: "event_page",
    source: `Bright Data Web Unlocker with ${host}`,
    url,
    fetchedAt: new Date().toISOString(),
    status: facts ? "ok" : status === "ok" ? "empty" : status,
    provenance: "live",
    data: { ...(facts ?? {}), attempts: page.attempts, ms: page.ms, errorCode: page.errorCode },
    note: notes.join(" "),
  };
  state.evidence.push(evidence);
  return { evidence, facts };
}
