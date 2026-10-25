export type VenueTourEvent = { name: string; url: string; city?: string; venue?: string };

export function venueTourFor(event: VenueTourEvent): { href: string; venue: string } | null {
  const name = event.name.normalize("NFKC").trim().toLowerCase();
  const byName = /^la\s*hacks(?:\s|\d|$)/.test(name) ? "la" : /^cal\s*hacks(?:\s|\d|$)/.test(name) ? "cal" : undefined;
  let bySite: "la" | "cal" | undefined;
  try {
    const url = new URL(event.url);
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "lahacks.com" || host.endsWith(".lahacks.com")) bySite = "la";
    if (host === "calhacks.io" || host.endsWith(".calhacks.io")) bySite = "cal";
  } catch { return null; }
  if (byName && bySite && byName !== bySite) return null;
  const eventId = byName ?? bySite;
  if (eventId === "la") return { href: "/tour", venue: "James West Alumni Center concept" };
  if (eventId === "cal") return { href: "/venue", venue: "Palace of Fine Arts concept" };
  return null;
}

export function contributionUrl(event: VenueTourEvent): string {
  const query = new URLSearchParams({ event: event.name, url: event.url });
  const location = [event.venue, event.city].filter(Boolean).join(", ");
  if (location) query.set("location", location);
  return `/tours/contribute?${query}`;
}
