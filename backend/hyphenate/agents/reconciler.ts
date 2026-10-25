import { capFor, isImmaterial, materialityFor, POLICY } from "../policy";
import type { State } from "../../src/store";
import type { Cents, Decision, DecisionCode, Evidence, HumanRole, Trip } from "../../src/types";
import { fmt, sum } from "../../src/money";

export interface ParsedReceipt {
  merchant?: string;
  ref?: string;
  date?: string;
  amountCents?: Cents;
  currency: string;
  fingerprint?: string;
  parsedBy: "rules" | "claude";
}

export function parseReceipt(text: string): ParsedReceipt {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const amt = text.match(/(?:total charged|air total|total|amount)\s*:?\s*(CAD|USD)?\s*\$?\s*([\d,]+\.\d{2})/i);
  const ref = text.match(/(?:reservation|order #|itinerary|ride id|txn)\s*:?\s*([A-Z0-9][A-Z0-9-]+)/i);
  const date = text.match(/(\d{4}-\d{2}-\d{2})/);
  const out: ParsedReceipt = {
    merchant: lines[0]?.split("—")[0]?.trim(),
    ref: ref?.[1],
    date: date?.[1],
    amountCents: amt ? Math.round(Number(amt[2]!.replace(/,/g, "")) * 100) : undefined,
    currency: (amt?.[1] ?? "USD").toUpperCase(),
    parsedBy: "rules",
  };
  if (out.merchant && out.amountCents !== undefined && out.date && out.ref)
    out.fingerprint = [out.merchant.toLowerCase(), out.amountCents, out.date, out.ref.toUpperCase()].join("|");
  return out;
}

const days = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;

export interface DecisionContext {
  askedOf?: HumanRole;
  options?: { id: string; label: string }[];
}

export function decide(state: State, trip: Trip, now = new Date()): Decision & DecisionContext {
  const ev = state.evidence.filter((e) => e.tripId === trip.id);
  const one = (kind: Evidence["kind"]) => ev.find((e) => e.kind === kind);
  const many = (kind: Evidence["kind"]) => ev.filter((e) => e.kind === kind);
  const event = state.events.find((e) => e.id === trip.eventId)!;
  const traveler = state.travelers.find((t) => t.id === trip.travelerId)!;
  const quote = one("quote");
  const receiptEv = one("receipt");
  const receipt = receiptEv ? parseReceipt(String(receiptEv.data.text ?? "")) : undefined;
  const bankLines = many("bank_line");
  const auth = one("card_auth");
  const checkin = one("checkin");
  const refund = one("refund");
  const cap = capFor(trip.distanceMiles);
  const tol = materialityFor(trip.quoteCents);
  const who = `${traveler.initials} (${traveler.school})`;

  const base = { decidedAt: now.toISOString(), decidedBy: "reconciler" as const };
  const make = (
    code: DecisionCode,
    payCents: Cents,
    reasons: string[],
    refs: (string | undefined)[],
    human?: { askedOf: HumanRole; question: string; options: { id: string; label: string }[] },
  ): Decision & DecisionContext => {
    let h = human;
    if (!h && payCents > POLICY.controllerThresholdCents) {
      h = {
        askedOf: "controller",
        question: `Payout of ${fmt(payCents)} to ${who} is over the ${fmt(POLICY.controllerThresholdCents)} sign-off threshold (R3). Approve?`,
        options: [
          { id: "approve", label: `Approve ${fmt(payCents)}` },
          { id: "reject", label: "Reject" },
        ],
      };
      reasons = [...reasons, `Payout exceeds ${fmt(POLICY.controllerThresholdCents)}, so the controller signs off (R3).`];
      refs = [...refs, "R3"];
    }
    return {
      ...base,
      code,
      payCents,
      reasons,
      refs: [...new Set(refs.filter((r): r is string => Boolean(r)))],
      needsHuman: Boolean(h),
      question: h?.question,
      askedOf: h?.askedOf,
      options: h?.options,
    };
  };

  if (refund && trip.state === "reimbursed" && refund.data.processed === false) {
    const amt = Number(refund.data.amountCents);
    return make(
      "recover_refund",
      -amt,
      [
        `${who} was already reimbursed ${fmt(trip.decision?.payCents ?? trip.quoteCents)} for this trip.`,
        `A ${fmt(amt)} credit "${refund.data.descriptor}" then posted to the virtual card.`,
        `The refund reverses the grant expense instead of sitting as unexplained card credit (R11).`,
      ],
      [refund.id, ...bankLines.map((b) => b.id), "R11"],
    );
  }

  const selfApproved = trip.approvals.find((a) => a.by === trip.requestedBy && a.decision === "approve");
  if (selfApproved) {
    const person = state.people.find((p) => p.id === selfApproved.by);
    return make(
      "block_self_approval",
      0,
      [
        `${person?.name ?? selfApproved.by} requested the ${selfApproved.subject} on this trip and also approved it ("${selfApproved.note ?? ""}").`,
        `Whoever requests a spend cannot approve it (R8), so this approval doesn't count.`,
        `The ${fmt(sum(bankLines.map((b) => Number(b.data.amountCents))))} already charged is parked in suspense until someone else decides.`,
      ],
      [selfApproved.by, ...bankLines.map((b) => b.id), "R8"],
      {
        askedOf: "controller",
        question: `${person?.name ?? selfApproved.by} approved their own exception for ${who}. As controller, do you approve the ${fmt(trip.quoteCents)} rebooking?`,
        options: [
          { id: "approve", label: "Approve as controller" },
          { id: "reject", label: "Reject — recover from traveler" },
        ],
      },
    );
  }

  if (receipt?.fingerprint) {
    const earlier = state.trips.find((o) => {
      if (o.id === trip.id || !o.submittedAt || !trip.submittedAt || o.submittedAt >= trip.submittedAt) return false;
      if (o.decision?.code === "reject_duplicate") return false;
      const r = state.evidence.find((e) => e.tripId === o.id && e.kind === "receipt");
      return r ? parseReceipt(String(r.data.text ?? "")).fingerprint === receipt.fingerprint : false;
    });
    if (earlier) {
      const ot = state.travelers.find((t) => t.id === earlier.travelerId);
      return make(
        "reject_duplicate",
        0,
        [
          `This receipt (${receipt.merchant} ${receipt.ref}, ${fmt(receipt.amountCents ?? 0)}, ${receipt.date}) was already submitted by ${ot?.initials ?? earlier.travelerId} on ${earlier.submittedAt?.slice(0, 10)} for ${earlier.id}.`,
          `A receipt can be reimbursed once (R5). If the ride was shared, the traveler can submit their own payment record for their share.`,
        ],
        [receiptEv?.id, earlier.id, `EV-${earlier.id}-receipt`, "R5"],
      );
    }
  }

  if (checkin?.data.result === "absent") {
    const charged = sum(bankLines.map((b) => Number(b.data.amountCents)));
    return make(
      "deny_no_show",
      0,
      [
        `The venue badge scan shows ${who} never checked in to ${event.name}.`,
        charged ? `The ${fmt(charged)} ticket was already charged, so it's recorded as owed back by the traveler (R12).` : `Nothing was charged; nothing is paid (R12).`,
        `The no-show is recorded; future trips need a check-in before reimbursement (R4).`,
      ],
      [checkin.id, ...bankLines.map((b) => b.id), "R12", "R4"],
    );
  }
  const priorNoShow = state.noShows.find((n) => n.travelerId === trip.travelerId && n.tripId !== trip.id && days(n.date, event.startsAt) > 0 && days(n.date, event.startsAt) <= POLICY.noShowLookbackDays);
  if (!checkin && priorNoShow) {
    const prevEvent = state.events.find((e) => e.id === priorNoShow.eventId);
    return make(
      "require_checkin",
      0,
      [
        `There's no check-in record for ${who} at ${event.name}.`,
        `${traveler.initials} was a no-show at ${prevEvent?.name ?? priorNoShow.eventId} on ${priorNoShow.date} (${priorNoShow.tripId}), so a check-in is required before paying (R4).`,
        `Missing isn't the same as absent: the scanner may have been down. Holding instead of denying.`,
      ],
      [priorNoShow.tripId, `EV-${priorNoShow.tripId}-checkin`, ...bankLines.map((b) => b.id), "R4"],
      {
        askedOf: "organizer",
        question: `Can you confirm ${who} was at ${event.name}? No badge scan, and they no-showed in ${priorNoShow.date.slice(0, 7)}.`,
        options: [
          { id: "approve", label: "Yes — I saw them / have proof" },
          { id: "reject", label: "No — treat as no-show" },
        ],
      },
    );
  }

  const bankUsd = bankLines.length ? sum(bankLines.map((b) => Number(b.data.amountCents))) : undefined;
  const receiptUsd = receipt?.currency === "USD" ? receipt.amountCents : undefined;
  const settled = bankUsd ?? receiptUsd;
  const settledSource = bankUsd !== undefined ? "bank settlement" : "receipt";
  if (settled === undefined) {
    return make("require_checkin", 0, ["No bank line and no readable USD receipt — nothing to reconcile against."], [receiptEv?.id, "R6"], {
      askedOf: "organizer",
      question: `${who} has no settled amount on record. Ask them for a receipt?`,
      options: [{ id: "reject", label: "Ask traveler for receipt" }],
    });
  }

  if (settled > trip.quoteCents && !isImmaterial(settled, trip.quoteCents, trip.quoteCents)) {
    const declined = auth?.data.result === "declined";
    return make(
      "hold_price_changed",
      0,
      [
        `${who} approved ${fmt(trip.quoteCents)}; the ${settledSource} says ${fmt(settled)} — ${fmt(settled - trip.quoteCents)} more, above the ${fmt(tol)} materiality line (R2).`,
        declined
          ? `The virtual card mandate declined the ${fmt(Number(auth?.data.amountCents))} charge because it exceeded the approved amount, and the traveler paid personally.`
          : `The card settled above the approved amount.`,
        `A changed price needs the traveler to re-approve the exact new amount before anything settles (R7). Nothing is paid yet.`,
      ],
      [quote?.id, auth?.id, receiptEv?.id, ...bankLines.map((b) => b.id), "R2", "R6", "R7"],
      {
        askedOf: "traveler",
        question: `${traveler.initials}, your fare changed from ${fmt(trip.quoteCents)} to ${fmt(settled)}. Re-approve the exact ${fmt(settled)}?`,
        options: [
          { id: "approve", label: `Re-approve ${fmt(settled)}` },
          { id: "reject", label: `Only claim the approved ${fmt(trip.quoteCents)}` },
        ],
      },
    );
  }

  const payBase = settled;

  if (state.company.closedPeriods.includes(trip.period)) {
    return make(
      "post_to_open_period",
      payBase,
      [
        `This trip belongs to ${trip.period}, which is closed and locked (R9).`,
        `The ${fmt(payBase)} ${settledSource} matches the approved quote, so it's paid, and posted in ${state.company.openPeriod} with a reference to the ${trip.period} trip.`,
      ],
      [receiptEv?.id, quote?.id, trip.id, "R9", "R6"],
    );
  }

  if (receipt && receipt.currency !== "USD") {
    return make(
      "convert_currency",
      payBase,
      [
        `The receipt is in ${receipt.currency} ${((receipt.amountCents ?? 0) / 100).toFixed(2)}.`,
        `The bank settled ${fmt(payBase)} USD; that's the amount reimbursed, not a receipt-date FX estimate (R10, R6).`,
      ],
      [receiptEv?.id, auth?.id, ...bankLines.map((b) => b.id), "R10", "R6"],
    );
  }

  if (bankLines.length > 1) {
    return make(
      "match_split_charge",
      payBase,
      [
        `${bankLines.length} card lines (${bankLines.map((b) => fmt(Number(b.data.amountCents))).join(" + ")}) together equal the ${fmt(trip.quoteCents)} approved quote.`,
        `Matched many-to-one; reimbursed ${fmt(payBase)} once.`,
      ],
      [...bankLines.map((b) => b.id), quote?.id, "R6"],
    );
  }

  if (receiptUsd !== undefined && bankUsd !== undefined && !isImmaterial(receiptUsd, bankUsd, trip.quoteCents)) {
    return make(
      "trust_bank_over_receipt",
      bankUsd,
      [
        `The receipt says ${fmt(receiptUsd)}; the bank settled ${fmt(bankUsd)}, which also matches the approved quote.`,
        `When sources disagree, the bank settlement is the system of record (R6). Reimbursed ${fmt(bankUsd)}; the receipt likely has a typo.`,
      ],
      [receiptEv?.id, ...bankLines.map((b) => b.id), quote?.id, "R6"],
    );
  }

  if (payBase > cap) {
    return make(
      "reimburse_capped",
      cap,
      [
        `${fmt(payBase)} is over the ${fmt(cap)} cap for a ${trip.distanceMiles}-mile trip (R1).`,
        `Reimbursing the cap. Paying more than the cap is an exception only the controller can approve (R3).`,
      ],
      [receiptEv?.id, quote?.id, "R1", "R3"],
      {
        askedOf: "controller",
        question: `${who}'s ${trip.mode} cost ${fmt(payBase)}; the cap is ${fmt(cap)}. Pay the cap, or approve a ${fmt(payBase - cap)} exception?`,
        options: [
          { id: "approve", label: `Pay the ${fmt(cap)} cap` },
          { id: "exception", label: `Approve exception — pay ${fmt(payBase)}` },
          { id: "reject", label: "Reject" },
        ],
      },
    );
  }

  if (payBase !== trip.quoteCents) {
    return make(
      "reimburse_within_tolerance",
      payBase,
      [
        `Settled ${fmt(payBase)} vs approved ${fmt(trip.quoteCents)}: a ${fmt(Math.abs(payBase - trip.quoteCents))} difference, inside the ${fmt(tol)} materiality line (R2).`,
        `Paid as settled without bothering anyone.`,
      ],
      [...bankLines.map((b) => b.id), quote?.id, receiptEv?.id, "R2", "R6"],
    );
  }

  return make(
    "reimburse_full",
    payBase,
    [`The ${settledSource} (${fmt(payBase)}) matches the approved quote${receiptUsd !== undefined && bankUsd !== undefined ? " and the receipt" : ""}; ${who} checked in.`],
    [...bankLines.map((b) => b.id), quote?.id, receiptEv?.id, checkin?.id, "R6"],
  );
}
