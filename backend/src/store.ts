import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AuditEvent } from "../hyphenate/audit";
import { openDb, tx } from "./db";
import { LedgerError, type JournalEntry } from "../hyphenate/ledger";
import type { Evidence, HackEvent, InboxItem, Mandate, Person, Traveler, Trip } from "./types";

export interface State {
  version: 1;
  company: {
    name: string;
    program: string;
    season: string;
    openPeriod: string;
    closedPeriods: string[];
  };
  people: Person[];
  travelers: Traveler[];
  events: HackEvent[];
  trips: Trip[];
  evidence: Evidence[];
  mandates: Mandate[];
  journal: JournalEntry[];
  audit: AuditEvent[];
  inbox: InboxItem[];
  noShows: { travelerId: string; eventId: string; date: string; tripId: string }[];
  scheduler?: { lastRun: Partial<Record<string, string>> }; // job id -> last run (scheduler.ts)
}

function backendRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "src", "index.ts")) && fs.existsSync(path.join(dir, "scripts", "seed.ts"))) return dir;
    if (fs.existsSync(path.join(dir, "backend", "src", "index.ts"))) return path.join(dir, "backend");
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

export const DATA_DIR = process.env.SMILE_DATA_DIR ?? (process.env.VERCEL ? path.join("/tmp", "smile-data") : path.join(backendRoot(), ".data"));
export const BOOKS_FILE = path.join(DATA_DIR, "books.db");

export class ConcurrentEdit extends Error {}

export function hasState(): boolean {
  return fs.existsSync(BOOKS_FILE);
}

type Row = Record<string, unknown>;

function readJournal(db: DatabaseSync): JournalEntry[] {
  const lines = new Map<string, JournalEntry["lines"]>();
  for (const l of db.prepare("SELECT entry_id, account, debit, credit FROM journal_lines ORDER BY entry_id, line_no").all() as Row[]) {
    const id = String(l.entry_id);
    if (!lines.has(id)) lines.set(id, []);
    lines.get(id)!.push({ account: String(l.account) as JournalEntry["lines"][number]["account"], debit: Number(l.debit), credit: Number(l.credit) });
  }
  return (db.prepare("SELECT * FROM journal_entries WHERE posted = 1 ORDER BY seq").all() as Row[]).map((r) => ({
    id: String(r.id),
    date: String(r.date),
    period: String(r.period),
    memo: String(r.memo),
    lines: lines.get(String(r.id)) ?? [],
    refs: JSON.parse(String(r.refs)) as string[],
    postedBy: JSON.parse(String(r.posted_by)),
    postedAt: String(r.posted_at),
  }));
}

function readAudit(db: DatabaseSync): AuditEvent[] {
  return (db.prepare("SELECT * FROM audit ORDER BY seq").all() as Row[]).map((r) => ({
    seq: Number(r.seq),
    at: String(r.at),
    actor: JSON.parse(String(r.actor)),
    action: String(r.action),
    subject: String(r.subject),
    reason: String(r.reason),
    refs: JSON.parse(String(r.refs)) as string[],
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
  }));
}

function readVersion(db: DatabaseSync): number {
  const r = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as Row | undefined;
  return r ? Number(r.value) : 0;
}

function readState(db: DatabaseSync): State {
  const doc = db.prepare("SELECT body FROM doc WHERE id = 1").get() as Row | undefined;
  if (!doc) throw new Error("the books are empty — run `npm run seed`");
  const s = JSON.parse(String(doc.body)) as State;
  s.company.closedPeriods = (db.prepare("SELECT period FROM periods WHERE closed = 1 ORDER BY period").all() as Row[]).map((r) => String(r.period));
  s.journal = readJournal(db);
  s.audit = readAudit(db);
  return s;
}

export function loadState(): State {
  const db = openDb(BOOKS_FILE);
  try {
    return readState(db);
  } finally {
    db.close();
  }
}

function insertEntry(db: DatabaseSync, e: JournalEntry, seq: number) {
  db.prepare("INSERT OR IGNORE INTO periods (period, closed) VALUES (?, 0)").run(e.period);
  db.prepare("INSERT INTO journal_entries (id, seq, date, period, memo, refs, posted_by, posted_at, posted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)").run(
    e.id,
    seq,
    e.date,
    e.period,
    e.memo,
    JSON.stringify(e.refs),
    JSON.stringify(e.postedBy),
    e.postedAt,
  );
  const line = db.prepare("INSERT INTO journal_lines (entry_id, line_no, account, debit, credit) VALUES (?, ?, ?, ?, ?)");
  e.lines.forEach((l, i) => line.run(e.id, i + 1, l.account, l.debit, l.credit));
  db.prepare("UPDATE journal_entries SET posted = 1 WHERE id = ?").run(e.id);
}

function insertAudit(db: DatabaseSync, a: AuditEvent) {
  db.prepare("INSERT INTO audit (seq, at, actor, action, subject, reason, refs, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    a.seq,
    a.at,
    JSON.stringify(a.actor),
    a.action,
    a.subject,
    a.reason,
    JSON.stringify(a.refs),
    a.prevHash,
    a.hash,
  );
}

function closePeriods(db: DatabaseSync, s: State) {
  db.prepare("INSERT OR IGNORE INTO periods (period, closed) VALUES (?, 0)").run(s.company.openPeriod);
  for (const p of s.company.closedPeriods) {
    db.prepare("INSERT OR IGNORE INTO periods (period, closed) VALUES (?, 1)").run(p);
    db.prepare("UPDATE periods SET closed = 1 WHERE period = ? AND closed = 0").run(p);
  }
}

function writeDoc(db: DatabaseSync, s: State, version: number) {
  const { journal: _j, audit: _a, ...rest } = s;
  db.prepare("INSERT INTO doc (id, body, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at").run(
    JSON.stringify(rest),
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
}

const asLedgerError = (e: unknown) => (e instanceof Error && /RAISE|closed|unbalanced|immutable|append-only|chain|never deleted|reopened|constraint/i.test(e.message) ? new LedgerError(`database refused: ${e.message}`) : e);

export function saveState(state: State): void {
  writeBooksFile(BOOKS_FILE, state);
}

export function writeBooksFile(file: string, state: State): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  const db = openDb(tmp);
  try {
    tx(db, () => {
      state.journal.forEach((e, i) => insertEntry(db, e, i + 1));
      closePeriods(db, state);
      state.audit.forEach((a) => insertAudit(db, a));
      writeDoc(db, state, 1);
    });
  } catch (e) {
    db.close();
    fs.rmSync(tmp, { force: true });
    throw asLedgerError(e);
  }
  db.close();
  fs.renameSync(tmp, file);
}

let seq = 0;
export function newId(prefix: string): string {
  seq = (seq + 1) % 1000;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36).padStart(2, "0")}`;
}

export function evidenceFor(state: State, tripId: string): Evidence[] {
  return state.evidence.filter((e) => e.tripId === tripId);
}

let chain: Promise<unknown> = Promise.resolve();
export function withState<T>(fn: (s: State) => Promise<T> | T): Promise<T> {
  const run = chain.then(async () => {
    const db0 = openDb(BOOKS_FILE);
    let s: State;
    let version: number;
    try {
      s = readState(db0);
      version = readVersion(db0);
    } finally {
      db0.close();
    }
    const nJournal = s.journal.length;
    const nAudit = s.audit.length;
    const before = JSON.stringify([s.journal, s.audit]);

    const persist = () => {
      if (JSON.stringify([s.journal.slice(0, nJournal), s.audit.slice(0, nAudit)]) !== before)
        throw new LedgerError("posted entries and audit events are immutable — post a reversing entry instead");
      const db = openDb(BOOKS_FILE);
      try {
        tx(db, () => {
          if (readVersion(db) !== version) throw new ConcurrentEdit("the books changed while this ran — retry");
          closePeriods(db, s);
          s.journal.slice(nJournal).forEach((e, i) => insertEntry(db, e, nJournal + i + 1));
          s.audit.slice(nAudit).forEach((a) => insertAudit(db, a));
          writeDoc(db, s, version + 1);
        });
      } catch (e) {
        throw e instanceof ConcurrentEdit ? e : asLedgerError(e);
      } finally {
        db.close();
      }
    };

    try {
      const out = await fn(s);
      persist();
      return out;
    } catch (e) {
      if (e && typeof e === "object" && "persistAudit" in e) {
        try {
          persist();
        } catch {}
      }
      throw e;
    }
  });
  chain = run.catch(() => undefined);
  return run;
}
