# ADR 0006: reconciliation is an assignment problem, not a loop over rows

**Status:** accepted
**Date:** 2026-08-23

## Context

The obvious shape for this system is a loop: for each bank credit, find the payments
behind it. That is what days 4 and 5 built, and it reached 16 percent coverage at 73.4
percent precision.

Diagnosing the seventeen false matches is what changed the design. Each one was compared
against what the true answer would have required:

| finding | rows |
|---|---|
| solver chose a rival explanation with **strictly lower** perturbation than the truth | 9 |
| genuine tie: rival and truth needed identical perturbation | 3 |
| true batch contained a converted payment, so an exact tie was never available | 3 |
| truth outside the search bounds, or the row was an orphan | 2 |

The first line is the important one. Perturbation, the number of payments that had to
settle off cycle to explain a credit, is a genuine signal: precision measured at 92.3
percent at zero and 40 percent at three. But on nine rows it pointed the wrong way, and
nothing else available inside a single row's evidence could overrule it.

## Decision

Reckon runs as constraint propagation over the whole statement rather than as a loop over
its rows.

Two global constraints do the work, and neither is visible from inside one row:

1. **A payment settles exactly once.** A credit explainable only by payments another
   credit has already claimed with better evidence is not a close call, it is refuted.
2. **A batch day produces exactly one settlement.** Two credits cannot both be Friday's
   payout.

Rows commit in rounds. The strictest bar goes first, committed payments and days leave the
pool, and every row whose candidate window touched a changed day is re-solved against what
is actually still available. Each round relaxes the bar by one. The pool shrinks
monotonically, so the loop terminates.

Within a round, two candidates claiming the same payment or the same batch day are both
deferred. Neither commits, because the round that follows will have more information than
a coin flip does.

## Rationale

The constraint is free evidence that a row-scoped matcher throws away. It also matches the
domain exactly: a gateway really does settle a payment once and really does emit one payout
per batch. Encoding a true fact about the mechanism is not a heuristic.

## What this cost, and what it bought

The search bounds had to come down at the same time, from 5 removals to 3. Two independent
measurements agreed:

- Precision beyond perturbation 3 is worse than a coin flip, so searching there buys wrong
  answers.
- At 5 the combinatorics did not finish a 399 row corpus inside two minutes.

The expensive part and the inaccurate part turned out to be the same part. Throughput went
from 5 rows per second to 80, and precision rose at the same time.

What is given up is reachability of the tail. Roughly 3 percent of true answers now sit
outside the bounds, and the honest consequence is that those rows go to review rather than
to a confident wrong answer.

## Alternatives rejected

**Better ranking inside a row.** More features, weighted. It cannot work: the refuting
evidence is in a different row by construction.

**Global optimisation over all rows at once**, as an assignment or flow problem. Cleaner in
theory and wrong in practice for this domain, because it would force a complete assignment.
This system must be able to say that a credit has no explanation at all, and an optimiser
asked for a total assignment will always find one.

**Committing greedily in one pass.** Simpler, and it makes the first decision the most
important one with no opportunity to revise. The ladder exists so that the easiest rows
inform the hard ones rather than the reverse.

## Consequences

- The solver takes a cache rather than a payment list, because the pool changes between
  rounds and rebuilding it per row per round would dominate the cost.
- Only rows whose candidate window overlaps a day that actually changed are re-solved.
- Orphan detection improved from 17 of 25 to 25 of 25 at the ungated setting, because a
  credit whose only candidate payments have been claimed elsewhere now has nowhere to hide.
