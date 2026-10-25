import { appendAudit } from "../../hyphenate/audit";
import { postEntry } from "../../hyphenate/ledger";
import type { State } from "../store";
import type { Cents, DecisionCode, Evidence, Mandate, Traveler, Trip } from "../types";
import { COMPANY, EVENTS, PEOPLE, SCHOOLS } from "./company";

const UBC = { school: "Univ. of British Columbia", zip: "V6T1Z4", miles: 800, mode: "bus", fare: 4487, merchant: "bus" } as const;
type SchoolLike = (typeof SCHOOLS)[number] | typeof UBC;

const INITIALS = "AJ RK MN JL TS PB KO EH LW DC RV SM YA NB GF HQ IT OP CU WZ BD FE LM AK ZR QS VN XT MJ KD SE HP BL DA JO RW NG TC EY PU".split(" ");

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const MERCHANT_NAME: Record<string, string> = {
  rail: "AMTRAK CAPITOL CORRIDOR",
  bus: "Greyhound Lines",
  airline: "Southwest Airlines",
  rideshare: "Lyft",
};

function receiptText(merchant: string, ref: string, date: string, who: string, amount: Cents, currency = "USD"): string {
  const amt = (amount / 100).toFixed(2);
  switch (merchant) {
    case "rail":
      return `AMTRAK CAPITOL CORRIDOR\nReservation ${ref}\nTravel date ${date}\nPassenger ${who}\nTotal charged: $${amt}`;
    case "bus":
      return `Greyhound Lines\nOrder # ${ref}\n${date}\n1 Adult · ${who}\nTOTAL ${currency === "USD" ? "$" : currency + " "}${amt}`;
    case "airline":
      return `Southwest Airlines — Itinerary ${ref}\nDate: ${date}\nPassenger: ${who}\nAir total: $${amt}`;
    default:
      return `Lyft ride receipt\nRide ID ${ref}\n${date}\nRider ${who}\nTotal $${amt}`;
  }
}

export interface AnswerKeyEntry {
  expected: DecisionCode;
  needsHuman: boolean;
  payCents: Cents;
  plant: string;
}

export function buildSeed(): { state: State; answerKey: Record<string, AnswerKeyEntry> } {
  const state: State = {
    version: 1,
    company: { ...COMPANY, closedPeriods: [] },
    people: PEOPLE,
    travelers: [],
    events: EVENTS,
    trips: [],
    evidence: [],
    mandates: [],
    journal: [],
    audit: [],
    inbox: [],
    noShows: [],
  };
  const answerKey: Record<string, AnswerKeyEntry> = {};
  const rand = rng(2026);
  const bank = "First Bay Credit Union — card statement feed";
  const controller = { kind: "human" as const, id: "P-maya", role: "controller" as const };
  const recon = { kind: "agent" as const, id: "reconciler" as const };

  postEntry(
    state,
    {
      date: "2026-03-01",
      period: "2026-03",
      memo: "Sponsor contribution to the 2026 Hacker Travel Grant fund",
      lines: [
        { account: "1000", debit: 600_000, credit: 0 },
        { account: "3000", debit: 0, credit: 600_000 },
      ],
      refs: ["sponsor-agreement-2026"],
      postedBy: controller,
    },
    "2026-03-01T17:00:00Z",
  );

  const schoolFor = (n: number): SchoolLike => SCHOOLS[(n - 1) % SCHOOLS.length]!;
  for (let n = 1; n <= 40; n++) {
    const sc = n === 30 ? UBC : schoolFor(n);
    state.travelers.push({ id: `T${String(n).padStart(2, "0")}`, initials: INITIALS[n - 1]!, school: sc.school, homeZip: sc.zip });
  }
  const traveler = (n: number): Traveler => state.travelers[n - 1]!;

  const ev = (e: Omit<Evidence, "provenance"> & { provenance?: Evidence["provenance"] }): Evidence => {
    const full: Evidence = { provenance: "seeded", ...e };
    state.evidence.push(full);
    return full;
  };

  const mkMandate = (tripId: string, maxCents: Cents, merchant: string, approver: string, at: string): Mandate => {
    const m: Mandate = {
      id: `MDT-${tripId}`,
      tripId,
      token: `vtok_sim_${tripId.toLowerCase()}`,
      maxCents,
      merchantCategory: merchant,
      expiresAt: new Date(new Date(at).getTime() + 72 * 3_600_000).toISOString(),
      singleUse: true,
      status: "approved",
      requestedBy: "agent:policy",
      approvedBy: approver,
      provenance: "simulated",
    };
    state.mandates.push(m);
    return m;
  };

  const history: { event: string; period: string; date: string; travelers: number[] }[] = [
    { event: "E-spring", period: "2026-03", date: "2026-03-14", travelers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    { event: "E-summer", period: "2026-06", date: "2026-06-20", travelers: [5, 6, 8, 9, 10, 13, 14, 15, 16, 17, 18, 20] },
  ];
  for (const h of history) {
    for (const n of h.travelers) {
      const t = traveler(n);
      const sc = schoolFor(n);
      const id = `TR-${h.event === "E-spring" ? "S" : "M"}-${String(n).padStart(2, "0")}`;
      const noShow = h.event === "E-spring" && n === 7;
      const late = rand() < (sc.mode === "bus" ? 0.25 : sc.mode === "flight" ? 0.2 : 0.1);
      const trip: Trip = {
        id,
        travelerId: t.id,
        eventId: h.event,
        period: h.period,
        method: "virtual_card",
        mode: sc.mode,
        distanceMiles: sc.miles,
        quoteCents: sc.fare,
        mandateId: mkMandate(id, sc.fare, sc.merchant, t.id, `${h.date}T08:00:00Z`).id,
        requestedBy: "agent:policy",
        approvals: [{ by: t.id, role: "traveler", at: `${h.date}T07:00:00Z`, subject: "mandate", decision: "approve" }],
        state: noShow ? "denied" : "reimbursed",
        submittedAt: `${h.date}T22:00:00Z`,
        arrivalMarginMin: noShow ? undefined : late ? -Math.round(5 + rand() * 25) : Math.round(10 + rand() * 40),
      };
      state.trips.push(trip);
      ev({ id: `EV-${id}-bank`, tripId: id, kind: "bank_line", source: bank, fetchedAt: `${h.date}T23:00:00Z`, status: "ok", data: { amountCents: sc.fare, currency: "USD", descriptor: MERCHANT_NAME[sc.merchant], postedDate: h.date } });
      ev({ id: `EV-${id}-checkin`, tripId: id, kind: "checkin", source: "Venue badge scan", fetchedAt: `${h.date}T18:00:00Z`, status: "ok", data: { result: noShow ? "absent" : "checked_in" } });
      if (noShow) {
        state.noShows.push({ travelerId: t.id, eventId: h.event, date: h.date, tripId: id });
        postEntry(state, { date: h.date, period: h.period, memo: `No-show: ${t.initials} never checked in; ticket cost recoverable (R12)`, lines: [{ account: "1200", debit: sc.fare, credit: 0 }, { account: "2100", debit: 0, credit: sc.fare }], refs: [id, `EV-${id}-checkin`, "R12"], postedBy: recon }, `${h.date}T23:30:00Z`);
      } else {
        postEntry(state, { date: h.date, period: h.period, memo: `Travel grant — ${t.initials} (${sc.school}) to ${h.event}`, lines: [{ account: "5100", debit: sc.fare, credit: 0 }, { account: "2100", debit: 0, credit: sc.fare }], refs: [id, `EV-${id}-bank`, "R6"], postedBy: recon }, `${h.date}T23:30:00Z`);
      }
    }
    const total = state.journal.filter((j) => j.period === h.period && j.lines.some((l) => l.account === "2100")).reduce((a, j) => a + j.lines.find((l) => l.account === "2100")!.credit, 0);
    postEntry(state, { date: `${h.date.slice(0, 7)}-28`, period: h.period, memo: `Paid ${h.period} virtual card statement`, lines: [{ account: "2100", debit: total, credit: 0 }, { account: "1000", debit: 0, credit: total }], refs: [`statement-${h.period}`], postedBy: controller }, `${h.date.slice(0, 7)}-28T17:00:00Z`);
  }

  const fall = { event: "E-fall-night", period: "2026-10", date: "2026-10-16" };
  type Spec = Partial<{
    school: SchoolLike;
    method: Trip["method"];
    mode: Trip["mode"];
    merchant: string;
    quote: Cents;
    bankLines: Cents[] | null;
    cardAuth: { amount: Cents; currency: string; declined?: string } | null;
    receipt: { amount: Cents; currency?: string; ref?: string; date?: string } | null;
    checkin: "checked_in" | "absent" | null;
    requestedBy: string;
    extraApprovals: Trip["approvals"];
    event: string;
    period: string;
    submittedAt: string;
    alreadyReimbursed: boolean;
    refund: Cents;
    key: AnswerKeyEntry;
  }>;

  const davis = SCHOOLS[0];
  const stanford = SCHOOLS[3];
  const calpoly = SCHOOLS[7];
  const ucla = SCHOOLS[8];
  const sjsu = SCHOOLS[5];
  const plants: Record<number, Spec> = {
    1: {
      school: davis, method: "out_of_pocket", quote: 2400, bankLines: null,
      cardAuth: { amount: 2750, currency: "USD", declined: "amount_exceeds_mandate" },
      receipt: { amount: 2750 },
      key: { expected: "hold_price_changed", needsHuman: true, payCents: 0, plant: "Fare rose $24.00→$27.50 after approval; the mandate declined it, traveler paid personally" },
    },
    2: {
      school: stanford, method: "out_of_pocket", mode: "rideshare", merchant: "rideshare", quote: 3820, bankLines: null, cardAuth: null,
      receipt: { amount: 3820, ref: "LYFT-88213", date: "2026-10-16" }, submittedAt: "2026-10-18T19:02:00Z",
      key: { expected: "reimburse_full", needsHuman: false, payCents: 3820, plant: "(clean) first submitter of a shared Lyft ride" },
    },
    22: {
      school: stanford, method: "out_of_pocket", mode: "rideshare", merchant: "rideshare", quote: 3820, bankLines: null, cardAuth: null,
      receipt: { amount: 3820, ref: "LYFT-88213", date: "2026-10-16" }, submittedAt: "2026-10-20T08:41:00Z",
      key: { expected: "reject_duplicate", needsHuman: false, payCents: 0, plant: "Same Lyft receipt as T02 submitted again by the ride-share partner" },
    },
    9: {
      school: ucla, method: "out_of_pocket", quote: 26800, bankLines: null, cardAuth: null, receipt: { amount: 26800 },
      key: { expected: "reimburse_capped", needsHuman: true, payCents: 20000, plant: "Last-minute flight $268 over the $200 R1 cap; payout > $150 needs the controller" },
    },
    4: {
      checkin: "absent",
      key: { expected: "deny_no_show", needsHuman: false, payCents: 0, plant: "Ticket charged but the badge never scanned — a no-show" },
    },
    7: {
      checkin: null,
      key: { expected: "require_checkin", needsHuman: true, payCents: 0, plant: "No check-in record (scanner outage) for a traveler who no-showed in March" },
    },
    30: {
      school: UBC, quote: 4487, cardAuth: { amount: 6150, currency: "CAD" }, bankLines: [4487], receipt: { amount: 6150, currency: "CAD" },
      key: { expected: "convert_currency", needsHuman: false, payCents: 4487, plant: "Receipt in CAD $61.50; bank settled USD $44.87" },
    },
    11: {
      school: davis, quote: 2400, bankLines: [1400, 1000], cardAuth: { amount: 2400, currency: "USD" },
      key: { expected: "match_split_charge", needsHuman: false, payCents: 2400, plant: "Outbound and return settled as two card lines ($14 + $10)" },
    },
    15: {
      school: calpoly, quote: 4500, bankLines: [4500], receipt: { amount: 5400 },
      key: { expected: "trust_bank_over_receipt", needsHuman: false, payCents: 4500, plant: "Receipt typed as $54.00; the bank settled $45.00" },
    },
    19: {
      school: SCHOOLS[1], alreadyReimbursed: true, refund: 2900,
      key: { expected: "recover_refund", needsHuman: false, payCents: -2900, plant: "Train cancelled after reimbursement; Amtrak refunded the virtual card" },
    },
    25: {
      school: calpoly, requestedBy: "P-dev",
      extraApprovals: [{ by: "P-dev", role: "organizer", at: "2026-10-15T21:10:00Z", subject: "exception", decision: "approve", note: "rebooked after missed bus — approving" }],
      key: { expected: "block_self_approval", needsHuman: true, payCents: 0, plant: "Organizer requested a rebooking exception and approved it themselves" },
    },
    28: {
      school: davis, quote: 2400, bankLines: [2440], cardAuth: { amount: 2440, currency: "USD" }, receipt: { amount: 2440 },
      key: { expected: "reimburse_within_tolerance", needsHuman: false, payCents: 2440, plant: "(negative control) $0.40 booking fee — immaterial under R2, should NOT escalate" },
    },
    33: {
      school: sjsu, method: "out_of_pocket", bankLines: null, cardAuth: null, event: "E-summer", period: "2026-06",
      receipt: { amount: 1025, date: "2026-06-20" }, submittedAt: "2026-10-21T16:20:00Z",
      key: { expected: "post_to_open_period", needsHuman: false, payCents: 1025, plant: "June receipt submitted in October; June is closed" },
    },
  };

  for (let n = 1; n <= 40; n++) {
    const t = traveler(n);
    const p = plants[n] ?? {};
    const sc = p.school ?? (n === 30 ? UBC : schoolFor(n));
    const id = `TR-F-${String(n).padStart(2, "0")}`;
    const method = p.method ?? "virtual_card";
    const merchant = p.merchant ?? sc.merchant;
    const quote = p.quote ?? sc.fare;
    const eventId = p.event ?? fall.event;
    const date = eventId === "E-summer" ? "2026-06-20" : fall.date;
    const submittedAt = p.submittedAt ?? `2026-10-${String(18 + (n % 4)).padStart(2, "0")}T${String(9 + (n % 9)).padStart(2, "0")}:15:00Z`;
    const requestedBy = p.requestedBy ?? "agent:policy";
    const trip: Trip = {
      id,
      travelerId: t.id,
      eventId,
      period: p.period ?? fall.period,
      method,
      mode: p.mode ?? sc.mode,
      distanceMiles: sc.miles,
      quoteCents: quote,
      requestedBy,
      approvals: [{ by: t.id, role: "traveler", at: `${date}T06:30:00Z`, subject: "mandate", decision: "approve" }, ...(p.extraApprovals ?? [])],
      state: p.alreadyReimbursed ? "reimbursed" : "submitted",
      submittedAt,
    };
    if (method === "virtual_card") trip.mandateId = mkMandate(id, quote, merchant, t.id, `${date}T06:30:00Z`).id;
    state.trips.push(trip);

    ev({ id: `EV-${id}-quote`, tripId: id, kind: "quote", source: "S'mile Route Analyst (quote the traveler approved)", fetchedAt: `${date}T06:00:00Z`, status: "ok", data: { amountCents: quote, mode: trip.mode, merchantCategory: merchant } });

    const cardAuth = p.cardAuth === undefined ? (method === "virtual_card" ? { amount: quote, currency: "USD" } : null) : p.cardAuth;
    if (cardAuth)
      ev({ id: `EV-${id}-auth`, tripId: id, kind: "card_auth", source: "Visa mandate network (SIMULATED)", provenance: "simulated", fetchedAt: `${date}T07:10:00Z`, status: "ok", data: { amountCents: cardAuth.amount, currency: cardAuth.currency, result: cardAuth.declined ? "declined" : "approved", declineReason: cardAuth.declined, mandateId: trip.mandateId ?? `MDT-${id}` } });

    const bankLines = p.bankLines === undefined ? (method === "virtual_card" ? [quote] : null) : p.bankLines;
    (bankLines ?? []).forEach((amt, i) =>
      ev({ id: `EV-${id}-bank${bankLines!.length > 1 ? i + 1 : ""}`, tripId: id, kind: "bank_line", source: bank, fetchedAt: `2026-10-${17 + i}T23:00:00Z`, status: "ok", data: { amountCents: amt, currency: "USD", descriptor: MERCHANT_NAME[merchant], postedDate: `2026-10-${17 + i}` } }),
    );

    const receipt = p.receipt === undefined ? { amount: quote } : p.receipt;
    if (receipt) {
      const ref = receipt.ref ?? `${merchant.slice(0, 2).toUpperCase()}-${(48000 + n * 137).toString()}`;
      const rdate = receipt.date ?? date;
      ev({ id: `EV-${id}-receipt`, tripId: id, kind: "receipt", source: `Uploaded by traveler ${t.initials}`, fetchedAt: submittedAt, status: "ok", data: { text: receiptText(merchant, ref, rdate, t.initials, receipt.amount, receipt.currency ?? "USD") } });
    }

    const checkin = p.checkin === undefined ? "checked_in" : p.checkin;
    if (checkin) ev({ id: `EV-${id}-checkin`, tripId: id, kind: "checkin", source: "Venue badge scan", fetchedAt: `${date}T02:30:00Z`, status: "ok", data: { result: checkin } });

    if (p.alreadyReimbursed) {
      postEntry(state, { date: "2026-10-17", period: "2026-10", memo: `Travel grant — ${t.initials} (${sc.school}) to Fall Hack Night`, lines: [{ account: "5100", debit: quote, credit: 0 }, { account: "2100", debit: 0, credit: quote }], refs: [id, `EV-${id}-bank`, "R6"], postedBy: recon }, "2026-10-17T23:30:00Z");
      trip.decision = { code: "reimburse_full", payCents: quote, reasons: ["Bank settled the approved quote."], refs: [`EV-${id}-bank`, "R6"], needsHuman: false, decidedAt: "2026-10-17T23:30:00Z", decidedBy: "reconciler", explainedBy: "template" };
      ev({ id: `EV-${id}-refund`, tripId: id, kind: "refund", source: bank, fetchedAt: "2026-10-21T23:00:00Z", status: "ok", data: { amountCents: p.refund, currency: "USD", descriptor: "AMTRAK REFUND — CANCELLED TRAIN 527", processed: false } });
    }

    answerKey[id] = p.key ?? { expected: "reimburse_full", needsHuman: false, payCents: quote, plant: "(clean)" };
  }

  state.company.closedPeriods = [...COMPANY.closedPeriods];
  appendAudit(state, { actor: { kind: "agent", id: "orchestrator" }, action: "handover.received", subject: "backlog", reason: "Previous volunteer treasurer handed over 40 Fall Hack Night trips half-done", refs: ["P-dev"] });
  return { state, answerKey };
}
