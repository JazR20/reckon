/**
 * The merchant's contracted rate card, and the arithmetic a settlement performs.
 *
 * The matcher legitimately knows this. A merchant has a signed pricing schedule and a
 * published GST rate, so reconstructing what a payout should have been is not cheating,
 * it is the job. What the matcher does NOT know is which payments went into which batch,
 * and that is the part it has to recover.
 *
 * A wrong rate card is its own failure mode: every arithmetic check silently drifts and
 * correct matches start failing verification. `blendedUpperBound` exists so the solver can
 * bound its search without assuming the card is exactly right.
 */

import {
  type Money,
  add,
  multiplyRational,
  subtract,
  sum,
  zero,
} from "../money/index.ts";
import type { PaymentRow } from "../ingest/sources.ts";

/** Basis points of gross, by payment method. Mirrors the merchant's pricing schedule. */
export const FEE_BPS: Record<string, number> = {
  upi: 90,
  card: 200,
  netbanking: 190,
  wallet: 200,
  card_intl: 300,
};

export const GST_ON_FEE_BPS = 1800n;
export const TDS_BPS = 100n;

/** Widest plausible total deduction, used only to bound a search, never to decide. */
export const BLENDED_UPPER_BOUND_BPS = 500;

export interface PaymentEconomics {
  readonly gross: Money;
  readonly fee: Money;
  readonly tds: Money;
}

export function economicsOf(payment: PaymentRow, grossInReporting: Money): PaymentEconomics {
  const bps = FEE_BPS[payment.method];
  if (bps === undefined) {
    // an unknown method is not a zero fee. Guessing zero would make the arithmetic tie
    // for the wrong reason, which is worse than not tying at all
    throw new Error(
      `No rate card entry for payment method ${JSON.stringify(payment.method)}. ` +
        `Refusing to assume a fee, because an assumed fee produces a settlement that ` +
        `reconciles for the wrong reason.`,
    );
  }
  return {
    gross: grossInReporting,
    fee: multiplyRational(grossInReporting, BigInt(bps), 10000n),
    tds: payment.b2b ? multiplyRational(grossInReporting, TDS_BPS, 10000n) : zero(grossInReporting.currency),
  };
}

/**
 * What a batch of payments should be credited as, net of everything.
 *
 * GST is applied to the SUMMED fee and rounded once, not applied per payment. That single
 * rounding point is why a subset cannot be scored by summing per payment net figures: the
 * error accumulates in the wrong direction. The solver therefore computes this exactly for
 * every candidate rather than working with a per payment approximation.
 */
export function netOfBatch(
  economics: readonly PaymentEconomics[],
  refundsDeducted: Money,
): { gross: Money; fee: Money; tax: Money; tds: Money; net: Money } {
  const currency = refundsDeducted.currency;
  const gross = sum(economics.map((e) => e.gross), currency);
  const fee = sum(economics.map((e) => e.fee), currency);
  const tax = multiplyRational(fee, GST_ON_FEE_BPS, 10000n);
  const tds = sum(economics.map((e) => e.tds), currency);
  const net = subtract(subtract(subtract(subtract(gross, fee), tax), tds), refundsDeducted);
  return { gross, fee, tax, tds, net };
}

/** A rough inverse, used only to bound a search window. Never used to decide a match. */
export function estimateGrossFromNet(net: Money): { low: Money; high: Money } {
  const low = net;
  const high = add(net, multiplyRational(net, BigInt(BLENDED_UPPER_BOUND_BPS + 200), 10000n));
  return { low, high };
}
