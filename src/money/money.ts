import {
  type Currency,
  exponentOf,
  isCurrency,
  scaleOf,
  symbolOf,
} from "./currency.ts";
import {
  AllocationError,
  CurrencyMismatchError,
  MoneyParseError,
  RateMismatchError,
} from "./errors.ts";

/**
 * Money.
 *
 * An amount is a pair of a magnitude in minor units and a currency, and neither half is
 * meaningful alone. The brand makes the pair nominal, so a plain object of the same
 * shape cannot be passed where a Money is expected, and a number can never be.
 *
 * There is deliberately no accessor returning a JavaScript number for the value. The
 * only exits from this type are format(), toDecimalString() and toMinor(), and the last
 * returns a bigint. Floating point never touches a monetary value.
 */

const BRAND: unique symbol = Symbol("reckon.Money");

export interface Money {
  readonly [BRAND]: true;
  readonly minor: bigint;
  readonly currency: Currency;
}

/**
 * A directional exchange rate. Conversion is an explicit operation that carries its rate
 * so the rate can be printed into the evidence chain a human reviews.
 *
 * The rate is held as an exact rational, never as a float, because 1/3 of a rupee is a
 * real quantity and 0.3333333333333333 is not.
 */
export interface Rate {
  readonly from: Currency;
  readonly to: Currency;
  /** numerator and denominator of the exact rate, in major units */
  readonly numerator: bigint;
  readonly denominator: bigint;
  /** free text describing where this rate came from, for the audit trail */
  readonly source: string;
}

export type Rounding = "half-even" | "half-up" | "down";

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

function make(minor: bigint, currency: Currency): Money {
  return { [BRAND]: true, minor, currency };
}

/** Construct from an exact count of minor units. The only cheap constructor. */
export function fromMinor(minor: bigint | number, currency: Currency): Money {
  if (typeof minor === "number") {
    if (!Number.isSafeInteger(minor)) {
      throw new MoneyParseError(
        String(minor),
        currency,
        "a minor unit count must be a safe integer. Fractional minor units do not exist",
      );
    }
    return make(BigInt(minor), currency);
  }
  return make(minor, currency);
}

/**
 * Construct from a decimal string such as "1234.50".
 *
 * A string, not a number. Accepting a JavaScript number here would reintroduce binary
 * floating point at the boundary, and 0.1 + 0.2 is not 0.3 in any currency.
 */
export function fromDecimalString(input: string, currency: Currency): Money {
  const trimmed = input.trim().replace(/,/g, "");
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new MoneyParseError(input, currency, "not a plain decimal number");
  }
  const [, sign, whole, fraction = ""] = match;
  const exponent = exponentOf(currency);
  if (fraction.length > exponent) {
    throw new MoneyParseError(
      input,
      currency,
      `${currency} has ${exponent} minor digits but ${fraction.length} were supplied. ` +
        `Rounding here would be a silent loss, so it is refused`,
    );
  }
  const padded = fraction.padEnd(exponent, "0");
  const magnitude = BigInt((whole ?? "0") + padded);
  return make(sign === "-" ? -magnitude : magnitude, currency);
}

export function zero(currency: Currency): Money {
  return make(0n, currency);
}

/** Runtime guard, used at ingest boundaries where the input is untrusted. */
export function isMoney(value: unknown): value is Money {
  return (
    typeof value === "object" &&
    value !== null &&
    BRAND in value &&
    typeof (value as Money).minor === "bigint" &&
    isCurrency((value as Money).currency)
  );
}

// ---------------------------------------------------------------------------
// arithmetic
// ---------------------------------------------------------------------------

function assertSame(a: Money, b: Money, operation: string): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency, operation);
  }
}

export function add(a: Money, b: Money): Money {
  assertSame(a, b, "add");
  return make(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSame(a, b, "subtract");
  return make(a.minor - b.minor, a.currency);
}

export function negate(a: Money): Money {
  return make(-a.minor, a.currency);
}

export function abs(a: Money): Money {
  return make(a.minor < 0n ? -a.minor : a.minor, a.currency);
}

/** Sum a list. An empty list needs a currency, because a currencyless zero is a bug. */
export function sum(amounts: readonly Money[], currency: Currency): Money {
  let total = 0n;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      throw new CurrencyMismatchError(currency, amount.currency, "sum");
    }
    total += amount.minor;
  }
  return make(total, currency);
}

/** Multiply by an exact rational, for example a fee of 2.36 percent as 236/10000. */
export function multiplyRational(
  amount: Money,
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding = "half-even",
): Money {
  if (denominator === 0n) {
    throw new AllocationError("Cannot multiply by a rational with a zero denominator");
  }
  return make(divideRounded(amount.minor * numerator, denominator, rounding), amount.currency);
}

function divideRounded(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  if (remainder === 0n) return negative ? -quotient : quotient;

  let rounded = quotient;
  if (rounding === "down") {
    rounded = quotient;
  } else {
    const twice = remainder * 2n;
    if (twice > d) {
      rounded = quotient + 1n;
    } else if (twice < d) {
      rounded = quotient;
    } else {
      // exactly half
      rounded = rounding === "half-up" ? quotient + 1n : quotient + (quotient % 2n);
    }
  }
  return negative ? -rounded : rounded;
}

/**
 * Split an amount across weights without losing or inventing a single minor unit.
 *
 * Largest remainder method. This matters for apportioning a settlement fee back across
 * the payments in a bundle: naive per item rounding drifts, and a drift of three paise
 * across a sixty payment bundle is exactly the kind of discrepancy that sends a correct
 * match to REVIEW for no reason.
 *
 * Postcondition, asserted: sum(result) === amount.
 */
export function allocate(amount: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) {
    throw new AllocationError("Cannot allocate across zero weights");
  }
  if (weights.some((w) => w < 0n)) {
    throw new AllocationError("Cannot allocate across a negative weight");
  }
  const totalWeight = weights.reduce((acc, w) => acc + w, 0n);
  if (totalWeight === 0n) {
    throw new AllocationError("Cannot allocate across weights that sum to zero");
  }

  const shares: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let distributed = 0n;

  for (let i = 0; i < weights.length; i++) {
    const weight = weights[i] as bigint;
    const exact = amount.minor * weight;
    const share = exact / totalWeight;
    shares.push(share);
    distributed += share;
    remainders.push({ index: i, remainder: exact % totalWeight });
  }

  // hand out the leftover minor units to the largest remainders first
  let leftover = amount.minor - distributed;
  const step = leftover < 0n ? -1n : 1n;
  remainders.sort((a, b) =>
    b.remainder === a.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1,
  );
  let cursor = 0;
  while (leftover !== 0n) {
    const target = remainders[cursor % remainders.length] as { index: number };
    shares[target.index] = (shares[target.index] as bigint) + step;
    leftover -= step;
    cursor++;
  }

  const result = shares.map((minor) => make(minor, amount.currency));
  const check = sum(result, amount.currency);
  if (check.minor !== amount.minor) {
    throw new AllocationError(
      `allocate lost value: ${amount.minor} in, ${check.minor} out. This is a bug in allocate`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// conversion
// ---------------------------------------------------------------------------

/**
 * Convert with an explicit rate. There is no implicit conversion anywhere in this
 * module, and this is the only function that returns an amount in a different currency
 * from the one it received.
 */
export function convert(amount: Money, rate: Rate, rounding: Rounding = "half-even"): Money {
  if (amount.currency !== rate.from) {
    throw new RateMismatchError(rate.from, amount.currency);
  }
  const fromScale = scaleOf(rate.from);
  const toScale = scaleOf(rate.to);
  // minor_to = minor_from * (num/den) * (toScale/fromScale)
  const numerator = amount.minor * rate.numerator * toScale;
  const denominator = rate.denominator * fromScale;
  return make(divideRounded(numerator, denominator, rounding), rate.to);
}

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b, "compare");
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

export function isZero(a: Money): boolean {
  return a.minor === 0n;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0n;
}

export function isPositive(a: Money): boolean {
  return a.minor > 0n;
}

/** Within a tolerance, for fee arithmetic where a rounding difference of one paisa is not a mismatch. */
export function equalsWithin(a: Money, b: Money, tolerance: Money): boolean {
  assertSame(a, b, "compare");
  assertSame(a, tolerance, "compare");
  const difference = a.minor - b.minor;
  const magnitude = difference < 0n ? -difference : difference;
  return magnitude <= (tolerance.minor < 0n ? -tolerance.minor : tolerance.minor);
}

// ---------------------------------------------------------------------------
// display edge
// ---------------------------------------------------------------------------

export function toMinor(amount: Money): bigint {
  return amount.minor;
}

export function toDecimalString(amount: Money): string {
  const exponent = exponentOf(amount.currency);
  const negative = amount.minor < 0n;
  const magnitude = (negative ? -amount.minor : amount.minor).toString().padStart(exponent + 1, "0");
  const whole = magnitude.slice(0, magnitude.length - exponent) || "0";
  const fraction = exponent === 0 ? "" : "." + magnitude.slice(magnitude.length - exponent);
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

export function format(amount: Money): string {
  return `${symbolOf(amount.currency)}${toDecimalString(amount)}`;
}

/** Stable serialisation for the audit trail. Never lossy, always round trips. */
export function toJSON(amount: Money): { minor: string; currency: Currency } {
  return { minor: amount.minor.toString(), currency: amount.currency };
}

export function fromJSON(value: { minor: string; currency: Currency }): Money {
  return make(BigInt(value.minor), value.currency);
}
