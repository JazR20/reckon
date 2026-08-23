/**
 * The deterministic tiers, and the gate.
 *
 * Every bank row leaves this file in exactly one of three states and there is no fourth.
 * A function here that could return none of the three would be a bug, which is why the
 * decision type is a closed union rather than an optional field on a result object.
 */

import {
  type Money,
  equals,
  fromMinor,
  sum,
  toDecimalString,
  zero,
} from "../money/index.ts";
import {
  type BankRow,
  type PaymentRow,
  type Sources,
  valueInReportingCurrency,
} from "../ingest/sources.ts";
import { economicsOf } from "./fees.ts";
import { resolveReference } from "./reference.ts";
import {
  DEFAULT_SOLVE,
  type SolveOptions,
  type ValuedPayment,
  addDays,
  solve,
  workingDaysBefore,
} from "./solver.ts";

/**
 * Did the batch day itself contain a payment whose rupee value is a conversion?
 *
 * Scoped to the derived anchor day, not a window. A first attempt checked a twelve day
 * window and tripped on almost every row, because a cross currency payment lands roughly
 * every third day and coverage went to zero. The day is the right granularity: a batch is
 * one day of captures, so it is that day's composition that decides whether the batch can
 * be verified exactly.
 */
function anchorDayHasConversion(anchorDate: string, valued: readonly ValuedPayment[]): boolean {
  const day = workingDaysBefore(anchorDate, DEFAULT_SOLVE.settlementLagWorkingDays);
  return valued.some((v) => v.approximate && v.payment.capturedAt === day);
}

/** Calendar days between the derived anchor and the day the solver actually used. */
function dayGap(creditDate: string, batchDay: string): number {
  const anchor = workingDaysBefore(creditDate, DEFAULT_SOLVE.settlementLagWorkingDays);
  for (let offset = -6; offset <= 6; offset++) {
    if (addDays(anchor, offset) === batchDay) return offset;
  }
  return 99;
}

export type Verdict = "MATCHED" | "REVIEW" | "REFUSED";

export interface Decision {
  readonly row: number;
  readonly verdict: Verdict;
  /** the tier that decided, for the ablation table */
  readonly tier: "T0" | "T1" | "T2" | "T6";
  readonly paymentIds: readonly string[];
  readonly settlementId: string | null;
  readonly confidence: number;
  readonly reason: string;
  readonly evidence: readonly string[];
  /** candidate answers when more than one survived, for the human who reviews it */
  readonly alternatives: number;
  /** how many payments had to be moved off cycle to explain the credit */
  readonly perturbation: number;
  /** how far the winning batch day sat from the derived anchor */
  readonly dayOffset: number;
}

export interface RunOptions {
  readonly solve: SolveOptions;
}

export const DEFAULT_RUN: RunOptions = { solve: DEFAULT_SOLVE };

export function runDeterministic(sources: Sources, options: RunOptions = DEFAULT_RUN): Decision[] {
  const reporting = "INR" as const;
  const settlementByRef = new Map(sources.settlements.map((s) => [s.utr, s] as const));
  const knownRefs = new Set(settlementByRef.keys());

  // net amounts are close to unique, so an exact amount match is real evidence when the
  // reference is gone. Where it is NOT unique the row must not be decided on amount.
  const settlementsByNet = new Map<string, typeof sources.settlements>();
  for (const settlement of sources.settlements) {
    const key = settlement.net.minor.toString();
    const bucket = settlementsByNet.get(key);
    if (bucket) (bucket as unknown as unknown[]).push(settlement);
    else settlementsByNet.set(key, [settlement] as unknown as typeof sources.settlements);
  }

  // value every payment once
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

  const refundsByDate = new Map<string, typeof sources.refunds>();
  for (const refund of sources.refunds) {
    const bucket = refundsByDate.get(refund.createdAt);
    if (bucket) (bucket as unknown as unknown[]).push(refund);
    else refundsByDate.set(refund.createdAt, [refund] as unknown as typeof sources.refunds);
  }

  const decisions: Decision[] = [];

  for (const row of sources.bank) {
    decisions.push(
      decideRow(row, {
        valued,
        settlementByRef,
        knownRefs,
        settlementsByNet,
        refundsByDate,
        options,
      }),
    );
  }

  return decisions;
}

interface Context {
  readonly valued: readonly ValuedPayment[];
  readonly settlementByRef: ReadonlyMap<string, Sources["settlements"][number]>;
  readonly knownRefs: ReadonlySet<string>;
  readonly settlementsByNet: ReadonlyMap<string, Sources["settlements"]>;
  readonly refundsByDate: ReadonlyMap<string, Sources["refunds"]>;
  readonly options: RunOptions;
}

function decideRow(row: BankRow, ctx: Context): Decision {
  const base = {
    row: row.row,
    settlementId: null,
    paymentIds: [] as readonly string[],
    alternatives: 0,
    perturbation: -1,
    dayOffset: 0,
  };

  // ---- T0: the row cannot be read reliably -------------------------------
  //
  // F01. The amount cell carries no decimal separator, so its scale is a choice rather
  // than a fact. Read as rupees and read as paise both produce a plausible settlement for
  // this merchant. There is no correct guess available, so no guess is made.
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

  // ---- debits: a reversal, out of scope for the deterministic tiers -------
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

  const credit = row.credit;

  // ---- T1: resolve the reference against settlements we actually hold ----
  const resolution = resolveReference(row.narration, row.refNo, ctx.knownRefs);
  const evidence: string[] = [
    `extracted ${resolution.candidatesExtracted} reference-shaped token(s) from the narration`,
  ];

  let settlement: Sources["settlements"][number] | null = null;
  let tier: Decision["tier"] = "T2";
  let confidence = 0.5;

  if (resolution.kind === "unique" && resolution.reference) {
    settlement = ctx.settlementByRef.get(resolution.reference) ?? null;
    if (settlement) {
      evidence.push(`reference ${resolution.reference} resolves to a settlement we hold`);
      if (!equals(settlement.net, credit)) {
        evidence.push(
          `but its net ${toDecimalString(settlement.net)} does not equal the credit ${toDecimalString(credit)}`,
        );
        settlement = null;
        confidence = 0.3;
      } else {
        tier = "T1";
        confidence = 0.95;
      }
    }
  } else if (resolution.kind === "ambiguous") {
    evidence.push(
      `${resolution.candidatesKnown.length} extracted tokens each resolve to a settlement, so the reference does not identify one`,
    );
  } else {
    evidence.push("no extracted token resolves to a settlement we hold");
    // fall back to an exact net amount match, which is evidence only when unique
    const byNet = ctx.settlementsByNet.get(credit.minor.toString());
    if (byNet && byNet.length === 1) {
      settlement = byNet[0] as Sources["settlements"][number];
      tier = "T1";
      confidence = 0.8;
      evidence.push(
        `exactly one settlement has a net of ${toDecimalString(credit)}, which identifies it without a reference`,
      );
    } else if (byNet && byNet.length > 1) {
      evidence.push(
        `${byNet.length} settlements share this exact net, so the amount does not identify one`,
      );
    }
  }

  // ---- T2: recover the payment set --------------------------------------
  const refundsOnDate = settlement
    ? (ctx.refundsByDate.get(settlement.settledAt) ?? [])
    : (ctx.refundsByDate.get(row.date) ?? []);
  const refundTotal = settlement
    ? settlement.refunds
    : sum(
        refundsOnDate.map((r) => r.amount),
        credit.currency,
      );

  const anchorDate = settlement ? settlement.settledAt : row.date;

  const result = settlement
    ? solve(anchorDate, { kind: "gross", target: settlement.gross, refunds: refundTotal }, ctx.valued, ctx.options.solve)
    : solve(anchorDate, { kind: "net", target: credit, refunds: refundTotal }, ctx.valued, ctx.options.solve);

  evidence.push(
    `subset search over ${result.daysTried} candidate batch day(s), ${result.nodesVisited} nodes`,
  );

  if (result.kind === "unique") {
    const solution = result.solutions[0];
    if (!solution) throw new Error("unreachable: unique result with no solution");

    // The batch day carried a payment whose rupee value is a conversion. A subset
    // containing it can never tie exactly, so the exact tie found here is necessarily a
    // DIFFERENT subset, and there is no evidence in the sources that it is the right one.
    //
    // Measured before this check: every one of the auto matched rows whose true batch
    // contained a cross currency payment was wrong. The solver had not failed, it had
    // succeeded at the wrong question, which is the harder failure to notice.
    if (anchorDayHasConversion(anchorDate, ctx.valued)) {
      return {
        ...base,
        verdict: "REVIEW",
        tier,
        settlementId: settlement?.id ?? null,
        paymentIds: solution.members.map((m) => m.payment.id),
        perturbation: solution.removed + solution.added,
        dayOffset: dayGap(anchorDate, solution.batchDay),
        confidence: 0.5,
        reason:
          "a batch ties exactly, but the batch day contains a payment taken in another currency that cannot tie at all, so this answer is an alternative rather than the answer",
        evidence: [
          ...evidence,
          "an exact tie drawn from a day whose true batch cannot tie exactly is evidence of a different batch, not of this one",
        ],
        alternatives: 1,
      };
    }

    evidence.push(
      `batch day ${solution.batchDay}, ${solution.members.length} payments, ${solution.removed} held back, ${solution.added} arriving late`,
    );
    return {
      ...base,
      verdict: "MATCHED",
      tier,
      settlementId: settlement?.id ?? null,
      paymentIds: solution.members.map((m) => m.payment.id),
      perturbation: solution.removed + solution.added,
      dayOffset: dayGap(anchorDate, solution.batchDay),
      confidence: settlement ? confidence : 0.7,
      reason: settlement
        ? "reference or amount identified the settlement, and exactly one payment set reproduces its gross"
        : "no settlement row available, and exactly one payment set reproduces the credit net of the rate card",
      evidence,
      alternatives: 0,
    };
  }

  if (result.kind === "ambiguous") {
    return {
      ...base,
      verdict: "REVIEW",
      tier,
      settlementId: settlement?.id ?? null,
      confidence: 0.4,
      reason: `${result.solutions.length} materially different payment sets reproduce this credit, and nothing in the sources chooses between them`,
      evidence,
      alternatives: result.solutions.length,
    };
  }

  // No subset reproduces the credit. Two very different situations, and conflating them
  // would waste the most valuable output this system has.
  //
  // If the batch day carried a cross currency payment, no subset containing it can ever
  // tie exactly, because its rupee value is a conversion rather than a fact. That is a row
  // this data cannot decide, and it goes to review.
  //
  // Otherwise, nothing in any source explains this money. That is the orphan credit, and
  // saying so plainly is the point of the whole system.
  if (anchorDayHasConversion(anchorDate, ctx.valued)) {
    return {
      ...base,
      verdict: "REVIEW",
      tier,
      settlementId: settlement?.id ?? null,
      confidence: 0.45,
      reason:
        "no batch ties exactly, and the batch day contains a payment taken in another currency whose rupee value is a conversion, so an exact tie was never available",
      evidence: [
        ...evidence,
        "a gateway settles a cross currency payment at its own rate and timestamp, which a published daily rate does not reproduce",
      ],
      alternatives: 0,
    };
  }

  return {
    ...base,
    verdict: "REFUSED",
    tier: "T6",
    settlementId: settlement?.id ?? null,
    confidence: 0.6,
    reason: settlement
      ? "a settlement was identified but no set of payments reproduces its gross, so the batch cannot be explained"
      : "no settlement row and no set of payments reproduces this credit, so nothing in the sources explains this money",
    evidence,
    alternatives: 0,
  };
}

/** Small helper used by the report. */
export function totalOf(decisions: readonly Decision[], verdict: Verdict): number {
  return decisions.filter((d) => d.verdict === verdict).length;
}

export function zeroMoney(): Money {
  return fromMinor(0n, "INR");
}
