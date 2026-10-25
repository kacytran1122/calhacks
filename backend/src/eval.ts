import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertClaimMatches } from "./auth";
import { verifyChain } from "../hyphenate/audit";
import { openDb } from "./db";
import { writeBooksFile } from "./store";
import { postEntry, trialBalance } from "../hyphenate/ledger";
import { answer, tick } from "./orchestrator";
import { buildSeed } from "./seed/trips";
import type { DecisionCode } from "./types";

export interface CaseResult {
  tripId: string;
  plant: string;
  expected: DecisionCode;
  got: DecisionCode;
  codeOk: boolean;
  needsHumanOk: boolean;
  payOk: boolean;
  expectedPay: number;
  gotPay: number;
}

export interface ControlResult {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runEval() {
  const { state, answerKey } = buildSeed();
  await tick(state);

  const cases: CaseResult[] = Object.entries(answerKey).map(([tripId, k]) => {
    const d = state.trips.find((t) => t.id === tripId)!.decision!;
    return {
      tripId,
      plant: k.plant,
      expected: k.expected,
      got: d.code,
      codeOk: d.code === k.expected,
      needsHumanOk: d.needsHuman === k.needsHuman,
      payOk: d.payCents === k.payCents,
      expectedPay: k.payCents,
      gotPay: d.payCents,
    };
  });
  const planted = cases.filter((c) => !c.plant.startsWith("(clean)"));
  const clean = cases.filter((c) => c.plant.startsWith("(clean)"));
  const allOk = (c: CaseResult) => c.codeOk && c.needsHumanOk && c.payOk;

  const controls: ControlResult[] = [];
  const attempt = (name: string, fn: () => void, expectThrow: boolean) => {
    try {
      fn();
      controls.push({ name, ok: !expectThrow, detail: expectThrow ? "was allowed — control failed" : "ok" });
    } catch (e) {
      controls.push({ name, ok: expectThrow, detail: (e as Error).message });
    }
  };
  attempt(
    "Evidence agent tries to post to the ledger",
    () => postEntry(state, { date: "2026-10-22", period: "2026-10", memo: "sneaky", lines: [{ account: "5100", debit: 100, credit: 0 }, { account: "1000", debit: 0, credit: 100 }], refs: ["x"], postedBy: { kind: "agent", id: "evidence" } }),
    true,
  );
  attempt(
    "Reconciler tries to post into closed June",
    () => postEntry(state, { date: "2026-06-30", period: "2026-06", memo: "backdate", lines: [{ account: "5100", debit: 100, credit: 0 }, { account: "2100", debit: 0, credit: 100 }], refs: ["x"], postedBy: { kind: "agent", id: "reconciler" } }),
    true,
  );
  attempt(
    "Unbalanced entry",
    () => postEntry(state, { date: "2026-10-22", period: "2026-10", memo: "oops", lines: [{ account: "5100", debit: 100, credit: 0 }, { account: "2100", debit: 0, credit: 90 }], refs: ["x"], postedBy: { kind: "agent", id: "reconciler" } }),
    true,
  );
  const selfQ = state.inbox.find((i) => i.tripId === "TR-F-25" && i.status === "open");
  attempt("Organizer settles the exception they approved themselves", () => answer(state, selfQ!.id, { id: "P-dev", role: "organizer" }, "approve"), true);
  const travelerQ = state.inbox.find((i) => i.tripId === "TR-F-01" && i.status === "open");
  attempt("Organizer answers a question meant for the traveler", () => answer(state, travelerQ!.id, { id: "P-dev", role: "organizer" }, "approve"), true);

  attempt(
    "Request body claims a role the session doesn't have",
    () => assertClaimMatches(state, { id: "dev", personId: "P-dev", role: "organizer", name: "Dev P." }, { personId: "P-maya", role: "controller" }, "TR-F-25"),
    true,
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smile-eval-"));
  const file = path.join(dir, "books.db");
  writeBooksFile(file, state);
  const db = openDb(file);
  const sql = (name: string, q: string) => attempt(`Database refuses: ${name}`, () => void db.exec(q), true);
  sql(
    "posting an unbalanced entry",
    `BEGIN; INSERT INTO journal_entries (id, seq, date, period, memo, refs, posted_by, posted_at) VALUES ('JE-X1', 9001, '2026-10-22', '2026-10', 'raw sql', '["x"]', '{}', 'now');
     INSERT INTO journal_lines VALUES ('JE-X1', 1, '5100', 500, 0); INSERT INTO journal_lines VALUES ('JE-X1', 2, '1000', 0, 400);
     UPDATE journal_entries SET posted = 1 WHERE id = 'JE-X1'; COMMIT;`,
  );
  if (db.isTransaction) db.exec("ROLLBACK");
  sql("an entry in closed June", `INSERT INTO journal_entries (id, seq, date, period, memo, refs, posted_by, posted_at) VALUES ('JE-X2', 9002, '2026-06-30', '2026-06', 'backdate', '["x"]', '{}', 'now');`);
  sql("editing a posted entry", `UPDATE journal_entries SET memo = 'nothing to see' WHERE id = 'JE-0001';`);
  sql("changing a posted amount", `UPDATE journal_lines SET debit = 1 WHERE entry_id = 'JE-0001' AND line_no = 1;`);
  sql("deleting a journal entry", `DELETE FROM journal_entries WHERE id = 'JE-0002';`);
  sql("rewriting an audit event", `UPDATE audit SET reason = 'looked fine to me' WHERE seq = 30;`);
  sql("deleting audit history", `DELETE FROM audit WHERE seq > 10;`);
  sql("an audit event that doesn't chain", `INSERT INTO audit VALUES (99999, 'now', '{}', 'x', 'x', 'x', '[]', 'bogus', 'bogus');`);
  sql("reopening a closed period", `UPDATE periods SET closed = 0 WHERE period = '2026-06';`);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const tb = trialBalance(state);
  const dr = tb.reduce((a, r) => a + r.debit, 0);
  const cr = tb.reduce((a, r) => a + r.credit, 0);
  controls.push({ name: "Trial balance: debits = credits", ok: dr === cr, detail: `${dr} = ${cr}` });
  const chain = verifyChain(state.audit);
  controls.push({ name: "Audit chain verifies", ok: chain.ok, detail: chain.ok ? `${chain.length} events` : `broken at ${chain.brokenAt}` });
  const tampered = structuredClone(state.audit);
  const victim = tampered.find((e) => e.action === "decision.made");
  if (victim) victim.reason = "reimburse_full: looked fine to me";
  const t2 = verifyChain(tampered);
  controls.push({ name: "Editing a past decision is detected", ok: !t2.ok, detail: t2.ok ? "tamper NOT detected" : `chain breaks at event ${t2.brokenAt}` });
  controls.push({
    name: "Every journal entry traces to evidence, a rule or a person",
    ok: state.journal.every((j) => j.refs.length > 0),
    detail: `${state.journal.length} entries`,
  });

  return {
    ranAt: new Date().toISOString(),
    totals: {
      cases: cases.length,
      exact: cases.filter(allOk).length,
      plantedCaught: planted.filter((c) => c.codeOk).length,
      planted: planted.length,
      cleanPassedThrough: clean.filter(allOk).length,
      clean: clean.length,
      escalations: cases.filter((c) => state.trips.find((t) => t.id === c.tripId)!.decision!.needsHuman).length,
      controlsHeld: controls.filter((c) => c.ok).length,
      controls: controls.length,
    },
    cases,
    controls,
  };
}
