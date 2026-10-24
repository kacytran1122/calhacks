import type { TransitOption } from "./transitous";

const METROLINK_FARES = "https://metrolinktrains.com/ticketsOverview/ticket-info/ticket-types-old/";
const USER_AGENT = "Smile/0.1 (+https://github.com/kacytran1122/calhacks)";

export interface OfficialFare {
  mode: "train" | "bus";
  amountUsd: number;
  link: string;
  quote: string;
  routeTitle?: string;
}

function pageText(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export function metrolinkFareFromPage(html: string, startsAt?: string, routeTitle?: string): OfficialFare | undefined {
  const text = pageText(html);
  const hasCurrentPrices = /Weekdays:\s*\$19/i.test(text) && /Saturdays\s*&\s*Sundays:\s*\$12/i.test(text) && /free transfers to most local transit providers/i.test(text);
  if (!hasCurrentPrices) return undefined;
  const date = startsAt ? new Date(startsAt) : new Date();
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/Los_Angeles" }).format(date);
  const weekend = weekday === "Sat" || weekday === "Sun";
  const amountUsd = weekend ? 12 : 19;
  return {
    mode: "train",
    amountUsd,
    link: METROLINK_FARES,
    quote: `Metrolink SoCal Day Pass: $${amountUsd.toFixed(2)} on ${weekend ? "weekends and holidays" : "weekdays"}; the official page includes free transfers to most connecting local transit.`,
    routeTitle,
  };
}

async function officialPage(url: string, timeoutMs = 4_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function currentOfficialFares(options: TransitOption[], startsAt?: string): Promise<OfficialFare[]> {
  const metrolinkRoute = options.find((option) => option.agencies.some((agency) => /metrolink/i.test(agency)));
  if (!metrolinkRoute) return [];
  const html = await officialPage(METROLINK_FARES);
  const fare = html ? metrolinkFareFromPage(html, startsAt, metrolinkRoute.title) : undefined;
  return fare ? [fare] : [];
}
