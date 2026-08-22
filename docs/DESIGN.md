# RFC 001: Reckon

| | |
|---|---|
| **Status** | Accepted |
| **Author** | Jasnoor Singh |
| **Created** | 2026-08-22 |
| **Track** | Razorpay AI Buildathon, Track 4, AI Finance Controller |
| **Supersedes** | none |

---

## 1. Problem

Money arrives at a business from many places and somebody has to decide, row by row,
which bank credit corresponds to which payment and which invoice. Today this is a human
with a spreadsheet.

It is not a one to one problem. A payment gateway does not deposit each payment
separately. It bundles many payments into a single settlement, nets its fee out first,
and deposits the remainder days later. A single bank credit of 47,318.20 may be thirty
one payments minus a platform fee minus GST on that fee. Layer on tax deducted at
source, partial refunds, chargebacks reversing old payments, two customers who paid an
identical amount on the same day, and a bank narration field truncated by a legacy core
banking system, and the human is no longer matching. The human is guessing.

The guessing is the failure. Not the effort.

## 2. The failure this system exists to prevent

There are two ways a reconciliation run can be wrong and they are not symmetric.

**A missed match** costs review time. The record sits in a queue, a human looks at it,
the money is found. Expensive, recoverable.

**A wrong match** closes the book. The system reports the payment as reconciled, the
human stops looking, and money that never arrived is recorded as arrived. Nobody
discovers it until an audit, a quarter end, or never. Cheap to produce, unrecoverable.

Most reconciliation tooling optimises for coverage, because coverage is the number that
demonstrates well. Reckon optimises for **precision on the records it decides
automatically**, and treats coverage as a dial set against it deliberately and in
writing.

### 2.1 Two incidents this design is derived from

Both occurred at a real business the author operates. Details are paraphrased. No real
identifiers, no customer data, and no live transaction references appear anywhere in
this repository. See `REDLINES.md`.

**Incident A, the invisible payer.** A subscription was active and charging successfully
for forty three days while no corresponding customer record existed in the company books.
Revenue was arriving and was attributed to nothing. It was found by a human noticing a
total that felt wrong, not by any system. This is failure class **F08**, a bank credit
with no record behind it. A reconciler that guesses will assign that credit to the
nearest plausible invoice and the discrepancy disappears permanently.

**Incident B, the plausible wrong number.** A currency conversion round trip between two
layers of one system caused reported revenue to read roughly 3.6x its true value.
Nothing caught it. Not a type checker, not a test, not a build. The output was wrong but
it was shaped like a correct answer. This is failure class **F01**, and it is the direct
justification for decision D2.

## 3. Non goals

Stated explicitly so that scope is a contract and not a mood.

- No web application, no dashboard, no authentication, no deployment.
- No database. Files, and at most SQLite, are sufficient at this scale.
- No live payment gateway calls inside the evaluation path.
- No multi tenancy, no accounts, no persistence beyond a run directory.
- No conversational interface unless every other deliverable is complete and verified.
- Not a general ledger and not a replacement for an accounting package.

## 4. Decisions

### D1: the language model is not the matcher

Reckon is a cascade. Deterministic logic resolves everything it can resolve exactly, and
a model is invoked only on the residue where deterministic logic cannot decide.

```
raw sources
    |
    v
[0] ingest, normalise, type every amount as Money
    |
    v
[1] exact match             UTR + amount + date              deterministic
    | unresolved
    v
[2] bundle decomposition    one credit = N payments net of fees   constrained solver
    | unresolved
    v
[3] candidate generation    scored heuristics, yields 0, 1 or many candidates
    | ambiguous residue only
    v
[4] adjudicator (model)     parses narration, breaks ties, states its reasoning
    | proposed matches
    v
[5] adversarial verifier    attempts to REFUTE each proposal before acceptance
    |
    v
[6] gate    ->    MATCHED   |   REVIEW   |   REFUSED
```

Rationale:

1. **Reproducibility.** A reviewer must be able to regenerate every number in the README.
   A pipeline whose central decision is a sampled model output produces anecdotes.
2. **Cost and throughput.** Both are reported metrics. Tiers 1 and 2 cost nothing and
   complete in milliseconds. Only the residue incurs token cost.
3. **Precision.** Exact matching on a unique transaction reference is correct by
   construction. Introducing a probabilistic component into an already solved subproblem
   can only lower precision.
4. **Appropriate use.** The model is applied where language actually appears: parsing an
   unstructured bank narration string, and reasoning about which of several candidates a
   credit belongs to and saying why. That is a language problem. Subset sum is not.

Recorded as `docs/decisions/0001-llm-is-not-the-matcher.md`.

### D2: money is a type, never a number

```ts
type Money = { readonly minor: bigint; readonly currency: Currency; readonly __brand: unique symbol }
```

No floating point anywhere in the money path. No bare numeric literal may occupy a money
position. Every arithmetic operation asserts currency equality and throws on mismatch.
There is no accessor returning a raw number except a formatter at the display edge.

This follows directly from Incident B. A currency is not metadata attached to a number.
It is part of the value. A system that treats it as metadata will eventually add rupees
to dollars and print something that looks like money.

Recorded as `docs/decisions/0002-money-is-a-type.md`.

### D3: a seeded generator with perfect ground truth

Precision cannot be measured without knowing the correct answer. Reckon generates its
own corpus and emits the true mapping alongside it. The seed is committed. Any reviewer
regenerates a byte identical batch.

Twelve failure classes, each individually toggleable, each reported on separately. See
`FAILURE-CATALOGUE.md`.

### D4: a held out test split, executed once

Two seeds. All development and tuning happens against **dev**. The **test** split is
generated on day one and is not inspected. It is executed exactly once, at the end, and
its result is the headline number in the README.

If the dev result and the test result diverge, that divergence is reported. A gap is a
finding about the system, not an embarrassment to be hidden.

Recorded as `docs/decisions/0003-held-out-test-set.md`.

### D5: a committed response cache

Every model call is issued at temperature zero and cached to disk under a hash of its
exact prompt. `eval/cache/` is committed.

Consequence: `npm install && npm run eval` reproduces the published numbers with no API
key, no credentials and no spend. Verifying this work costs a reviewer thirty seconds
rather than an account setup.

### D6: model routing, justified by measurement

A small fast model performs bulk adjudication. A stronger model handles only the cases
the small model marks uncertain, plus all adversarial verification. The cost table is
reported for both the routed and the unrouted configuration, so the routing is defended
with a number rather than an assertion.

## 5. The output contract

Every input record terminates in exactly one of three states. There is no fourth state
and no silent default.

| State | Meaning | Carries |
|---|---|---|
| `MATCHED` | decided automatically, above the precision gate | the evidence chain, the deciding tier, a confidence |
| `REVIEW` | genuinely ambiguous, a human must decide | ranked candidates, and a statement of what specifically is ambiguous |
| `REFUSED` | something is wrong with this record and no match should be attempted | the reason, by failure class where identifiable |

`REFUSED` is not an error state. It is the most valuable output the system produces. A
bank credit with no corresponding record anywhere is exactly Incident A, and the correct
behaviour is to surface it loudly rather than attach it to the nearest plausible invoice.

## 6. Evaluation

Metrics are defined before implementation so that flattering metrics cannot be selected
afterwards.

| Metric | Definition |
|---|---|
| Coverage | share of records auto decided without human review |
| **Precision on auto matched** | of records marked `MATCHED`, the share correct. The headline |
| Recall | of all truly matchable records, the share found |
| **False match cost** | total value of records incorrectly auto matched |
| **Escaped loss** | total value in orphan records a guessing system would have buried |
| Calibration (ECE) | expected calibration error across confidence buckets |
| Review burden | share routed to a human, and estimated human minutes saved |
| Throughput | records per second, end to end |
| Cost per 1000 records | tokens and currency |
| Per class breakdown | every metric above, split by F01 through F12 |

Two figures are produced:

1. **Calibration curve.** Stated confidence against observed correctness, with the
   diagonal drawn. Establishes whether the confidence signal means anything at all.
2. **Coverage against precision sweep.** The gate swept across its range, with the
   selected operating point marked and justified in writing.

And one table:

3. **Ablation.** Deterministic only, then plus the adjudicator, then plus the verifier.
   Each component must demonstrate that it earns its place. A component that does not
   improve the numbers stays in the table with its null result reported.

### 6.1 The generator calibration checkpoint

If tiers 1 and 2 alone resolve more than 95 percent of the dev split, the generator is
too easy and every downstream number is theatre. If they resolve less than 40 percent,
the generator is unrealistically hostile. This is checked at the end of Phase 3 and the
generator is tuned until the deterministic baseline lands between those bounds.

This is the single most important gate in the schedule, because it is the only one whose
failure invalidates everything after it.

## 7. Risks

| Risk | Detection | Response |
|---|---|---|
| Generator too easy | deterministic baseline above 95% | harden F02, F04, F05 |
| Generator too hostile | deterministic baseline below 40% | reduce injection rates |
| Model nondeterminism | metrics move between runs | temperature zero, cache, report variance over three runs |
| Overfitting to dev | dev and test results diverge | report the gap, never tune against test |
| Scope creep | work begins on anything in section 3 | section 3 is a contract |
| A confidently wrong match survives verification | found during evaluation | the expected good failure. Keep the fixing commit and cite it |

## 8. Open questions

- Whether test mode settlement recon data is rich enough to derive authentic schemas
  from, or whether the public API reference must serve as provenance for some fields.
  Resolved in Phase 4 and recorded in `SCHEMA-PROVENANCE.md`.
- Whether the adversarial verifier improves precision enough to justify its cost. The
  ablation table answers this, and a null result is an acceptable answer.
