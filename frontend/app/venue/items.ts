import { ARC, PLACES, PX_PER_M, SPONSORS, TABLES, VIEWS, ZONES, type Pt } from "./palace";
export const ORIGIN: Pt = [1000, 480];
export const toWorld = ([x, y]: Pt) => ({ x: (x - ORIGIN[0]) / PX_PER_M, z: (y - ORIGIN[1]) / PX_PER_M });
export function radial([x, y]: Pt): {
    x: number;
    z: number;
} {
    const dx = x - ARC.center[0];
    const dy = y - ARC.center[1];
    const len = Math.hypot(dx, dy);
    return { x: dx / len, z: dy / len };
}
export type ItemKind = "zone" | "place" | "sponsor";
export interface Item {
    id: string;
    kind: ItemKind;
    name: string;
    sub?: string;
    number?: number;
    at: Pt;
}
const near = (at: Pt) => ZONES.reduce((a, z) => (Math.hypot(z.at[0] - at[0], z.at[1] - at[1]) < Math.hypot(a.at[0] - at[0], a.at[1] - at[1]) ? z : a)).name;
export const ITEMS: Item[] = [
    ...ZONES.map((z, i) => ({ id: `zone-${i}`, kind: "zone" as const, name: z.name, at: z.at })),
    ...PLACES.map((p, i) => ({ id: `place-${i}`, kind: "place" as const, name: p.name, at: p.at, sub: `near ${near(p.at)}` })),
    ...SPONSORS.map((s, i) => ({ id: `sponsor-${i}`, kind: "sponsor" as const, name: s.name ?? "Sponsor table", number: s.number, at: s.at, sub: `near ${near(s.at)}` })),
];
export const HACKER_TABLES = TABLES.length;
export type SearchResult = {
    kind: "item";
    item: Item;
} | {
    kind: "view";
    view: (typeof VIEWS)[number];
} | {
    kind: "note";
    text: string;
};
export function search(query: string): SearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q)
        return [];
    const table = q.match(/^(?:hacker\s+)?table\s*#?\s*(\d+)$/) ?? q.match(/^#?(\d+)$/);
    const out: SearchResult[] = [];
    if (table) {
        const n = Number(table[1]);
        const sponsor = ITEMS.find((i) => i.kind === "sponsor" && i.number === n);
        if (sponsor)
            out.push({ kind: "item", item: sponsor });
        if (/table/.test(q) || !sponsor)
            out.push({ kind: "note", text: n >= 1 && n <= 304 ? `Hacker table numbers aren’t on the floor plan yet, so S’mile can’t point to table ${n}; ask at check-in.` : `Hacker tables are numbered 1–304.` });
        return out;
    }
    for (const view of VIEWS)
        if (view.name.toLowerCase().includes(q))
            out.push({ kind: "view", view });
    for (const item of ITEMS)
        if (item.name.toLowerCase().includes(q) || item.sub?.toLowerCase().includes(q))
            out.push({ kind: "item", item });
    if (!out.length && /mezz|upstairs|m[5-8]\b|director|coffee/.test(q))
        out.push({ kind: "note", text: "The mezzanine (upstairs) isn’t mapped yet." });
    return out.slice(0, 12);
}
