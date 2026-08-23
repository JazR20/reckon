# ADR 0005: value equivalence is the scoring rule, strict set equality is a secondary

**Status:** accepted
**Date:** 2026-08-23

## Context

The original scoring rule, written into `emit.ts` on day two, was that a bank transaction
is decided correctly when the predicted payment set exactly equals the true payment set.
It was chosen because it is strict, and strictness seemed like the honest choice.

Measuring the corpus showed it is the wrong rule, and the measurement is the reason to
keep this record.

A subscription business has a small number of repeated price points. Two customers on the
same plan are charged the same amount on the same day. Late settlement then puts one of
those two payments in one batch and the other in a different batch. Both assignments tie
to their bank credit exactly, to the paisa. Nothing in the bank statement, the settlement
export, the payments export or the orders file distinguishes them.

They are interchangeable, and the data does not contain the answer.

On the dev corpus:

```
pctPaymentsInterchangeable   23.0
strictCeilingPct             40.0
```

`strictCeilingPct` is the expected strict accuracy of a **perfect** matcher: one that
recovers the correct money every time and then guesses uniformly among assignments it
cannot distinguish. It is 40 percent.

A headline metric with a ceiling of 40 percent is not measuring the matcher. It is
measuring the corpus, and a reader has no way to tell which. Any improvement a real
system made would be invisible underneath the noise of a coin flip it was never able to
win.

## Decision

The primary metric is **value equivalent set correctness**.

Two payment sets are value equivalent when their canonical forms are equal, where the
canonical form is the sorted multiset of `(captureDate, currency, minorAmount)` over the
members. Identity is deliberately discarded, because identity is the part the sources do
not determine.

In plain terms: the money is attributed to the right credit, on the right day, in the
right amount, and the only thing that may differ is which of two indistinguishable
payments was named.

**Strict set equality remains reported**, alongside `strictCeilingPct`, so a reader can
see both the number and the bound it is measured against.

## Rationale

The question a reconciliation answers is whether the money ties. It is not whether a
system can win a coin flip that the source data does not decide.

Reporting only the strict number would understate a correct system. Reporting only the
value equivalent number would hide that an ambiguity exists at all. Reporting both, with
the ceiling next to them, is the only presentation where a reader can form a correct view
without already knowing the corpus.

## Alternatives rejected

**Remove the ambiguity from the corpus.** Reduce the subscriber count, spread the price
points, or drop late settlement. Every one of those makes the corpus less like a real
subscription business, and the ambiguity is not an artefact, it is the domain. Deleting
the hard case to make the scoreboard look better is precisely the failure this project
exists to argue against.

**Put a disambiguator in the sources.** Emit a settlement identifier on each payment row.
That resolves it and also deletes failure classes F02 and F03 entirely, turning the whole
task into a join. Rejected for the reasons in the header of `world.ts`.

**Score at the money level only**, for example total value correctly attributed. Simpler,
and it hides a matcher that assigns the right total from the wrong payments, which is a
real error this system should catch.

## Consequences

- `eval/scoring/equivalence.ts` owns the canonical form. It is the definition the whole
  scoreboard rests on, so it lives in one file with tests rather than being inlined.
- The report carries three numbers where most would carry one: value equivalent accuracy,
  strict accuracy, and the strict ceiling.
- The README must explain the distinction in two sentences. A metric that needs a
  paragraph to defend is usually the wrong metric, and this one needs two sentences.
- `strictCeilingPct` is recomputed per split and published for both, because it is a
  property of the draw and will differ slightly between dev and test.
