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
