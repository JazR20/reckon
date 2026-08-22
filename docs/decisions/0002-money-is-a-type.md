# ADR 0002: money is a type, never a number

**Status:** accepted
**Date:** 2026-08-22

## Context

In a system the author operates, a currency conversion was applied at one layer and
applied again at another. Neither layer could know about the other, because the value
being passed was a plain number and a number carries no currency. Reported revenue read
roughly 3.6x its true value.

Nothing caught it. Not the type checker, because both values were `number`. Not the
tests, because the tests asserted on numbers computed the same wrong way. Not the build,
because the code was valid. The output was wrong and it was shaped exactly like a correct
answer, which is the only kind of wrong that survives to production.

That is failure class F01, and a reconciler that carries the same weakness will produce a
plausible wrong reconciliation for the same reason.

## Decision

An amount is a branded pair of a magnitude in minor units, held as `bigint`, and a
currency. Neither half is meaningful alone.

- No floating point in the money path, ever.
- Every arithmetic operation asserts currency equality and throws on mismatch.
- Conversion is one explicit function taking a directional `Rate` that carries its own
  source string, so the rate appears in the evidence chain a human reviews.
- The only exits are `format`, `toDecimalString` and `toMinor`, and the last returns a
  `bigint`. There is no accessor returning a `number`.
- Decimal input is parsed from a string. Accepting a JavaScript number at the boundary
  would reintroduce binary floating point at exactly the point where exactness matters.

## Rationale

The incident is not fixable by discipline. It was already the case that everybody
involved knew currencies must match. What failed was that the type system had no opinion,
so the mistake was expressible, and anything expressible eventually gets expressed.

Making it inexpressible is cheaper than making it noticed.

## Alternatives rejected

**Number with a currency field alongside.** This is what the incident system had. The
field exists and nothing enforces it, so it drifts.

**A decimal library.** Solves precision, does not solve currency. The incident was not a
precision failure, it was a unit failure, and a decimal library would have produced the
same wrong answer to more decimal places.

**Integer paise everywhere with a naming convention.** `amountPaise` is a comment that
the compiler does not read.

## Consequences

- Ingest is the only place raw strings become `Money`, and it is the only place F01 can
  be caught. It must throw rather than warn.
- Fee apportionment across a settlement bundle needs exact splitting, which is why
  `allocate` uses largest remainder and asserts its own postcondition. A three paise
  drift across a sixty payment bundle would send a correct match to review for no reason.
- `bigint` does not serialise to JSON natively, so the audit trail uses an explicit
  `toJSON` and `fromJSON` pair. Verified to round trip past 2^53.
