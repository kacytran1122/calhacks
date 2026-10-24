export type EventChoice = {
  name: string;
  url: string;
  location: string;
  startsAt?: string;
  imageUrl?: string;
  lat?: number;
  lon?: number;
};

const hackathonLocations: Array<[RegExp, string]> = [
  [/\bhacktx\b/i, "Austin, TX"],
  [/\bcal\s*hacks?\b/i, "San Francisco, CA"],
  [/\bla\s*hacks?\b/i, "Los Angeles, CA"],
  [/\btamuhack\b/i, "College Station, TX"],
  [/\bhackutd\b/i, "Richardson, TX"],
  [/\browdyhacks\b/i, "San Antonio, TX"],
  [/\bhackrice\b/i, "Houston, TX"],
  [/\bboilermake\b/i, "West Lafayette, IN"],
  [/\bhackillinois\b/i, "Champaign, IL"],
  [/\bmhacks\b/i, "Ann Arbor, MI"],
  [/\bhackprinceton\b/i, "Princeton, NJ"],
  [/\bhackharvard\b/i, "Cambridge, MA"],
  [/\btechnica\b/i, "College Park, MD"],
];

export function locationFromHackathonName(name: string) {
  return hackathonLocations.find(([pattern]) => pattern.test(name))?.[1] ?? "";
}

function absoluteImageUrl(value: string | undefined, pageUrl: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value, pageUrl);
    return /^(https?:|data:)/.test(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function pageImage(source: Document, pageUrl: string) {
  const preferred = source.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content
    || source.querySelector<HTMLMetaElement>('meta[name="twitter:image"]')?.content
    || source.querySelector<HTMLMetaElement>('meta[property="twitter:image"]')?.content;
  const eventImage = Array.from(source.images).find((image) => /hack|event|logo|landing|hero/i.test(`${image.alt} ${image.className} ${image.id}`) && image.currentSrc)
    || Array.from(source.images).find((image) => image.currentSrc && image.naturalWidth >= 160 && image.naturalHeight >= 90);
  const icon = source.querySelector<HTMLLinkElement>('link[rel~="apple-touch-icon"], link[rel~="icon"]')?.getAttribute("href") || undefined;
  return absoluteImageUrl(preferred || eventImage?.currentSrc || eventImage?.src || icon || "/favicon.ico", pageUrl);
}

function metaContent(scope: ParentNode, property: string) {
  return scope.querySelector<HTMLMetaElement>(`meta[itemprop="${property}"]`)?.content?.trim();
}

export function mlhEvents(source: Document = document) {
  return Array.from(source.querySelectorAll<HTMLAnchorElement>('a[itemtype="https://schema.org/Event"]')).map((card) => {
    const city = metaContent(card, "addressLocality");
    const region = metaContent(card, "addressRegion");
    const country = metaContent(card, "addressCountry");
    const name = card.querySelector("h4")?.textContent?.trim() || metaContent(card, "name") || "MLH event";
    return {
      name,
      url: metaContent(card, "url") || card.href,
      location: [city, region, country].filter(Boolean).join(", "),
      startsAt: metaContent(card, "startDate"),
      imageUrl: metaContent(card, "image") || card.querySelector<HTMLImageElement>('img[alt*="logo"]')?.src,
    } satisfies EventChoice;
  }).filter((event) => event.url && event.location);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function pageEvents(source: Document = document, pageUrl = location.href) {
  const nodes: unknown[] = [];
  source.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      nodes.push(JSON.parse(script.textContent || ""));
    } catch {}
  });
  const flat: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    const value = objectValue(node);
    if (!value) return;
    flat.push(value);
    if (value["@graph"]) walk(value["@graph"]);
  };
  nodes.forEach(walk);
  const events = flat.filter((node) => {
    const values = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    return values.some((value) => typeof value === "string" && /event|hackathon/i.test(value));
  }).map((node) => {
    const rawLocation = Array.isArray(node.location) ? node.location[0] : node.location;
    const eventLocation = objectValue(rawLocation);
    const address = objectValue(eventLocation?.address);
    const geo = objectValue(eventLocation?.geo);
    const locationText = typeof rawLocation === "string"
      ? rawLocation
      : [eventLocation?.name, typeof eventLocation?.address === "string" ? eventLocation.address : undefined, address?.streetAddress, address?.addressLocality, address?.addressRegion, address?.postalCode, address?.addressCountry].filter(Boolean).join(", ");
    const eventUrl = typeof node.url === "string" ? node.url : pageUrl;
    const rawImage = Array.isArray(node.image) ? node.image[0] : node.image;
    return {
      name: typeof node.name === "string" ? node.name : source.title,
      url: eventUrl,
      location: locationText,
      startsAt: typeof node.startDate === "string" ? node.startDate : undefined,
      imageUrl: absoluteImageUrl(typeof rawImage === "string" ? rawImage : undefined, pageUrl) || pageImage(source, pageUrl),
      lat: geo?.latitude !== undefined ? Number(geo.latitude) : undefined,
      lon: geo?.longitude !== undefined ? Number(geo.longitude) : undefined,
    } satisfies EventChoice;
  }).filter((event) => event.name && event.url);
  if (events.length) return events;
  return [{
    name: source.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content || source.title || "This hackathon",
    url: pageUrl,
    location: locationFromHackathonName(source.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content || source.title || ""),
    imageUrl: pageImage(source, pageUrl),
  } satisfies EventChoice];
}
