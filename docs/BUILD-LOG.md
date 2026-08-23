# Build log

Real obstacles, dated, with what was actually wrong and what changed. Kept as it happened
rather than reconstructed afterwards, because a reconstructed list is always tidier than
the truth and tidier is less useful.

---

## 2026-08-22, day 1

### The no build step choice forbids more than expected

First test run died with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` on a constructor parameter
property in `src/money/errors.ts`.

Node runs TypeScript by stripping types, not by compiling them. Stripping erases
annotations and synthesises nothing, so any construct that needs generated JavaScript is
unavailable: parameter properties, enums, namespaces, decorators.

Fixed by declaring and assigning the fields explicitly. Written up as
`docs/decisions/0004-no-build-step.md` so the constraint is stated rather than
rediscovered, since the constraint is worth keeping. The payoff is that a reviewer runs
`npm install && npm run eval` and the code they read is the code that ran.

---

## 2026-08-23, days 2 and 3

### The corpus was not actually hard, and the difficulty parameter was hiding it

First generated corpus reported a healthy looking difficulty profile. It was not healthy.

Every settlement was exactly one whole day of captured payments. Recovering the payment
set behind a bank credit was therefore not a subset sum at all: a solver tries each of 365
days and takes the batch that ties. Failure classes F02 and F03 would have scored near
perfectly while testing nothing, and the deterministic baseline would have sailed past the
95 percent bound that section 6.1 of `DESIGN.md` calls theatre.

Fixed by adding `latePaymentRate`. A share of captured payments is held back from its own
day's batch and folded into a later one, the way a payment under risk review settles late.
A batch is now one day's captures, minus its own stragglers, plus other days' stragglers.
The subset has to be searched for.

This is the failure the whole project is about, found in the project's own foundation: a
number that looked reasonable, produced by a process that was measuring the wrong thing.

### F04 was defined wrong twice

**First definition:** any settlement containing two same day, same amount payments.
Marked **91.3 percent** of rows. A label carried by nine rows in ten distinguishes nothing
and makes its row of the per class table worthless.

**Second definition:** bank credits sharing an exact amount within three days. Marked
**0.5 percent**, two rows. A settlement net carries fee, GST and TDS arithmetic down to
the paisa, so two of them effectively never collide. A class with two members cannot
support a precision number either.

**Third definition, kept:** a payment that has an amount identical twin captured the same
day but settled in a different batch. Marks 74 percent of rows, and unlike the first
definition that number is load bearing rather than decorative, because it is the share of
rows where a genuinely undecidable choice exists.

Both wrong definitions are kept in the source comment. The reasoning is the same reasoning
the matcher has to do.

### The strict scoring rule had a ceiling of 40 percent

The third F04 definition immediately broke the scoring rule written on day two.

Measured on the dev corpus: 23 percent of payments are interchangeable, and
`strictCeilingPct` is **40**. That is the expected strict set accuracy of a perfect
matcher, one that recovers the right money every time and then guesses uniformly among
assignments the source data does not distinguish.

A headline metric with a ceiling of 40 percent measures the corpus, not the system. Any
real improvement would be invisible under the noise of a coin flip that cannot be won.

Fixed by making **value equivalence** the primary rule: the sorted multiset of
`(captureDate, currency, minorAmount)`, with payment identity deliberately discarded
because identity is the part the sources do not determine. Strict equality is still
reported, always next to the ceiling. Written up as `ADR 0005`, and the definition lives
alone in `eval/scoring/equivalence.ts` with its own tests, because everything downstream
rests on it.

The tempting alternative was to delete the ambiguity from the corpus by spreading the
price points or dropping late settlement. That would have made the scoreboard look better
by making the data less like a real subscription business, which is the exact move this
project exists to argue against.

### The bank statement balance did not tie

Caught by reading the emitted file rather than by any check.

`world.ts` computes a running balance in settlement order. F05 then shifts statement
dates, and `emit.ts` re-sorts the rows by the shifted date. The balance column was carried
across the sort, so it no longer followed the order it was printed in. Row 1 showed a
closing balance of 287,843.07, row 2 added a credit of 19,657.63, and row 2 showed
269,657.63.

The invariant checker missed it because it validated `world.bankTxns`, which is the
pre-skew order, and that order did tie. **The check was correct and was checking the wrong
artefact.**

Fixed by recomputing the balance in `emit.ts` after the sort, and by asserting inside the
emitter that opening plus credits minus debits equals the closing balance over unique
rows, so the emitted file is now verified rather than the intermediate structure.

A duplicated export row now repeats its original balance instead of advancing it, which is
what a bank actually prints and which gives deduplication a second signal.

---

## 2026-08-23, days 4 and 5

### The checkpoint failed, and it failed in the direction nobody plans for

Section 6.1 of `DESIGN.md` says the deterministic tiers must resolve between 40 and 95
percent of the dev corpus. Below 40 the corpus is unrealistically hostile; above 95 it is
theatre. The first run came in at **5.3 percent coverage at 57 percent precision**.

Every version below is a real measurement, not a retelling.

### v1: searching for a fact that was derivable

The solver looked for the batch day across a six calendar day window and accepted the
first subset that summed to the target.

The diagnostic was one line of the false match list: *row 5 predicted 11 payments, truth
has 11*. Same count, wrong set. On any given wrong day, some combination of that day's
payments happens to hit the target, and once found it was accepted.

The batch day is not a search space. It is the settlement date minus the contracted cycle,
T+2 working days. Deriving it instead of hunting for it took coverage to **23.3 percent at
82.8 percent precision**.

Bank holidays are deliberately not modelled. A holiday shifts the real cycle by a day and
the row falls to review, which is the correct outcome. Encoding a calendar that cannot be
checked against the sources would buy coverage by assuming something the sources never
state.

### v2: measuring the wall instead of guessing at it

Rather than tune the search bounds by feel, the true answers were measured directly:

```
true ADDITIONS needed : 0:146  1:51  2:69  3:58  4:32  5:11  6:5  8:2
true REMOVALS needed  : 0:71  1:112  2:94  3:56  4:20  5:10  7:1  8:10
  covered by maxRemove=2: 74.1%    by maxRemove=5: 97.1%
anchor offset: 0:221  1:47  2:50  -1:21  -2:10  -3:8  -4:5
```

Removals were the binding constraint. But five removals from thirteen payments is 1,287
sets per day, before additions are considered at all.

### v3: the ambiguity that broke the scoring rule also collapses the search

Two payments of the same amount captured on the same day are indistinguishable. That is
why ADR 0005 exists. It is also why enumerating both orderings explores two paths to one
answer.

Bucketing the pool by (capture day, amount) and choosing how many to take from each bucket
searches exactly the space of distinguishable answers. **The bucket key is the canonical
form.** It is faster, and it removes a class of spurious ambiguity where two "different"
solutions were only ever a relabelling.

A suffix-max lower bound was then needed to make exhaustion cheap. Without it, a row with
no answer costs more than a row with one, and rows with no answer are the orphan credits,
which are the highest value output this system produces.

### The currency round trip, which is Incident B again in a different costume

F11 read **0.0 percent precision across ten auto matched rows**. Every single one wrong.
Not noise.

The cause, measured: a 349.00 charge reported as USD 4.17 converts back to **349.07**. All
120 convertible payments in the corpus land off their true value. A batch containing one
can therefore never tie exactly, and the solver's response was to find a different
all-rupee subset that did.

The solver had not failed. It had succeeded at the wrong question, which is much harder to
notice than a crash.

This is real rather than a corpus artefact. A gateway settles a cross currency payment at
its own rate and its own timestamp, and a published daily rate does not reproduce that.

**A tolerance was tried and reverted.** Allowing one rupee per converted member let those
batches tie, and also let unrelated subsets tie to orphan credits: correct refusals fell
from 24 of 25 to **11 of 25**. Buying coverage by blurring the arithmetic that finds
orphans is the wrong trade at any exchange rate.

**A window check was tried and was far too broad.** Checking a twelve day window took
coverage to **zero**, because a cross currency payment lands roughly every third day. The
day is the right granularity: a batch is one day of captures, so it is that day's
composition that decides whether an exact tie was ever available.

### Where days 4 and 5 actually end

```
MATCHED    64  (16.0%)      precision 73.4%      false matches 17
REVIEW    281  (70.4%)
REFUSED    54  (13.5%)      correct refusals 17 of 25
```

Coverage is below the 40 percent floor. The checkpoint has **not** passed, and that is
recorded here rather than smoothed over.

What days 4 and 5 did produce is the thing the gate should be built from:

```
perturbation 0    13 matched   92.3% precision
perturbation 1    27 matched   81.5%
perturbation 2    18 matched   61.1%
perturbation 3     5 matched   40.0%
perturbation 5     1 matched    0.0%
```

Perturbation, the number of payments that had to settle off cycle to explain a credit, is
a genuine confidence signal and it falls monotonically. Nothing about that curve was
designed in. It was measured.

Auto matching everything the solver finds is what produced 73.4 percent. Auto matching
only what the evidence supports is a different system, and the curve says where the line
is. That is the work for days 6 and 7, and it is what tier 3 and the gate were always
for.
