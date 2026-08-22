# ADR 0001: the language model is not the matcher

**Status:** accepted
**Date:** 2026-08-22

## Context

Reconciliation is a matching problem over three sources. The obvious build, and the one
most submissions to this track will make, is to hand the batch to a model and ask it to
reconcile. Modern models are good enough that this produces a demo which works.

It does not produce a system, for four reasons.

## Decision

Reckon runs a six tier cascade. Tiers 1 to 3 are deterministic. A model is invoked only
at tiers 4 and 5, and only on records the deterministic tiers could not resolve.

## Rationale

**Reproducibility.** Every number published in the README must be regenerable by a
reviewer running one command. A pipeline whose central decision is a sampled model output
does not produce measurements, it produces anecdotes that happen to be numeric.

**Cost and throughput.** Both are reported metrics for this track. Tiers 1 and 2 resolve
the bulk of a batch in milliseconds at zero token cost. Sending resolved records through
a model buys nothing and is charged for.

**Precision.** Matching on a unique transaction reference is correct by construction. A
probabilistic component added to an already solved subproblem can only lower precision.
There is no version of this where the model improves on an exact join.

**Appropriate use.** The model is applied where language is actually present: parsing an
unstructured bank narration string into fields, and adjudicating between candidates with
a stated reason. Subset sum is not a language problem and does not become one because a
model is available.

## Alternatives rejected

**Model does everything.** Faster to build, cheaper in developer time, and it fails all
four criteria above. Its coverage would likely be higher and its precision lower, which
is the exact tradeoff this system exists to refuse.

**Model does nothing.** A purely deterministic reconciler is reproducible and cheap and
cannot read a garbled narration string or explain an ambiguity to a human. Failure
classes F04 and F06 are where a model genuinely earns its place, and the ablation table
is the evidence for that claim rather than the assertion of it.

## Consequences

- The ablation table must isolate the contribution of tiers 4 and 5. If they do not
  improve the numbers, that null result is published.
- Prompt changes invalidate the cached responses and therefore the published numbers.
  Rerunning is required before any claim.
