import type { Currency } from "./currency.ts";

/**
 * Every error in this module is loud and specific. The failure mode being defended
 * against is a wrong number that looks right, so none of these are recoverable by
 * returning a default, and none of them are warnings.
 */

export class MoneyError extends Error {
  override readonly name: string = "MoneyError";
}

/**
 * Raised when two amounts in different currencies meet in an arithmetic operation.
 *
 * This is the guard for failure class F01. In the incident that motivated this module,
 * two layers of one system each applied a conversion and the result was a plausible
 * number roughly 3.6x the true value. Nothing caught it because the currency was a
 * label on the side of a number rather than part of the value.
 */
export class CurrencyMismatchError extends MoneyError {
  override readonly name = "CurrencyMismatchError";
  readonly left: Currency;
  readonly right: Currency;

  constructor(left: Currency, right: Currency, operation: string) {
    super(
      `Cannot ${operation} ${left} and ${right}. ` +
        `Currencies must match exactly. If a conversion is intended it must be explicit ` +
        `via convert() with a stated Rate, so the rate appears in the evidence chain.`,
    );
    this.left = left;
    this.right = right;
  }
}

/** Raised when a decimal string cannot be parsed exactly into minor units. */
export class MoneyParseError extends MoneyError {
  override readonly name = "MoneyParseError";
  constructor(input: string, currency: Currency, reason: string) {
    super(`Cannot parse ${JSON.stringify(input)} as ${currency}: ${reason}`);
  }
}

/** Raised when a rate is applied to the wrong currency pair. */
export class RateMismatchError extends MoneyError {
  override readonly name = "RateMismatchError";
  constructor(expected: Currency, actual: Currency) {
    super(
      `Rate expects a ${expected} amount but received ${actual}. ` +
        `A Rate is directional and cannot be applied in reverse implicitly.`,
    );
  }
}

/** Raised when an allocation cannot be performed, for example on empty or negative weights. */
export class AllocationError extends MoneyError {
  override readonly name = "AllocationError";
}
