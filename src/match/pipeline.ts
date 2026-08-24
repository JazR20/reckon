/**
 * The deterministic tiers, and the gate.
 *
 * Every bank row leaves this file in exactly one of three states and there is no fourth.
 *
 * WHY THIS IS NOT A LOOP OVER ROWS.
 *
 * The obvious shape is: for each bank credit, find the payments behind it. That is what
 * the first version did, and measuring its failures showed the shape itself was the
 * problem. Of seventeen false matches, nine lost to a rival explanation that moved FEWER
 * payments off cycle than the truth did. Perturbation is a real signal, measured at 92.3
 * percent precision at zero and 40 percent at three, but on those nine rows it points the
 * wrong way and nothing else in a single row's evidence overrules it.
 *
 * The missing constraint is global: a payment is settled exactly once. A credit that can
 * only be explained by payments another credit has already claimed with far better
 * evidence is not a close call, it is refuted. Row by row matching cannot see that,
 * because the competing claim is in a different row.
 *
 * So this runs as constraint propagation. Rows whose evidence is strongest commit first,
 * their payments leave the pool, and the remaining rows are re-solved against what is
 * actually still available. Each round relaxes the bar slightly. The pool shrinks
 * monotonically, so the loop terminates.
 *
 * This is also why the solver takes a cache rather than a payment list: the pool changes
 * between rounds, and rebuilding it per row per round would be the dominant cost.
 */

import { equals, sum, toDecimalString, zero } from "../money/index.ts";
import {
  type BankRow,
  type Sources,
  valueInReportingCurrency,
} from "../ingest/sources.ts";
import { confidenceFor, loadCalibration } from "./confidence.ts";
import { economicsOf } from "./fees.ts";
import { resolveReference } from "./reference.ts";
import {
  DEFAULT_SOLVE,
  type SolveCache,
  type SolveMode,
  type SolveOptions,
  type Solution,
  type ValuedPayment,
  addDays,
  buildCache,
  claimBatchDay,
  clearDirty,
  dirtyDaysOf,
  excludeFromCache,
  solve,
  workingDaysBefore,
} from "./solver.ts";

export type Verdict = "MATCHED" | "REVIEW" | "REFUSED";

export interface Decision {
  readonly row: number;
  readonly verdict: Verdict;
  readonly tier: "T0" | "T1" | "T2" | "T3" | "T6";
  readonly paymentIds: readonly string[];
  readonly settlementId: string | null;
  readonly confidence: number;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly alternatives: number;
  readonly perturbation: number;
  readonly dayOffset: number;
  /** members of the answer that could have been a different, identical payment */
  readonly interchangeable: number;
  /** which propagation round committed this row. 0 means it never needed one */
  readonly round: number;
}

export interface RunOptions {
  readonly solve: SolveOptions;
  /** the perturbation bar for each propagation round, relaxed in order */
  readonly commitLadder: readonly number[];
  /**
   * The gate. A row is auto matched only when its calibrated confidence reaches this.
   *
   * Set from the measured coverage against precision curve, not by taste. In
   * reconciliation a wrong auto match closes the book on money that never arrived and
   * nobody looks again; a review costs a person a minute. The two errors are not
   * symmetric, so the gate is not set at the midpoint.
   */
  readonly minConfidence: number;
}

export const DEFAULT_RUN: RunOptions = {
  solve: DEFAULT_SOLVE,
  commitLadder: [0, 1, 2, 3],
  minConfidence: 0.85,
};

type Settlement = Sources["settlements"][number];

/** Everything about a row that does not change as the pool shrinks. */
interface RowContext {
  readonly row: BankRow;
  readonly settlement: Settlement | null;
  readonly tier: Decision["tier"];
  readonly baseConfidence: number;
  readonly evidence: string[];
  readonly anchorDate: string;
  readonly mode: SolveMode;
}

export function runDeterministic(sources: Sources, options: RunOptions = DEFAULT_RUN): Decision[] {
  const reporting = "INR" as const;
  const settlementByRef = new Map(sources.settlements.map((s) => [s.utr, s] as const));
  const knownRefs = new Set(settlementByRef.keys());

  const settlementsByNet = new Map<string, Settlement[]>();
  for (const settlement of sources.settlements) {
    const key = settlement.net.minor.toString();
    const bucket = settlementsByNet.get(key);
    if (bucket) bucket.push(settlement);
    else settlementsByNet.set(key, [settlement]);
  }

  const unresolvable = new Set(sources.report.unresolvableForeignPayments);
  const valued: ValuedPayment[] = [];
  for (const payment of sources.payments) {
    if (payment.status !== "captured") continue;
    const converted = valueInReportingCurrency(payment, sources.rates);
    if (!converted) {
      valued.push({
        payment,
        gross: zero(reporting),
        economics: { gross: zero(reporting), fee: zero(reporting), tds: zero(reporting) },
        resolvable: false,
        approximate: true,
      });
      continue;
    }
    valued.push({
      payment,
      gross: converted.amount,
      economics: economicsOf(payment, converted.amount),
      resolvable: !unresolvable.has(payment.id),
      approximate: converted.rate !== null,
    });
  }

  const refundsByDate = new Map<string, Sources["refunds"][number][]>();
  for (const refund of sources.refunds) {
    const bucket = refundsByDate.get(refund.createdAt);
    if (bucket) bucket.push(refund);
    else refundsByDate.set(refund.createdAt, [refund]);
  }

  const decided = new Map<number, Decision>();
  const pending: RowContext[] = [];

  // ---- Phase 0: rows that no amount of searching can help -------------------
  for (const row of sources.bank) {
    const early = decideEarly(row);
    if (early) {
      decided.set(row.row, early);
      continue;
    }
    pending.push(
      buildContext(row, { knownRefs, settlementByRef, settlementsByNet, refundsByDate }),
    );
  }

  // ---- Phase 1: constraint propagation --------------------------------------
  const cache = buildCache(valued);
  const lastResult = new Map<number, ReturnType<typeof solve>>();
  let round = 0;
  let remaining = pending;

  for (const bar of options.commitLadder) {
    round++;
    // Re-solving every row every round is wasteful: a round only changes days it took
    // payments from. A row whose candidate window does not touch a changed day has the
    // same answer it had last round, so its cached result is reused.
    const dirty = dirtyDaysOf(cache);
    const results = new Map<number, ReturnType<typeof solve>>();
    for (const context of remaining) {
      const cached = lastResult.get(context.row.row);
      if (cached && dirty.size > 0 && !windowTouches(context.anchorDate, dirty, options.solve)) {
        results.set(context.row.row, cached);
        continue;
      }
      const fresh = solve(context.anchorDate, context.mode, cache, options.solve);
      results.set(context.row.row, fresh);
      lastResult.set(context.row.row, fresh);
    }
    clearDirty(cache);

    // a payment claimed by two candidates at this bar cannot settle both, so neither
    // claim is committed this round. Whichever is right will be reachable next round,
    // once the other has been resolved or has fallen away.
    const claimCount = new Map<string, number>();
    for (const context of remaining) {
      const result = results.get(context.row.row);
      const solution = eligible(result, bar);
      if (!solution) continue;
      for (const member of solution.members) {
        claimCount.set(member.payment.id, (claimCount.get(member.payment.id) ?? 0) + 1);
      }
    }

    // two credits committing to the SAME batch day in one round is the same class of
    // conflict as two claiming one payment, and it is resolved the same way: neither
    // commits, and the round that follows has more information
    const dayClaims = new Map<string, number>();
    for (const context of remaining) {
      const solution = eligible(results.get(context.row.row), bar);
      if (solution) dayClaims.set(solution.batchDay, (dayClaims.get(solution.batchDay) ?? 0) + 1);
    }

    const committedPayments: { id: string; day: string }[] = [];
    const committedDays: string[] = [];
    const stillPending: RowContext[] = [];
    for (const context of remaining) {
      const result = results.get(context.row.row);
      const solution = eligible(result, bar);
      if (!solution) {
        stillPending.push(context);
        continue;
      }
      const contested =
        solution.members.some((m) => (claimCount.get(m.payment.id) ?? 0) > 1) ||
        (dayClaims.get(solution.batchDay) ?? 0) > 1;
      if (contested) {
        stillPending.push(context);
        continue;
      }
      const decision = commit(context, solution, round, bar);
      if (decision.confidence < options.minConfidence) {
        // the evidence does not reach the gate. The candidate is kept and offered, but it
        // is not asserted, and the payments stay in the pool for a better claim
        decided.set(context.row.row, downgrade(decision));
        continue;
      }
      decided.set(context.row.row, decision);
      committedPayments.push(
        ...solution.members.map((m) => ({ id: m.payment.id, day: m.payment.capturedAt })),
      );
      committedDays.push(solution.batchDay);
    }

    for (const day of committedDays) claimBatchDay(cache, day);
    if (committedPayments.length > 0) excludeFromCache(cache, committedPayments);
    remaining = stillPending;
    if (remaining.length === 0) break;
  }

  // ---- Phase 2: everything the propagation could not commit -----------------
  for (const context of remaining) {
    const result = solve(context.anchorDate, context.mode, cache, options.solve);
    decided.set(context.row.row, finalise(context, result));
  }

  return sources.bank.map((row) => {
    const decision = decided.get(row.row);
    if (!decision) throw new Error(`row ${row.row} left undecided, which the contract forbids`);
    return decision;
  });
}

/**
 * A solution good enough to commit at this round's bar.
 *
 * Unique, within the perturbation bar, and drawn from a day that could actually tie
 * exactly. A day carrying a converted payment could not, so an exact tie found there is
 * evidence of a different batch rather than of this one.
 */
function eligible(result: ReturnType<typeof solve> | undefined, bar: number): Solution | null {
  if (!result || result.kind !== "unique") return null;
  const solution = result.solutions[0];
  if (!solution) return null;
  if (solution.removed + solution.added > bar) return null;
  if (solution.batchDayHasConversion) return null;
  return solution;
}

// ---------------------------------------------------------------------------
// per row scaffolding
// ---------------------------------------------------------------------------

function decideEarly(row: BankRow): Decision | null {
  const base = {
    row: row.row,
    settlementId: null,
    paymentIds: [] as readonly string[],
    alternatives: 0,
    perturbation: -1,
    dayOffset: 0,
    interchangeable: 0,
    round: 0,
  };

  // F01. The amount cell carries no decimal separator, so its scale is a choice rather
  // than a fact. Rupees and paise are both plausible settlements for this merchant, and
  // no source states which. There is no correct guess, so none is made.
  if (row.unitAmbiguous) {
    return {
      ...base,
      verdict: "REFUSED",
      tier: "T0",
      confidence: 1,
      reason:
        "amount scale undetermined: the cell carries no decimal separator, so rupees and paise are both plausible readings and neither is stated",
      evidence: [
        `credit cell read one way is ${row.credit ? toDecimalString(row.credit) : "absent"}`,
        "the same field is returned as integer paise by the API and as decimal rupees by a dashboard export, see docs/SCHEMA-PROVENANCE.md",
      ],
    };
  }

  if (row.credit === null) {
    return {
      ...base,
      verdict: "REVIEW",
      tier: "T0",
      confidence: 0,
      reason:
        "debit row: a reversal matches backwards against an already reconciled period, which the deterministic tiers do not attempt",
      evidence: [row.debit ? `debit ${toDecimalString(row.debit)}` : "no amount"],
    };
  }

  return null;
}

function buildContext(
  row: BankRow,
  lookup: {
    knownRefs: ReadonlySet<string>;
    settlementByRef: ReadonlyMap<string, Settlement>;
    settlementsByNet: ReadonlyMap<string, Settlement[]>;
    refundsByDate: ReadonlyMap<string, Sources["refunds"][number][]>;
  },
): RowContext {
  const credit = row.credit;
  if (!credit) throw new Error("buildContext called on a debit row");

  const resolution = resolveReference(row.narration, row.refNo, lookup.knownRefs);
  const evidence: string[] = [
    `extracted ${resolution.candidatesExtracted} reference-shaped token(s) from the narration`,
  ];

  let settlement: Settlement | null = null;
  let tier: Decision["tier"] = "T2";
  let baseConfidence = 0.5;

  if (resolution.kind === "unique" && resolution.reference) {
    settlement = lookup.settlementByRef.get(resolution.reference) ?? null;
    if (settlement) {
      evidence.push(`reference ${resolution.reference} resolves to a settlement we hold`);
      if (!equals(settlement.net, credit)) {
        evidence.push(
          `but its net ${toDecimalString(settlement.net)} does not equal the credit ${toDecimalString(credit)}`,
        );
        settlement = null;
        baseConfidence = 0.3;
      } else {
        tier = "T1";
        baseConfidence = 0.95;
      }
    }
  } else if (resolution.kind === "ambiguous") {
    evidence.push(
      `${resolution.candidatesKnown.length} extracted tokens each resolve to a settlement, so the reference does not identify one`,
    );
  } else {
    evidence.push("no extracted token resolves to a settlement we hold");
    const byNet = lookup.settlementsByNet.get(credit.minor.toString());
    if (byNet && byNet.length === 1) {
      settlement = byNet[0] as Settlement;
      tier = "T1";
      baseConfidence = 0.8;
      evidence.push(
        `exactly one settlement has a net of ${toDecimalString(credit)}, which identifies it without a reference`,
      );
    } else if (byNet && byNet.length > 1) {
      evidence.push(
        `${byNet.length} settlements share this exact net, so the amount does not identify one`,
      );
    }
  }

  const anchorDate = settlement ? settlement.settledAt : row.date;
  const refundsOnDate = lookup.refundsByDate.get(anchorDate) ?? [];
  const refundTotal = settlement
    ? settlement.refunds
    : sum(
        refundsOnDate.map((r) => r.amount),
        credit.currency,
      );

  const mode: SolveMode = settlement
    ? { kind: "gross", target: settlement.gross, refunds: refundTotal }
    : { kind: "net", target: credit, refunds: refundTotal };

  return { row, settlement, tier, baseConfidence, evidence, anchorDate, mode };
}

// ---------------------------------------------------------------------------
// verdicts
// ---------------------------------------------------------------------------

function commit(
  context: RowContext,
  solution: Solution,
  round: number,
  bar: number,
): Decision {
  const perturbation = solution.removed + solution.added;
  return {
    row: context.row.row,
    verdict: "MATCHED",
    tier: round > 1 ? "T3" : context.tier,
    settlementId: context.settlement?.id ?? null,
    paymentIds: solution.members.map((m) => m.payment.id),
    confidence: confidenceOf(context, solution, round),
    reason:
      round === 1
        ? "exactly one payment set reproduces this credit, moving no more payments off cycle than the evidence supports"
        : `committed in propagation round ${round} at a perturbation bar of ${bar}, once payments claimed by better evidenced credits had left the pool`,
    evidence: [
      ...context.evidence,
      `batch day ${solution.batchDay}, ${solution.members.length} payments, ${solution.removed} held back, ${solution.added} arriving late`,
      round > 1
        ? "no other credit contests any payment in this set"
        : "uncontested at the strictest bar",
    ],
    alternatives: 0,
    perturbation,
    dayOffset: dayGap(context.anchorDate, solution.batchDay),
    interchangeable: solution.interchangeableMembers,
    round,
  };
}

/** A candidate that did not reach the gate. Offered to a human, never asserted. */
function downgrade(decision: Decision): Decision {
  return {
    ...decision,
    verdict: "REVIEW",
    reason: `a batch ties, but its calibrated confidence of ${decision.confidence.toFixed(2)} is below the gate, and rows with this evidence are wrong often enough that asserting it would be dishonest`,
    alternatives: 1,
  };
}

function finalise(context: RowContext, result: ReturnType<typeof solve>): Decision {
  const base = {
    row: context.row.row,
    settlementId: context.settlement?.id ?? null,
    perturbation: -1,
    dayOffset: 0,
    interchangeable: 0,
    round: 0,
  };

  if (result.kind === "unique") {
    const solution = result.solutions[0] as Solution;
    // reached the end of the ladder without ever being uncontested, or the day it was
    // drawn from cannot tie exactly. Either way it is a candidate, not a conclusion.
    return {
      ...base,
      verdict: "REVIEW",
      tier: context.tier,
      paymentIds: solution.members.map((m) => m.payment.id),
      confidence: 0.5,
      reason: solution.batchDayHasConversion
        ? "a batch ties exactly, but its day contains a payment taken in another currency that cannot tie at all, so this is an alternative rather than the answer"
        : "a batch ties, but it moves more payments off cycle than the evidence supports, or a better evidenced credit contests it",
      evidence: [
        ...context.evidence,
        `candidate batch day ${solution.batchDay}, perturbation ${solution.removed + solution.added}`,
      ],
      alternatives: 1,
      perturbation: solution.removed + solution.added,
      dayOffset: dayGap(context.anchorDate, solution.batchDay),
      interchangeable: solution.interchangeableMembers,
    };
  }

  if (result.kind === "ambiguous") {
    return {
      ...base,
      verdict: "REVIEW",
      tier: context.tier,
      paymentIds: [],
      confidence: 0.4,
      reason: `${result.solutions.length} materially different payment sets reproduce this credit, and nothing in the sources chooses between them`,
      evidence: context.evidence,
      alternatives: result.solutions.length,
    };
  }

  return {
    ...base,
    verdict: "REFUSED",
    tier: "T6",
    paymentIds: [],
    confidence: 0.6,
    reason: context.settlement
      ? "a settlement was identified but no set of payments reproduces its gross, so the batch cannot be explained"
      : "no settlement row and no set of payments reproduces this credit, so nothing in the sources explains this money",
    evidence: context.evidence,
    alternatives: 0,
  };
}

/** Confidence is the measured precision of rows carrying the same evidence. See confidence.ts. */
function confidenceOf(context: RowContext, solution: Solution, round: number): number {
  return confidenceFor(
    {
      perturbation: solution.removed + solution.added,
      settlementPresent: context.settlement !== null,
      firstRound: round <= 1,
      interchangeable: solution.interchangeableMembers,
    },
    loadCalibration(),
  );
}

/** Does this row's candidate window overlap any day whose contents changed? */
function windowTouches(
  anchorDate: string,
  dirty: ReadonlySet<string>,
  options: SolveOptions,
): boolean {
  const anchor = workingDaysBefore(anchorDate, options.settlementLagWorkingDays);
  const from = -options.batchDayTolerance - options.stragglerLookback;
  const to = options.batchDayTolerance;
  for (let offset = from; offset <= to; offset++) {
    if (dirty.has(addDays(anchor, offset))) return true;
  }
  return false;
}

/** Calendar days between the derived anchor and the day the solver actually used. */
function dayGap(creditDate: string, batchDay: string): number {
  const anchor = workingDaysBefore(creditDate, DEFAULT_SOLVE.settlementLagWorkingDays);
  for (let offset = -6; offset <= 6; offset++) {
    if (addDays(anchor, offset) === batchDay) return offset;
  }
  return 99;
}

export function totalOf(decisions: readonly Decision[], verdict: Verdict): number {
  return decisions.filter((d) => d.verdict === verdict).length;
}
