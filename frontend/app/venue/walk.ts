import { radial, type Item } from "./items";
import { ARC, BLOCKED, FLOOR, PX_PER_M, ROOMS, SPONSORS, STAGE, STAIRS, TABLES, THEATER, type Pt } from "./palace";

/**
 * Walking inside the hall, in plan pixels: where a person can stand, the way from one spot to
 * another around walls, rooms and furniture, and where to stand to see a destination.
 *
 * The floor is cut into a grid of ~0.6 m cells. A cell is open when you could stand in it with a
 * little room to spare from any wall; cells under tables, booths and theater seats stay open but
 * cost more, so routes keep to the aisles.
 */

export function inside([x, y]: Pt, poly: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const withBox = (poly: Pt[]) => ({ poly, x0: Math.min(...poly.map((p) => p[0])), y0: Math.min(...poly.map((p) => p[1])), x1: Math.max(...poly.map((p) => p[0])), y1: Math.max(...poly.map((p) => p[1])) });
const within = (p: Pt, b: ReturnType<typeof withBox>) => p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1 && inside(p, b.poly);
/** Closed to attendees, floor to ceiling. */
const SOLID = BLOCKED.map((b) => withBox(b.poly));
/** Can't be walked through, but low enough to see over: rooms, the stage, the stairs. */
const LOW = [...ROOMS.map((r) => r.poly), ...STAIRS.map((s) => s.poly), STAGE.poly].map(withBox);

/** Inside the building, and not in a closed area, a room, on the stage or on the stairs. */
export function walkable(p: Pt): boolean {
  return inside(p, FLOOR) && !SOLID.some((b) => within(p, b)) && !LOW.some((b) => within(p, b));
}

export const CELL = 8;
const COLS = Math.ceil(2000 / CELL);
const ROWS = Math.ceil(1000 / CELL);
const FURNITURE = 6;

interface Grid {
  /** Somewhere to stand. */
  open: Uint8Array;
  /** Nothing floor-to-ceiling here: you can see across it. */
  sight: Uint8Array;
  /** Cost of crossing: 1 in the aisles, more through furniture. */
  cost: Float32Array;
}
let grid: Grid | null = null;

const cellAt = ([x, y]: Pt) => {
  const c = Math.floor(x / CELL);
  const r = Math.floor(y / CELL);
  return c < 0 || r < 0 || c >= COLS || r >= ROWS ? -1 : r * COLS + c;
};
const centerOf = (i: number): Pt => [((i % COLS) + 0.5) * CELL, (Math.floor(i / COLS) + 0.5) * CELL];

/** Corners of a rectangle centered on `at`, `along` meters each way along `dir` and `across` meters each way across it. */
function rect(at: Pt, dir: { x: number; z: number }, along: number, across: number): Pt[] {
  const a = along * PX_PER_M;
  const b = across * PX_PER_M;
  const corner = (s: number, t: number): Pt => [at[0] + dir.x * a * s - dir.z * b * t, at[1] + dir.z * a * s + dir.x * b * t];
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

function build(): Grid {
  const n = COLS * ROWS;
  const base = new Uint8Array(n);
  const sight = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = centerOf(i);
    if (!inside(p, FLOOR) || SOLID.some((b) => within(p, b))) continue;
    sight[i] = 1;
    base[i] = LOW.some((b) => within(p, b)) ? 0 : 1;
  }
  // Keep a cell's width from every wall: a cell is open only if all eight neighbors are walkable too.
  const open = new Uint8Array(n);
  for (let r = 1; r < ROWS - 1; r++)
    for (let c = 1; c < COLS - 1; c++) {
      let ok = 1;
      for (let dr = -1; dr <= 1 && ok; dr++) for (let dc = -1; dc <= 1 && ok; dc++) ok = base[(r + dr) * COLS + c + dc]!;
      open[r * COLS + c] = ok;
    }

  const cost = new Float32Array(n).fill(1);
  const mark = (poly: Pt[]) => {
    const b = withBox(poly);
    for (let y = Math.floor(b.y0 / CELL) * CELL + CELL / 2; y <= b.y1; y += CELL)
      for (let x = Math.floor(b.x0 / CELL) * CELL + CELL / 2; x <= b.x1; x += CELL) {
        const i = cellAt([x, y]);
        if (i >= 0 && inside([x, y], poly)) cost[i] = FURNITURE;
      }
  };
  // A hacker table with its four chairs; a sponsor booth.
  for (const t of TABLES) mark(rect(t, radial(t), 0.95, 0.9));
  for (const s of SPONSORS) mark(rect(s.at, { x: 1, z: 0 }, 1, 1));
  // Theater seating: the north half of the fan.
  const r = THEATER.radius;
  for (let i = 0; i < n; i++) {
    const [x, y] = centerOf(i);
    const d = Math.hypot(x - THEATER.center[0], y - THEATER.center[1]);
    if (y < THEATER.center[1] && d > r * 0.38 && d < r * 0.97) cost[i] = FURNITURE;
  }
  return { open, sight, cost };
}

const getGrid = () => (grid ??= build());

/** Somewhere to stand, furniture or not. */
export function canStand(p: Pt): boolean {
  const i = cellAt(p);
  return i >= 0 && getGrid().open[i] === 1;
}

const free = (i: number) => {
  const g = getGrid();
  return i >= 0 && g.open[i] === 1 && g.cost[i] === 1;
};

/** The closest spot to `p` you could stand in (clear of furniture when `clearOfFurniture`). */
export function nearestOpen(p: Pt, clearOfFurniture = false): Pt {
  const g = getGrid();
  const ok = (i: number) => (clearOfFurniture ? free(i) : i >= 0 && g.open[i] === 1);
  if (ok(cellAt(p))) return p;
  const c0 = Math.floor(p[0] / CELL);
  const r0 = Math.floor(p[1] / CELL);
  for (let ring = 1; ring < 120; ring++) {
    let best: Pt | null = null;
    let bestD = Infinity;
    for (let dr = -ring; dr <= ring; dr++)
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < 0 || r < 0 || c >= COLS || r >= ROWS || !ok(r * COLS + c)) continue;
        const q = centerOf(r * COLS + c);
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < bestD) [best, bestD] = [q, d];
      }
    if (best) return best;
  }
  return p;
}

/** True when a straight walk from a to b stays on open floor no costlier than `maxCost`: every cell the line touches is checked. */
function straight(a: Pt, b: Pt, maxCost: number): boolean {
  const g = getGrid();
  const ok = (c: number, r: number) => {
    const i = r * COLS + c;
    return c >= 0 && r >= 0 && c < COLS && r < ROWS && g.open[i] === 1 && g.cost[i]! <= maxCost;
  };
  let c = Math.floor(a[0] / CELL);
  let r = Math.floor(a[1] / CELL);
  const c1 = Math.floor(b[0] / CELL);
  const r1 = Math.floor(b[1] / CELL);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const sc = Math.sign(dx);
  const sr = Math.sign(dy);
  const stepX = dx ? CELL / Math.abs(dx) : Infinity;
  const stepY = dy ? CELL / Math.abs(dy) : Infinity;
  let tx = dx ? (sc > 0 ? (c + 1) * CELL - a[0] : a[0] - c * CELL) / Math.abs(dx) : Infinity;
  let ty = dy ? (sr > 0 ? (r + 1) * CELL - a[1] : a[1] - r * CELL) / Math.abs(dy) : Infinity;
  for (let guard = 0; guard < COLS + ROWS; guard++) {
    if (!ok(c, r)) return false;
    if (c === c1 && r === r1) return true;
    // Through a corner exactly: both cells beside it count.
    if (Math.abs(tx - ty) < 1e-9 && (!ok(c + sc, r) || !ok(c, r + sr))) return false;
    if (tx < ty) {
      tx += stepX;
      c += sc;
    } else {
      ty += stepY;
      r += sr;
    }
  }
  return false;
}

const STEPS: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

/** The walk from one spot to another, as a few straight legs. Starts at `from` and ends at the nearest open spot to `to`. */
export function route(from: Pt, to: Pt): Pt[] {
  const g = getGrid();
  const start = nearestOpen(from);
  const end = nearestOpen(to);
  const s = cellAt(start);
  const t = cellAt(end);
  if (s < 0 || t < 0) return [from, end];
  const lead = from[0] === start[0] && from[1] === start[1] ? [] : [from];
  if (s === t || straight(start, end, 1)) return [...lead, start, end];

  // A* over the grid, no cutting corners past walls.
  const n = COLS * ROWS;
  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new Heap();
  const tc = t % COLS;
  const tr = Math.floor(t / COLS);
  const h = (i: number) => {
    const dc = Math.abs((i % COLS) - tc);
    const dr = Math.abs(Math.floor(i / COLS) - tr);
    return Math.max(dc, dr) + (Math.SQRT2 - 1) * Math.min(dc, dr);
  };
  dist[s] = 0;
  heap.push(s, h(s));
  while (heap.size) {
    const i = heap.pop();
    if (i === t) break;
    if (done[i]) continue;
    done[i] = 1;
    const c = i % COLS;
    const r = Math.floor(i / COLS);
    for (const [dc, dr, step] of STEPS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const j = nr * COLS + nc;
      if (!g.open[j] || done[j]) continue;
      if (dc && dr && (!g.open[r * COLS + nc] || !g.open[nr * COLS + c])) continue;
      const d = dist[i]! + (step * (g.cost[i]! + g.cost[j]!)) / 2;
      if (d < dist[j]!) {
        dist[j] = d;
        prev[j] = i;
        heap.push(j, d + h(j));
      }
    }
  }
  if (prev[t] === -1) return [...lead, start, end];

  const cells: Pt[] = [];
  for (let i = t; i !== s; i = prev[i]!) cells.push(centerOf(i));
  cells.reverse();
  const path: Pt[] = [start, ...cells.slice(0, -1), end];
  // Pull the zigzag of cells tight: skip every point a straight line can do without.
  const tight: Pt[] = [path[0]!];
  let from0 = 0;
  for (let k = 2; k < path.length; k++) {
    const a = path[from0]!;
    const maxCost = Math.max(g.cost[cellAt(a)]!, g.cost[cellAt(path[k]!)]!);
    if (!straight(a, path[k]!, maxCost)) {
      tight.push(path[k - 1]!);
      from0 = k - 1;
    }
  }
  tight.push(end);
  return [...lead, ...tight];
}

/** Meters along a walk. */
export const walkLength = (path: Pt[]) => path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - path[i]![0], p[1] - path[i]![1]), 0) / PX_PER_M;

/** How much floor you could stand on within about 4.5 m of `p`: big for the open hall, small for a nook. */
function openness(p: Pt) {
  const g = getGrid();
  const c0 = Math.floor(p[0] / CELL);
  const r0 = Math.floor(p[1] / CELL);
  let n = 0;
  for (let dr = -8; dr <= 8; dr++)
    for (let dc = -8; dc <= 8; dc++) {
      const c = c0 + dc;
      const r = r0 + dr;
      if (c >= 0 && r >= 0 && c < COLS && r < ROWS && dc * dc + dr * dr <= 64) n += g.open[r * COLS + c]!;
    }
  return n;
}

/**
 * A room's door: the middle of its longest wall that opens onto floor you can stand on, and the
 * spot just outside it.
 */
export function doorOf(poly: Pt[]): { at: Pt; out: Pt; yaw: number } | null {
  const edges = poly.map((a, i) => [a, poly[(i + 1) % poly.length]!] as const).sort(([a, b], [c, d]) => Math.hypot(d[0] - c[0], d[1] - c[1]) - Math.hypot(b[0] - a[0], b[1] - a[1]));
  for (const [a, b] of edges) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const n = { x: -(b[1] - a[1]) / len, z: (b[0] - a[0]) / len };
    for (const s of [1, -1])
      for (const d of [12, 18, 24]) {
        const out: Pt = [mid[0] + n.x * s * d, mid[1] + n.z * s * d];
        if (!inside(out, poly) && canStand(out)) return { at: mid, out, yaw: -Math.atan2(b[1] - a[1], b[0] - a[0]) };
      }
  }
  return null;
}

/** From `spot`, keep stepping away from `from` until about 2.6 m off, while the floor stays clear. */
function stepBack(spot: Pt, from: Pt): Pt {
  const d = Math.hypot(spot[0] - from[0], spot[1] - from[1]);
  if (d < 1) return spot;
  const u = { x: (spot[0] - from[0]) / d, z: (spot[1] - from[1]) / d };
  let best = spot;
  for (let k = d + 3; k <= 2.6 * PX_PER_M; k += 3) {
    const p: Pt = [from[0] + u.x * k, from[1] + u.z * k];
    if (!free(cellAt(p))) break;
    best = p;
  }
  return best;
}

/**
 * Where to stand for a destination. Areas are stood in. A booth is seen square on from the front,
 * and a room from outside its door. Anything else is seen from a few meters back on whichever side
 * has the most floor around it, so you end up in the hall looking at the stage, not in a gap behind it.
 */
export function standFor(item: Item): Pt {
  if (item.kind === "zone") return nearestOpen(item.at, true);
  const at = item.at;
  if (item.kind === "sponsor") {
    const f = boothFront(at);
    for (let k = 3.2 * PX_PER_M; k >= 1.6 * PX_PER_M; k -= 3) {
      const p: Pt = [at[0] + f.x * k, at[1] + f.z * k];
      if (free(cellAt(p))) return p;
    }
    return stepBack(nearestOpen(at, true), at);
  }
  const room = ROOMS.find((r) => inside(at, r.poly));
  const door = room && doorOf(room.poly);
  if (door) return stepBack(nearestOpen(door.out, true), door.at);
  const back = 3 * PX_PER_M;
  let best: Pt | null = null;
  let bestScore = -Infinity;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const u = { x: Math.cos(a), z: Math.sin(a) };
    const ray = (d: number): Pt => [at[0] + u.x * d, at[1] + u.z * d];
    let first = -1;
    for (let d = 0; d < 14 * PX_PER_M; d += 3)
      if (free(cellAt(ray(d)))) {
        first = d;
        break;
      }
    if (first < 0) continue;
    let d = first;
    while (d + 3 <= first + back && free(cellAt(ray(d + 3)))) d += 3;
    const p = ray(d);
    const score = openness(p) - (first / PX_PER_M) * 4;
    if (score > bestScore) [best, bestScore] = [p, score];
  }
  return best ?? nearestOpen(at, true);
}

/**
 * Which way a sponsor booth faces: toward the nearest clear floor, squared up with the hall (along
 * or across the curve) so booths line up with the wall behind them. As a plan direction.
 */
export function boothFront(at: Pt): { x: number; z: number } {
  const spot = nearestOpen(at, true);
  const dx = spot[0] - at[0];
  const dy = spot[1] - at[1];
  const r = radial(at);
  const t = { x: -r.z, z: r.x };
  const along = dx * r.x + dy * r.z;
  const across = dx * t.x + dy * t.z;
  return Math.abs(along) >= Math.abs(across) ? { x: r.x * Math.sign(along || 1), z: r.z * Math.sign(along || 1) } : { x: t.x * Math.sign(across), z: t.z * Math.sign(across) };
}

/** True when nothing floor-to-ceiling stands between a and b (the last few meters before b don't count: that's the sign's own wall). */
export function seen(a: Pt, b: Pt): boolean {
  const g = getGrid();
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const skip = 3 * PX_PER_M;
  const steps = Math.ceil(len / CELL);
  for (let k = 1; k < steps; k++) {
    if (len * (1 - k / steps) < skip) break;
    const i = cellAt([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]);
    if (i < 0 || !g.sight[i]) return false;
  }
  return true;
}

/** Binary min-heap of cell indexes by priority. */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    let i = this.ids.length;
    this.ids.push(id);
    this.keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= key) break;
      this.ids[i] = this.ids[p]!;
      this.keys[i] = this.keys[p]!;
      i = p;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }
  pop(): number {
    const top = this.ids[0]!;
    const id = this.ids.pop()!;
    const key = this.keys.pop()!;
    const n = this.ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        let m = 2 * i + 1;
        if (m >= n) break;
        if (m + 1 < n && this.keys[m + 1]! < this.keys[m]!) m++;
        if (this.keys[m]! >= key) break;
        this.ids[i] = this.ids[m]!;
        this.keys[i] = this.keys[m]!;
        i = m;
      }
      this.ids[i] = id;
      this.keys[i] = key;
    }
    return top;
  }
}
