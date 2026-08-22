import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type Rate,
  add,
  allocate,
  convert,
  CurrencyMismatchError,
  equals,
  equalsWithin,
  format,
  fromDecimalString,
  fromJSON,
  fromMinor,
  isMoney,
  multiplyRational,
  MoneyParseError,
  RateMismatchError,
  subtract,
  sum,
  toDecimalString,
  toJSON,
  zero,
} from "./index.ts";

describe("construction", () => {
  it("parses a plain decimal string exactly", () => {
    assert.equal(fromDecimalString("1234.50", "INR").minor, 123450n);
    assert.equal(fromDecimalString("0.01", "INR").minor, 1n);
    assert.equal(fromDecimalString("-99.99", "USD").minor, -9999n);
  });

  it("accepts a whole number with no fractional part", () => {
    assert.equal(fromDecimalString("1234", "INR").minor, 123400n);
  });

  it("strips thousands separators from bank exports", () => {
    assert.equal(fromDecimalString("47,318.20", "INR").minor, 4731820n);
  });

  it("refuses more precision than the currency has, rather than rounding silently", () => {
    assert.throws(() => fromDecimalString("10.005", "INR"), MoneyParseError);
  });

  it("honours a zero exponent currency", () => {
    assert.equal(fromDecimalString("500", "JPY").minor, 500n);
    assert.equal(toDecimalString(fromMinor(500n, "JPY")), "500");
  });

  it("refuses a fractional minor unit count", () => {
    assert.throws(() => fromMinor(10.5, "INR"), MoneyParseError);
  });

  it("refuses input that is not a plain decimal", () => {
    assert.throws(() => fromDecimalString("1.2e3", "INR"), MoneyParseError);
    assert.throws(() => fromDecimalString("₹100", "INR"), MoneyParseError);
    assert.throws(() => fromDecimalString("", "INR"), MoneyParseError);
  });
});

describe("F01: currency is part of the value, not a label beside it", () => {
  it("refuses to add two currencies", () => {
    const rupees = fromDecimalString("100.00", "INR");
    const dollars = fromDecimalString("100.00", "USD");
    assert.throws(() => add(rupees, dollars), CurrencyMismatchError);
  });

  it("refuses to subtract two currencies", () => {
    assert.throws(
      () => subtract(fromDecimalString("100.00", "INR"), fromDecimalString("1.00", "EUR")),
      CurrencyMismatchError,
    );
  });

  it("refuses to sum a list containing a foreign amount", () => {
    assert.throws(
      () => sum([fromMinor(100n, "INR"), fromMinor(100n, "USD")], "INR"),
      CurrencyMismatchError,
    );
  });

  /**
   * Incident B, reproduced.
   *
   * A conversion was applied on write and applied again on read. The second application
   * had no way to know the first had happened, because the value carried no currency, so
   * the result was a plausible number of the wrong magnitude and nothing anywhere
   * objected.
   *
   * Under this type the second conversion cannot be expressed. The rate is directional
   * and the amount already carries the destination currency, so applying the same rate
   * twice is a type level and runtime error rather than a silent multiplication.
   */
  it("makes a double conversion impossible to express", () => {
    const usdToInr: Rate = {
      from: "USD",
      to: "INR",
      numerator: 8371n,
      denominator: 100n,
      source: "test fixture",
    };
    const gross = fromDecimalString("100.00", "USD");
    const converted = convert(gross, usdToInr);
    assert.equal(converted.currency, "INR");
    assert.equal(toDecimalString(converted), "8371.00");

    // the round trip that caused the incident
    assert.throws(() => convert(converted, usdToInr), RateMismatchError);
  });

  it("carries the rate so it can be printed into the evidence chain", () => {
    const rate: Rate = {
      from: "USD",
      to: "INR",
      numerator: 8371n,
      denominator: 100n,
      source: "RBI reference rate 2026-08-22",
    };
    assert.equal(rate.source, "RBI reference rate 2026-08-22");
  });
});

describe("arithmetic", () => {
  it("adds and subtracts exactly", () => {
    const a = fromDecimalString("0.10", "INR");
    const b = fromDecimalString("0.20", "INR");
    assert.ok(equals(add(a, b), fromDecimalString("0.30", "INR")));
  });

  it("applies a percentage fee as an exact rational", () => {
    // 2.36 percent of 1000.00 is 23.60 exactly
    const gross = fromDecimalString("1000.00", "INR");
    const fee = multiplyRational(gross, 236n, 10000n);
    assert.equal(toDecimalString(fee), "23.60");
  });

  it("rounds half to even by default", () => {
    // 0.5 minor units in each direction
    assert.equal(multiplyRational(fromMinor(5n, "INR"), 1n, 2n).minor, 2n);
    assert.equal(multiplyRational(fromMinor(15n, "INR"), 1n, 2n).minor, 8n);
  });

  it("compares within a tolerance for fee rounding drift", () => {
    const a = fromDecimalString("47318.20", "INR");
    const b = fromDecimalString("47318.19", "INR");
    const onePaisa = fromMinor(1n, "INR");
    assert.ok(equalsWithin(a, b, onePaisa));
    assert.ok(!equalsWithin(a, b, zero("INR")));
  });
});

describe("allocate", () => {
  it("never loses or invents a minor unit", () => {
    const fee = fromDecimalString("10.00", "INR");
    const shares = allocate(fee, [1n, 1n, 1n]);
    assert.equal(shares.length, 3);
    assert.ok(equals(sum(shares, "INR"), fee));
    assert.deepEqual(shares.map((s) => s.minor), [334n, 333n, 333n]);
  });

  it("apportions a settlement fee across a bundle by payment value", () => {
    const fee = fromDecimalString("100.00", "INR");
    const weights = [1000n, 2000n, 3000n, 4567n];
    const shares = allocate(fee, weights);
    assert.ok(equals(sum(shares, "INR"), fee));
  });

  it("handles a negative amount, for a reversal apportioned back", () => {
    const reversal = fromDecimalString("-10.00", "INR");
    const shares = allocate(reversal, [1n, 1n, 1n]);
    assert.ok(equals(sum(shares, "INR"), reversal));
  });

  it("refuses an allocation that cannot be defined", () => {
    assert.throws(() => allocate(fromMinor(100n, "INR"), []));
    assert.throws(() => allocate(fromMinor(100n, "INR"), [0n, 0n]));
    assert.throws(() => allocate(fromMinor(100n, "INR"), [-1n, 2n]));
  });
});

describe("display edge and serialisation", () => {
  it("formats with the currency symbol", () => {
    assert.equal(format(fromDecimalString("47318.20", "INR")), "₹47318.20");
  });

  it("round trips through JSON without loss", () => {
    const original = fromDecimalString("123456789.99", "INR");
    const restored = fromJSON(toJSON(original));
    assert.ok(equals(original, restored));
  });

  it("survives magnitudes that would break a float", () => {
    // 2^53 minor units and one more, which Number cannot represent distinctly
    const big = fromMinor(9007199254740993n, "INR");
    const restored = fromJSON(toJSON(big));
    assert.equal(restored.minor, 9007199254740993n);
  });
});

describe("nominality", () => {
  it("rejects a structurally similar plain object", () => {
    const impostor = { minor: 100n, currency: "INR" };
    assert.ok(!isMoney(impostor));
  });

  it("accepts a real Money", () => {
    assert.ok(isMoney(fromMinor(100n, "INR")));
  });
});
