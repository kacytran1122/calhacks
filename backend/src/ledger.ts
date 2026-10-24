import { appendAudit } from "./audit";
import { authorize } from "./permissions";
import type { Actor, Cents } from "./types";
import type { State } from "./store";

export const CHART = {
  "1000": { name: "Cash — Operating", type: "asset" },
  "1050": { name: "USDC Wallet (Base Sepolia, testnet)", type: "asset" },
  "1200": { name: "Due from Travelers", type: "asset" },
  "1300": { name: "Suspense — Unreconciled Card Charges", type: "asset" },
  "2000": { name: "Reimbursements Payable", type: "liability" },
  "2100": { name: "Virtual Card Payable", type: "liability" },
  "3000": { name: "Travel Grant Fund (sponsor contribution)", type: "equity" },
  "5100": { name: "Travel Grants Expense", type: "expense" },
  "5200": { name: "Data & Tools Expense", type: "expense" },
} as const;

export type AccountCode = keyof typeof CHART;

export interface JournalLine {
  account: AccountCode;
  debit: Cents;
  credit: Cents;
}

export interface JournalEntry {
  id: string;
  date: string;
  period: string;
  memo: string;
  lines: JournalLine[];
  refs: string[];
  postedBy: Actor;
  postedAt: string;
}

export class LedgerError extends Error {
  readonly persistAudit = true;
}

export function postEntry(state: State, entry: Omit<JournalEntry, "id" | "postedAt">, at?: string): JournalEntry {
  if (entry.postedBy.kind === "agent") authorize(state, entry.postedBy, "ledger.post", entry.memo);
  if (entry.lines.length < 2) throw new LedgerError("an entry needs at least two lines");
  for (const l of entry.lines) {
    if (!(l.account in CHART)) throw new LedgerError(`unknown account ${l.account}`);
    if (!Number.isInteger(l.debit) || !Number.isInteger(l.credit)) throw new LedgerError("amounts must be integer cents");
    if (l.debit < 0 || l.credit < 0 || (l.debit > 0) === (l.credit > 0))
      throw new LedgerError("each line is exactly one positive debit or credit");
  }
  const dr = entry.lines.reduce((a, l) => a + l.debit, 0);
  const cr = entry.lines.reduce((a, l) => a + l.credit, 0);
  if (dr !== cr) throw new LedgerError(`unbalanced entry: debits ${dr} ≠ credits ${cr}`);
  if (state.company.closedPeriods.includes(entry.period))
    throw new LedgerError(`period ${entry.period} is closed (rule R9) — post to ${state.company.openPeriod}`);
  if (entry.refs.length === 0) throw new LedgerError("every entry must trace back to evidence, a rule or a person");

  const full: JournalEntry = { ...entry, id: `JE-${String(state.journal.length + 1).padStart(4, "0")}`, postedAt: at ?? new Date().toISOString() };
  state.journal.push(full);
  appendAudit(state, {
    actor: entry.postedBy,
    action: "ledger.posted",
    subject: full.id,
    reason: entry.memo,
    refs: entry.refs,
    at,
  });
  return full;
}

export function trialBalance(state: State): { account: AccountCode; name: string; debit: Cents; credit: Cents; balance: Cents }[] {
  const totals = new Map<AccountCode, { debit: Cents; credit: Cents }>();
  for (const e of state.journal)
    for (const l of e.lines) {
      const t = totals.get(l.account) ?? { debit: 0, credit: 0 };
      t.debit += l.debit;
      t.credit += l.credit;
      totals.set(l.account, t);
    }
  return (Object.keys(CHART) as AccountCode[])
    .filter((a) => totals.has(a))
    .map((a) => {
      const t = totals.get(a)!;
      return { account: a, name: CHART[a].name, ...t, balance: t.debit - t.credit };
    });
}

export function accountBalance(state: State, account: AccountCode): Cents {
  return trialBalance(state).find((r) => r.account === account)?.balance ?? 0;
}
