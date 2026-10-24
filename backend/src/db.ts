/**
 * The books live in SQLite (Node's built-in driver, no native install), and the database
 * itself enforces the accounting invariants — so a bug, a script, or a person with a SQL
 * prompt can't get around them the way they could get around application code:
 *
 *  - an entry becomes "posted" only if it has ≥2 lines and debits = credits
 *  - nothing can be inserted into a closed period, and a closed period can't be reopened
 *  - posted entries, their lines, and audit events can't be updated or deleted
 *  - each audit event must chain to the previous one's hash, in sequence
 *
 * Production would run the same schema on Postgres (constraint triggers / deferred checks);
 * SQLite keeps the hackathon setup to `npm install`.
 */
import { DatabaseSync } from "node:sqlite";
import { CHART } from "./ledger";

export const GENESIS_HASH = "0".repeat(64);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS doc (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS periods (period TEXT PRIMARY KEY, closed INTEGER NOT NULL CHECK (closed IN (0, 1)));
CREATE TABLE IF NOT EXISTS accounts (code TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  date TEXT NOT NULL,
  period TEXT NOT NULL REFERENCES periods(period),
  memo TEXT NOT NULL,
  refs TEXT NOT NULL CHECK (json_valid(refs) AND json_array_length(refs) > 0),
  posted_by TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  posted INTEGER NOT NULL DEFAULT 0 CHECK (posted IN (0, 1))
);
CREATE TABLE IF NOT EXISTS journal_lines (
  entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  line_no INTEGER NOT NULL,
  account TEXT NOT NULL REFERENCES accounts(code),
  debit INTEGER NOT NULL CHECK (debit >= 0),
  credit INTEGER NOT NULL CHECK (credit >= 0),
  CHECK ((debit > 0) <> (credit > 0)),
  PRIMARY KEY (entry_id, line_no)
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  reason TEXT NOT NULL,
  refs TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);

CREATE TRIGGER IF NOT EXISTS je_no_closed_period BEFORE INSERT ON journal_entries
WHEN EXISTS (SELECT 1 FROM periods WHERE period = NEW.period AND closed = 1)
BEGIN SELECT RAISE(ABORT, 'R9: period is closed'); END;

CREATE TRIGGER IF NOT EXISTS je_insert_unposted BEFORE INSERT ON journal_entries
WHEN NEW.posted <> 0
BEGIN SELECT RAISE(ABORT, 'entries are inserted unposted, then posted once their lines balance'); END;

CREATE TRIGGER IF NOT EXISTS je_post_only_if_balanced BEFORE UPDATE OF posted ON journal_entries
WHEN OLD.posted = 0 AND NEW.posted = 1 AND (
  (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.id) < 2 OR
  (SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0) FROM journal_lines WHERE entry_id = NEW.id) <> 0)
BEGIN SELECT RAISE(ABORT, 'unbalanced entry: debits must equal credits'); END;

CREATE TRIGGER IF NOT EXISTS je_posted_immutable BEFORE UPDATE ON journal_entries
WHEN OLD.posted = 1
BEGIN SELECT RAISE(ABORT, 'posted entries are immutable — post a reversing entry instead'); END;

CREATE TRIGGER IF NOT EXISTS je_no_delete BEFORE DELETE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'journal entries are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS jl_only_on_unposted BEFORE INSERT ON journal_lines
WHEN (SELECT posted FROM journal_entries WHERE id = NEW.entry_id) <> 0
BEGIN SELECT RAISE(ABORT, 'cannot add lines to a posted entry'); END;

CREATE TRIGGER IF NOT EXISTS jl_no_update BEFORE UPDATE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'journal lines are immutable'); END;

CREATE TRIGGER IF NOT EXISTS jl_no_delete BEFORE DELETE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'journal lines are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS audit_chain BEFORE INSERT ON audit
WHEN NEW.seq <> COALESCE((SELECT MAX(seq) FROM audit), 0) + 1
  OR NEW.prev_hash <> COALESCE((SELECT hash FROM audit ORDER BY seq DESC LIMIT 1), '${GENESIS_HASH}')
BEGIN SELECT RAISE(ABORT, 'audit events must chain to the previous event, in order'); END;

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END;

CREATE TRIGGER IF NOT EXISTS period_no_reopen BEFORE UPDATE ON periods
WHEN OLD.closed = 1 AND NEW.closed = 0
BEGIN SELECT RAISE(ABORT, 'a closed period cannot be reopened'); END;

CREATE TRIGGER IF NOT EXISTS period_no_delete BEFORE DELETE ON periods
BEGIN SELECT RAISE(ABORT, 'periods are never deleted'); END;
`;

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;");
  db.exec(SCHEMA);
  const insert = db.prepare("INSERT OR IGNORE INTO accounts (code, name, type) VALUES (?, ?, ?)");
  for (const [code, a] of Object.entries(CHART)) insert.run(code, a.name, a.type);
  return db;
}

/** Run fn in one IMMEDIATE transaction: all of it lands, or none of it does. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
