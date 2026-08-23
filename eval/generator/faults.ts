/**
 * Data quality corruption, applied on top of the clean world.
 *
 * The catalogue splits into three kinds and it is worth being precise about which is
 * which, because they are not interchangeable.
 *
 * STRUCTURAL, always present, produced by world.ts because they are simply how
 * settlement works: F02 bundling, F03 fee, GST and TDS deduction, F09 refunds netted off
 * a payout, F10 chargebacks, F08 orphan credits.
 *
 * INJECTED, applied here at a configured rate, one decision per record:
 * F01 unit ambiguity, F04 amount collision amplification, F05 date skew,
 * F06 narration damage, F11 foreign currency, F12 duplicate rows.
 *
 * RUN LEVEL, and deliberately NOT in the scored corpus: F07 silent truncation.
 *
 * F07 is excluded for a reason worth stating rather than hiding. The correct response to
 * a source file that is silently incomplete is to refuse the entire run, because a
 * reconciliation over a partial set is not partially correct, it is wrong. A run level
 * refusal cannot coexist with a per record scoreboard: there would be no records to
 * score. So F07 is exercised by a dedicated fixture and a test that asserts the run is
 * refused, and it is reported separately from the batch metrics rather than being
 * quietly softened into a warning so that it fits the table.
 */

import type { Currency } from "../../src/money/index.ts";
import { type IsoDate, addDays } from "./dates.ts";
import type { Rng } from "./rng.ts";
import type { FaultCode, TruthEntry, World } from "./world.ts";

export type NarrationDamage =
  /** the reference is cut mid token by a fixed width field */
  | "truncate_ref"
  /** the reference is absent from the narration entirely */
  | "drop_ref"
  /** the reference is present but surrounded by tokens of the same shape */
  | "decoy_tokens";

export interface ForeignPayment {
  readonly currency: Currency;
  readonly rateNumerator: bigint;
  readonly rateDenominator: bigint;
}

export interface Corruption {
  /** bank txn id, to the number of days its statement date is shifted */
  readonly bankDateSkew: ReadonlyMap<string, number>;
  readonly narrationDamage: ReadonlyMap<string, NarrationDamage>;
  /** payment id, to the currency it is reported in and the rate back to INR */
  readonly foreignPayments: ReadonlyMap<string, ForeignPayment>;
  /** dates for which no rate is published, so a foreign payment cannot be resolved */
  readonly missingRateDates: ReadonlySet<IsoDate>;
  /** bank txn ids whose credit column is emitted with an ambiguous unit */
  readonly unitAmbiguous: ReadonlySet<string>;
  /** payment ids emitted twice, and bank txn ids emitted twice */
  readonly duplicatedPaymentIds: readonly string[];
  readonly duplicatedBankTxnIds: readonly string[];
}

export interface FaultConfig {
  readonly dateSkewRate: number;
  readonly narrationDamageRate: number;
  readonly foreignPaymentRate: number;
  readonly missingRateDayCount: number;
  readonly unitAmbiguityCount: number;
  readonly duplicatePaymentCount: number;
  readonly duplicateBankTxnCount: number;
}

const FOREIGN: ReadonlyArray<readonly [Currency, bigint, bigint]> = [
  // currency, numerator, denominator of the rate to INR in major units
  ["USD", 8371n, 100n],
  ["EUR", 9042n, 100n],
  ["GBP", 10588n, 100n],
];

export function planCorruption(
  rootRng: Rng,
  world: World,
  config: FaultConfig,
): { corruption: Corruption; truth: TruthEntry[] } {
  const extraFaults = new Map<string, Set<FaultCode>>();
  const addFault = (bankTxnId: string, code: FaultCode): void => {
    const existing = extraFaults.get(bankTxnId);
    if (existing) existing.add(code);
    else extraFaults.set(bankTxnId, new Set([code]));
  };

  // ---- F05: the statement date lands either side of the settlement date ----
  const skewRng = rootRng.fork("f05");
  const bankDateSkew = new Map<string, number>();
  for (const txn of world.bankTxns) {
    if (!skewRng.bool(config.dateSkewRate)) continue;
    const shift = skewRng.weighted([
      [-1, 3],
      [1, 5],
      [2, 2],
      [3, 1],
    ] as const);
    bankDateSkew.set(txn.id, shift);
    addFault(txn.id, "F05");
  }

  // ---- F06: the reference is damaged inside the narration ----
  const narrationRng = rootRng.fork("f06");
  const narrationDamage = new Map<string, NarrationDamage>();
  for (const txn of world.bankTxns) {
    if (!narrationRng.bool(config.narrationDamageRate)) continue;
    const damage = narrationRng.weighted([
      ["truncate_ref", 4],
      ["drop_ref", 3],
      ["decoy_tokens", 3],
    ] as const);
    narrationDamage.set(txn.id, damage);
    addFault(txn.id, "F06");
  }

  // ---- F11: a share of payments were taken in a foreign currency ----
  const fxRng = rootRng.fork("f11");
  const foreignPayments = new Map<string, ForeignPayment>();
  const capturedPayments = world.payments.filter((p) => p.status === "captured");
  for (const payment of capturedPayments) {
    if (!fxRng.bool(config.foreignPaymentRate)) continue;
    const [currency, rateNumerator, rateDenominator] = fxRng.pick(FOREIGN);
    foreignPayments.set(payment.id, { currency, rateNumerator, rateDenominator });
  }

  // dates with no published rate, so any foreign payment on them is unresolvable
  const foreignDates = [
    ...new Set(
      capturedPayments
        .filter((p) => foreignPayments.has(p.id))
        .map((p) => p.capturedAt),
    ),
  ].sort();
  const missingRateDates = new Set<IsoDate>(
    foreignDates.length > 0
      ? fxRng.sample(foreignDates, Math.min(config.missingRateDayCount, foreignDates.length))
      : [],
  );

  // any settlement containing a foreign payment carries F11
  const paymentToBankTxn = new Map<string, string>();
  for (const entry of world.truth) {
    for (const pid of entry.paymentIds) paymentToBankTxn.set(pid, entry.bankTxnId);
  }
  for (const pid of foreignPayments.keys()) {
    const bankTxnId = paymentToBankTxn.get(pid);
    if (bankTxnId) addFault(bankTxnId, "F11");
  }

  // ---- F01: a credit whose unit cannot be determined from the row ----
  const unitRng = rootRng.fork("f01");
  const settlementTxns = world.truth
    .filter((t) => t.settlementId !== null)
    .map((t) => t.bankTxnId);
  const unitAmbiguous = new Set<string>(
    unitRng.sample(settlementTxns, Math.min(config.unitAmbiguityCount, settlementTxns.length)),
  );
  for (const id of unitAmbiguous) addFault(id, "F01");

  // ---- F12: the same row appears twice in an export ----
  const dupRng = rootRng.fork("f12");
  const duplicatedPaymentIds = dupRng.sample(
    capturedPayments.map((p) => p.id),
    Math.min(config.duplicatePaymentCount, capturedPayments.length),
  );
  const duplicatedBankTxnIds = dupRng.sample(
    world.bankTxns.map((t) => t.id),
    Math.min(config.duplicateBankTxnCount, world.bankTxns.length),
  );
  for (const id of duplicatedBankTxnIds) addFault(id, "F12");
  for (const pid of duplicatedPaymentIds) {
    const bankTxnId = paymentToBankTxn.get(pid);
    if (bankTxnId) addFault(bankTxnId, "F12");
  }

  // ---- F04: interchangeable payments ----
  //
  // Two earlier definitions of this class were both wrong, and the reasoning is worth
  // keeping because it is the same reasoning the matcher will have to do.
  //
  // The first labelled any settlement containing two same day same amount payments. That
  // marked 91 percent of rows. A label carried by nine rows in ten distinguishes nothing.
  //
  // The second labelled bank credits sharing an exact amount within a few days. That
  // marked 0.5 percent, because a settlement net carries fee, GST and TDS arithmetic down
  // to the paisa and two of them effectively never collide. A class with two members
  // cannot support a precision number either.
  //
  // The real case is one level down and it is genuinely undecidable. Two payments of the
  // same amount captured on the same day, where late settlement has put one in this batch
  // and the other in a different batch. Both subsets tie to the credit exactly. Nothing
  // in any source file says which of the two identical payments is in which batch, so a
  // matcher that names one is guessing at a coin flip.
  //
  // This interacts with the scoring rule and the interaction is reported rather than
  // smoothed over: under the strict rule the payment set is wrong, so it counts as a
  // miss, even though the money is right to the paisa. The report carries both a strict
  // set accuracy and a value equivalent accuracy for exactly this reason.
  const twinKey = (p: { gross: { minor: bigint }; capturedAt: IsoDate }): string =>
    `${p.capturedAt}|${p.gross.minor}`;

  const twinsByKey = new Map<string, string[]>();
  for (const payment of capturedPayments) {
    const key = twinKey(payment);
    const bucket = twinsByKey.get(key);
    if (bucket) bucket.push(payment.id);
    else twinsByKey.set(key, [payment.id]);
  }

  for (const ids of twinsByKey.values()) {
    if (ids.length < 2) continue;
    // only a genuine ambiguity when the twins were split across different batches
    const batches = new Set(ids.map((pid) => paymentToBankTxn.get(pid)).filter(Boolean));
    if (batches.size < 2) continue;
    for (const batch of batches) addFault(batch as string, "F04");
  }

  const truth: TruthEntry[] = world.truth.map((entry) => {
    const extra = extraFaults.get(entry.bankTxnId);
    if (!extra) return entry;
    const merged = [...new Set([...entry.faults, ...extra])].sort() as FaultCode[];
    return { ...entry, faults: merged };
  });

  return {
    corruption: {
      bankDateSkew,
      narrationDamage,
      foreignPayments,
      missingRateDates,
      unitAmbiguous,
      duplicatedPaymentIds,
      duplicatedBankTxnIds,
    },
    truth,
  };
}

/** Apply a date skew to a statement date. */
export function skewDate(date: IsoDate, skew: number | undefined): IsoDate {
  return skew === undefined ? date : addDays(date, skew);
}

/**
 * Damage a narration string.
 *
 * `truncate_ref` cuts the whole narration at a fixed width, which is what a legacy core
 * banking export does and which frequently lands mid reference.
 * `drop_ref` removes the reference token but leaves the rest intact.
 * `decoy_tokens` keeps the reference and adds two other tokens of identical shape, so a
 * naive regex for "sixteen alphanumerics" returns three candidates and has no basis for
 * choosing between them.
 */
export function damageNarration(
  narration: string,
  reference: string,
  damage: NarrationDamage | undefined,
  rng: Rng,
): string {
  if (damage === undefined) return narration;
  switch (damage) {
    case "truncate_ref": {
      const width = rng.int(18, 30);
      return narration.slice(0, width);
    }
    case "drop_ref":
      return narration.replace(reference, "").replace(/\s{2,}/g, " ").replace(/--+/g, "-").trim();
    case "decoy_tokens": {
      const decoyA = `${rng.pick(["CITIN5", "HDFCN5", "UTIBN5"])}${rng.token(10)}`;
      const decoyB = `${rng.pick(["CITIN5", "HDFCN5", "UTIBN5"])}${rng.token(10)}`;
      return `${narration} ${decoyA} ${decoyB}`;
    }
  }
}
