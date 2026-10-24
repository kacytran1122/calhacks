import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./store";

export interface EventListing {
  key: string;
  source: "luma" | "devpost" | "mlh";
  name: string;
  startsAt?: string;
  endsAt?: string;
  city?: string;
  venue?: string;
  lat?: number;
  lon?: number;
  locationPrecision: "exact" | "city" | "unknown";
  url: string;
  kind: "hackathon" | "tech" | "other";
  distanceMiles?: number;
  themes?: string[];
  alsoOn?: string[];
  fetchedAt: string;
  via: "bright-data" | "direct";
  change?: string;
}

export interface PreviousSnapshot {
  startsAt?: string;
  venue?: string;
  city?: string;
  fetchedAt: string;
}

export interface EventStore {
  kind: "tigerdata" | "local";
  previous(keys: string[]): Promise<Map<string, PreviousSnapshot>>;
  save(listings: EventListing[]): Promise<void>;
}

function localStore(): EventStore {
  const open = () => {
    const db = new DatabaseSync(path.join(DATA_DIR, "events.db"));
    db.exec(`PRAGMA busy_timeout = 10000;
      CREATE TABLE IF NOT EXISTS event_snapshots (
        fetched_at TEXT NOT NULL, event_key TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL,
        starts_at TEXT, venue TEXT, city TEXT, lat REAL, lon REAL, url TEXT, kind TEXT, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_snapshots_key_time ON event_snapshots (event_key, fetched_at DESC);`);
    return db;
  };
  return {
    kind: "local",
    async previous(keys) {
      const out = new Map<string, PreviousSnapshot>();
      if (!keys.length) return out;
      const db = open();
      try {
        const q = db.prepare("SELECT starts_at, venue, city, fetched_at FROM event_snapshots WHERE event_key = ? ORDER BY fetched_at DESC LIMIT 1");
        for (const k of keys) {
          const r = q.get(k) as Record<string, string | null> | undefined;
          if (r) out.set(k, { startsAt: r.starts_at ?? undefined, venue: r.venue ?? undefined, city: r.city ?? undefined, fetchedAt: String(r.fetched_at) });
        }
      } finally {
        db.close();
      }
      return out;
    },
    async save(listings) {
      const db = open();
      try {
        db.exec("BEGIN");
        const ins = db.prepare("INSERT INTO event_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const l of listings) ins.run(l.fetchedAt, l.key, l.source, l.name, l.startsAt ?? null, l.venue ?? null, l.city ?? null, l.lat ?? null, l.lon ?? null, l.url, l.kind, JSON.stringify(l));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        db.close();
      }
    },
  };
}

type PgPool = { query: (q: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
let poolP: Promise<PgPool> | undefined;

async function tigerPool(url: string): Promise<PgPool> {
  poolP ??= (async () => {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30_000 });
    await pool.query(`CREATE TABLE IF NOT EXISTS event_snapshots (
      fetched_at TIMESTAMPTZ NOT NULL, event_key TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL,
      starts_at TIMESTAMPTZ, venue TEXT, city TEXT, lat DOUBLE PRECISION, lon DOUBLE PRECISION, url TEXT, kind TEXT, payload JSONB NOT NULL)`);
    try {
      await pool.query("SELECT create_hypertable('event_snapshots', by_range('fetched_at'), if_not_exists => TRUE)");
    } catch {
      try {
        await pool.query("SELECT create_hypertable('event_snapshots', 'fetched_at', if_not_exists => TRUE)");
      } catch {}
    }
    await pool.query("CREATE INDEX IF NOT EXISTS event_snapshots_key_time ON event_snapshots (event_key, fetched_at DESC)");
    return pool as unknown as PgPool;
  })();
  return poolP;
}

function tigerStore(url: string): EventStore {
  return {
    kind: "tigerdata",
    async previous(keys) {
      const out = new Map<string, PreviousSnapshot>();
      if (!keys.length) return out;
      const pool = await tigerPool(url);
      const { rows } = await pool.query(
        "SELECT DISTINCT ON (event_key) event_key, starts_at, venue, city, fetched_at FROM event_snapshots WHERE event_key = ANY($1) ORDER BY event_key, fetched_at DESC",
        [keys],
      );
      for (const r of rows)
        out.set(String(r.event_key), {
          startsAt: r.starts_at ? new Date(r.starts_at as string).toISOString() : undefined,
          venue: (r.venue as string) ?? undefined,
          city: (r.city as string) ?? undefined,
          fetchedAt: new Date(r.fetched_at as string).toISOString(),
        });
      return out;
    },
    async save(listings) {
      if (!listings.length) return;
      const pool = await tigerPool(url);
      const cols = 12;
      const values: unknown[] = [];
      const rows = listings.map((l, i) => {
        values.push(l.fetchedAt, l.key, l.source, l.name, l.startsAt ?? null, l.venue ?? null, l.city ?? null, l.lat ?? null, l.lon ?? null, l.url, l.kind, JSON.stringify(l));
        return `(${Array.from({ length: cols }, (_, j) => `$${i * cols + j + 1}`).join(", ")})`;
      });
      await pool.query(`INSERT INTO event_snapshots VALUES ${rows.join(", ")}`, values);
    },
  };
}

export function eventStore(): EventStore {
  const url = process.env.TIGER_DATABASE_URL;
  return url ? tigerStore(url) : localStore();
}
