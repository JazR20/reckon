/**
 * The synthetic merchant.
 *
 * A small Indian direct to consumer brand with a one off catalogue and a three tier
 * subscription. That shape is chosen deliberately: subscriptions create a small number of
 * repeated price points, which produces genuine amount collisions on the same day without
 * having to fabricate them, and amount collision is failure class F04, the hardest
 * honest case in the corpus.
 *
 * Nothing here is real. No brand, customer, product, amount or narration string is drawn
 * from any live dataset. See docs/REDLINES.md.
 */

import type { Currency } from "../../src/money/index.ts";

export const MERCHANT = {
  name: "Saanjh Goods",
  legalName: "SAANJH GOODS PRIVATE LIMITED",
  bankAccountLast4: "4417",
  currency: "INR" as Currency,
} as const;

// ---------------------------------------------------------------------------
// what the merchant sells
// ---------------------------------------------------------------------------

export interface Sku {
  readonly code: string;
  readonly name: string;
  /** rupees, as a decimal string, because a price is money and money is not a number */
  readonly price: string;
}

export const SKUS: readonly Sku[] = [
  { code: "SG-TEA-01", name: "Assam breakfast tea 250g", price: "349.00" },
  { code: "SG-TEA-02", name: "Nilgiri green tea 250g", price: "399.00" },
  { code: "SG-HON-01", name: "Wild forest honey 500g", price: "599.00" },
  { code: "SG-GHE-01", name: "Bilona ghee 500ml", price: "899.00" },
  { code: "SG-MSL-01", name: "Masala sampler box", price: "1249.00" },
  { code: "SG-GFT-01", name: "Festive gift hamper", price: "1899.00" },
  { code: "SG-GFT-02", name: "Premium gift hamper", price: "2499.00" },
  { code: "SG-BLK-01", name: "Bulk pantry crate", price: "3499.00" },
];

export interface Plan {
  readonly code: string;
  readonly name: string;
  readonly price: string;
}

/**
 * Three price points, charged monthly to a stable base of subscribers. Two subscribers
 * on the same plan billing on the same day produce two payments of exactly the same
 * amount on exactly the same date, which is F04 arising naturally rather than by
 * injection.
 */
export const PLANS: readonly Plan[] = [
  { code: "SG-SUB-S", name: "Pantry box, small", price: "499.00" },
  { code: "SG-SUB-M", name: "Pantry box, medium", price: "999.00" },
  { code: "SG-SUB-L", name: "Pantry box, large", price: "1799.00" },
];

// ---------------------------------------------------------------------------
// how customers pay
// ---------------------------------------------------------------------------

export type Method = "upi" | "card" | "netbanking" | "wallet" | "card_intl";

/** Rough Indian D2C mix. Weights need not sum to one. */
export const METHOD_MIX: ReadonlyArray<readonly [Method, number]> = [
  ["upi", 54],
  ["card", 25],
  ["netbanking", 11],
  ["wallet", 7],
  ["card_intl", 3],
];

/**
 * Fee schedule in basis points of the gross amount.
 *
 * Synthetic and plausible. This is NOT a quote of live Razorpay pricing and must not be
 * read as one. What matters for the corpus is that the rate varies by method, because a
 * single blended rate would make the settlement arithmetic in F03 trivially invertible
 * and the tier 2 solver would have nothing to do.
 */
export const FEE_BPS: Record<Method, number> = {
  upi: 90,
  card: 200,
  netbanking: 190,
  wallet: 200,
  card_intl: 300,
};

/** GST on the platform fee, in basis points. */
export const GST_ON_FEE_BPS = 1800;

/**
 * Tax deducted at source, in basis points of gross, applied only to orders flagged as
 * business to business. Produces settlements whose arithmetic needs a second deduction
 * term that is not derivable from the method alone.
 */
export const TDS_BPS = 100;
export const B2B_SHARE = 0.12;

/** Working days between capture and the bank credit. */
export const SETTLEMENT_LAG_WORKING_DAYS = 2;

// ---------------------------------------------------------------------------
// customers
// ---------------------------------------------------------------------------

/**
 * Customer references are opaque tokens, never names. The matcher has no business
 * reasoning about who a customer is, and a corpus containing anything person shaped
 * invites exactly the leak docs/REDLINES.md forbids.
 */
export function customerRef(index: number): string {
  return `CUS${(index + 1).toString().padStart(5, "0")}`;
}

// ---------------------------------------------------------------------------
// bank narration
// ---------------------------------------------------------------------------

/**
 * Narration templates in the shapes Indian bank statement exports actually produce.
 *
 * Six formats, because a real statement mixes rails and each rail formats differently.
 * The reference token sits in a different position in each one, and in two of them it is
 * adjacent to other long opaque tokens that look just like it. That is the whole
 * difficulty of failure class F06: extracting the reference is a parsing problem over
 * inconsistent free text, which is the one place in this system where a language model
 * is doing work that deterministic code cannot do cleanly.
 */
export type NarrationStyle =
  | "neft"
  | "rtgs"
  | "imps"
  | "mobile"
  | "corporate"
  | "terse";

export const NARRATION_STYLES: ReadonlyArray<readonly [NarrationStyle, number]> = [
  ["neft", 34],
  ["rtgs", 12],
  ["imps", 18],
  ["mobile", 14],
  ["corporate", 14],
  ["terse", 8],
];

export function renderNarration(
  style: NarrationStyle,
  utr: string,
  gatewayName: string,
  noise: string,
): string {
  switch (style) {
    case "neft":
      return `NEFT-${utr}-${gatewayName}-HDFC0000060-N${noise}`;
    case "rtgs":
      return `RTGS-${utr}-${gatewayName} PVT LTD-UTIB0000021`;
    case "imps":
      return `IMPS/P2A/${noise}/${gatewayName}/UTIB/${utr}`;
    case "mobile":
      return `MB:${gatewayName}-SETTLEMENT-${utr}`;
    case "corporate":
      return `CORP FUND TRF ${gatewayName} REF ${utr} BATCH ${noise}`;
    case "terse":
      return `${utr} ${gatewayName}`;
  }
}

export const GATEWAY_NAME = "RAZORPAY SOFTWARE";
