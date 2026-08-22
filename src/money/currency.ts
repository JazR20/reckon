/**
 * Currencies this system knows about, and the number of minor units in one major unit.
 *
 * The exponent is not assumed to be 2. It is looked up. A system that hardcodes 2 is
 * correct until the first JPY record arrives and then it is silently wrong by a factor
 * of one hundred, which is exactly the class of failure this module exists to prevent.
 */

export const CURRENCY_EXPONENT = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
} as const;

export type Currency = keyof typeof CURRENCY_EXPONENT;

export const CURRENCIES = Object.keys(CURRENCY_EXPONENT) as readonly Currency[];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && value in CURRENCY_EXPONENT;
}

export function exponentOf(currency: Currency): number {
  return CURRENCY_EXPONENT[currency];
}

/** 10 ** exponent, as a bigint, for exact scaling between major and minor units. */
export function scaleOf(currency: Currency): bigint {
  return 10n ** BigInt(CURRENCY_EXPONENT[currency]);
}

const SYMBOL: Record<Currency, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

export function symbolOf(currency: Currency): string {
  return SYMBOL[currency];
}
