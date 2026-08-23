/**
 * Invariants the corpus must satisfy.
 *
 * A generated corpus is only useful if its ground truth is actually true. Every claim
 * this file checks is one that, if violated, would silently corrupt every downstream
 * metric while leaving the numbers looking entirely reasonable. That is the same class of
 * failure the whole project is about, so it would be poor form to leave the corpus itself
 * unverified.
 *
 * These run on every generation and again in the test suite.
 */

import { equals, subtract, sum, toDecimalString } from "../../src/money/index.ts";
import { MERCHANT } from "./catalogue.ts";
import type { EmittedTruth } from "./emit.ts";
import type { World } from "./world.ts";

export interface Violation {
  readonly check: string;
  readonly detail: string;
}

export function verifyWorld(world: World, emitted: readonly EmittedTruth[]): Violation[] {
  const violations: Violation[] = [];
  const fail = (check: string, detail: string): void => {
    violations.push({ check, detail });
  };
  const currency = MERCHANT.currency;

  // --- settlement arithmetic ties exactly ---
  for (const settlement of world.settlements) {
    const derived = subtract(
      subtract(subtract(subtract(settlement.gross, settlement.fee), settlement.tax), settlement.tds),
      settlement.refundsDeducted,
    );
    if (!equals(derived, settlement.net)) {
      fail(
        "settlement arithmetic",
        `${settlement.id}: gross - fee - tax - tds - refunds = ${toDecimalString(derived)} but net is ${toDecimalString(settlement.net)}`,
      );
    }
  }

  // --- a payment belongs to at most one settlement ---
  const seenPayment = new Map<string, string>();
  for (const settlement of world.settlements) {
    for (const pid of settlement.paymentIds) {
      const prior = seenPayment.get(pid);
      if (prior !== undefined) {
        fail("payment in two settlements", `${pid} in ${prior} and ${settlement.id}`);
      }
      seenPayment.set(pid, settlement.id);
    }
  }

  // --- a refund is deducted at most once ---
  const seenRefund = new Map<string, string>();
  for (const settlement of world.settlements) {
    for (const rid of settlement.refundIds) {
      const prior = seenRefund.get(rid);
      if (prior !== undefined) {
        fail("refund deducted twice", `${rid} in ${prior} and ${settlement.id}`);
      }
      seenRefund.set(rid, settlement.id);
    }
  }

  // --- settlement gross equals the sum of its payments ---
  const paymentById = new Map(world.payments.map((p) => [p.id, p] as const));
  for (const settlement of world.settlements) {
    const members = settlement.paymentIds.map((pid) => paymentById.get(pid));
    if (members.some((m) => m === undefined)) {
      fail("settlement references a missing payment", settlement.id);
      continue;
    }
    const gross = sum(
      members.map((m) => (m as NonNullable<typeof m>).gross),
      currency,
    );
    if (!equals(gross, settlement.gross)) {
      fail(
        "settlement gross",
        `${settlement.id}: payments sum to ${toDecimalString(gross)} but gross is ${toDecimalString(settlement.gross)}`,
      );
    }
  }

  // --- only captured payments are ever settled ---
  for (const [pid, sid] of seenPayment) {
    if (paymentById.get(pid)?.status !== "captured") {
      fail("failed payment settled", `${pid} in ${sid}`);
    }
  }

  // --- every emitted row has a truth entry and the mapping is consistent ---
  const rowsByTxn = new Map<string, EmittedTruth[]>();
  for (const entry of emitted) {
    const bucket = rowsByTxn.get(entry.bankTxnId);
    if (bucket) bucket.push(entry);
    else rowsByTxn.set(entry.bankTxnId, [entry]);
  }
  for (const entry of emitted) {
    if (entry.settlementId === null && entry.paymentIds.length > 1) {
      fail(
        "unsettled transaction with many payments",
        `row ${entry.row} has no settlement but ${entry.paymentIds.length} payments`,
      );
    }
    for (const pid of entry.paymentIds) {
      if (!paymentById.has(pid)) {
        fail("truth references a missing payment", `row ${entry.row}, ${pid}`);
      }
    }
    if (entry.duplicateOfRow !== null) {
      const original = emitted.find((e) => e.row === entry.duplicateOfRow);
      if (!original) {
        fail("duplicate points nowhere", `row ${entry.row} -> ${entry.duplicateOfRow}`);
      } else if (original.bankTxnId !== entry.bankTxnId) {
        fail(
          "duplicate points at a different transaction",
          `row ${entry.row} -> ${entry.duplicateOfRow}`,
        );
      } else if (original.row >= entry.row) {
        fail("duplicate precedes its original", `row ${entry.row} -> ${entry.duplicateOfRow}`);
      }
    }
  }

  // --- orphans and noise carry no payments, which is what makes REFUSED correct ---
  for (const entry of emitted) {
    const isOrphanOrNoise =
      entry.settlementId === null && entry.faults.every((f) => f !== "F10");
    if (isOrphanOrNoise && entry.paymentIds.length > 0) {
      fail("orphan carries payments", `row ${entry.row}`);
    }
  }

  // --- the running balance ties across the whole statement ---
  const first = world.bankTxns[0];
  const last = world.bankTxns[world.bankTxns.length - 1];
  if (first && last) {
    const credits = sum(
      world.bankTxns.flatMap((t) => (t.credit ? [t.credit] : [])),
      currency,
    );
    const debits = sum(
      world.bankTxns.flatMap((t) => (t.debit ? [t.debit] : [])),
      currency,
    );
    const opening = subtract(
      subtract(first.balance, first.credit ?? sum([], currency)),
      sum([], currency),
    );
    const expectedClosing = subtract(sum([opening, credits], currency), debits);
    if (!equals(expectedClosing, last.balance)) {
      fail(
        "statement balance",
        `opening + credits - debits = ${toDecimalString(expectedClosing)} but closing balance is ${toDecimalString(last.balance)}`,
      );
    }
  }

  return violations;
}

/**
 * A coarse difficulty read, printed on every generation.
 *
 * Section 6.1 of DESIGN.md defines the gate: if the deterministic tiers can resolve more
 * than 95 percent of this, the corpus is theatre. This function cannot know that number
 * yet, because the matcher does not exist. What it can report is the share of records
 * carrying each structural obstacle, which is the leading indicator.
 */
export function difficultyProfile(
  emitted: readonly EmittedTruth[],
  world?: World,
): Record<string, number> {
  const scored = emitted.filter((e) => e.duplicateOfRow === null);
  const total = scored.length;
  const share = (predicate: (entry: EmittedTruth) => boolean): number =>
    total === 0 ? 0 : Math.round((scored.filter(predicate).length / total) * 1000) / 10;

  const interchangeability = world ? measureInterchangeability(emitted, world) : null;

  return {
    rows: total,
    duplicateRows: emitted.length - total,
    ...(interchangeability ?? {}),
    pctWithSettlementRow: share((e) => e.settlementRowPresent),
    pctNoSettlementRow: share((e) => e.settlementId !== null && !e.settlementRowPresent),
    pctUnmatchable: share((e) => e.paymentIds.length === 0),
    pctF01: share((e) => e.faults.includes("F01")),
    pctF04: share((e) => e.faults.includes("F04")),
    pctF05: share((e) => e.faults.includes("F05")),
    pctF06: share((e) => e.faults.includes("F06")),
    pctF08: share((e) => e.faults.includes("F08")),
    pctF09: share((e) => e.faults.includes("F09")),
    pctF10: share((e) => e.faults.includes("F10")),
    pctF11: share((e) => e.faults.includes("F11")),
    pctF12: share((e) => e.faults.includes("F12")),
  };
}

/**
 * How much of this corpus is undecidable, and what that implies for the scoreboard.
 *
 * Two payments of the same amount captured on the same day, where late settlement put
 * one in batch A and the other in batch B, are interchangeable. Both assignments tie to
 * the credit exactly, to the paisa, and nothing in any source file distinguishes them.
 *
 * This matters because a scoring rule that demands the exact payment set is then scoring
 * a coin flip. The share of rows affected is high, so a strict set rule would report a
 * number bounded by the corpus rather than by the matcher, and a reader would have no way
 * to tell the two apart.
 *
 * `strictCeilingPct` is the expected strict set accuracy of a PERFECT matcher: one that
 * finds the right money every time and then guesses uniformly among assignments it cannot
 * distinguish. Any strict number in the report has to be read against it.
 */
function measureInterchangeability(
  emitted: readonly EmittedTruth[],
  world: World,
): Record<string, number> {
  const paymentById = new Map(world.payments.map((p) => [p.id, p] as const));
  const rowOfPayment = new Map<string, number>();
  for (const entry of emitted) {
    if (entry.duplicateOfRow !== null) continue;
    for (const pid of entry.paymentIds) rowOfPayment.set(pid, entry.row);
  }

  // group captured payments by (capture day, amount)
  const groups = new Map<string, string[]>();
  for (const [pid, row] of rowOfPayment) {
    const payment = paymentById.get(pid);
    if (!payment) continue;
    void row;
    const key = `${payment.capturedAt}|${payment.gross.minor}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(pid);
    else groups.set(key, [pid]);
  }

  // a payment is ambiguous when its twin group spans more than one row
  const ambiguous = new Set<string>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const rows = new Set(ids.map((pid) => rowOfPayment.get(pid)));
    if (rows.size < 2) continue;
    for (const pid of ids) ambiguous.add(pid);
  }

  const scored = emitted.filter((e) => e.duplicateOfRow === null);
  const totalAssigned = rowOfPayment.size;

  // expected strict accuracy of a perfect matcher guessing uniformly within each group
  let expectedCorrectRows = 0;
  for (const entry of scored) {
    const ambiguousMembers = entry.paymentIds.filter((pid) => ambiguous.has(pid)).length;
    expectedCorrectRows += ambiguousMembers === 0 ? 1 : 0.5 ** Math.min(ambiguousMembers, 12);
  }

  const pct = (numerator: number, denominator: number): number =>
    denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;

  return {
    pctPaymentsInterchangeable: pct(ambiguous.size, totalAssigned),
    strictCeilingPct: pct(expectedCorrectRows, scored.length),
  };
}
