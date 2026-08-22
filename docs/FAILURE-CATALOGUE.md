# Failure catalogue

The twelve ways a reconciliation run goes wrong. Each class is generated independently,
each can be toggled off, and every metric in the report is broken down by class.

A class is only in this list if it changes what the matcher has to do. Cosmetic variance
is not a failure class.

| Code | Class | Difficulty | Which tier should catch it |
|---|---|---|---|
| F01 | Currency or unit mismatch | high | T0 normalise, must throw |
| F02 | Bundled settlement, one credit to many payments | high | T2 solver |
| F03 | Fee, GST and TDS deductions | medium | T2 solver |
| F04 | Identical amounts on the same day | high | T3 candidates, then T4 |
| F05 | Date skew across a cutoff | medium | T3 candidates |
| F06 | Missing or garbled UTR | medium | T4 adjudicator |
| F07 | Silent truncation at a page boundary | high | T0 ingest, must refuse the run |
| F08 | Orphan bank credit, no record behind it | high | T6 gate, must REFUSE |
| F09 | Partial refund reducing the net | medium | T2 solver |
| F10 | Chargeback or reversal against an older payment | high | T3 candidates |
| F11 | Foreign currency payment with conversion | high | T0 normalise |
| F12 | Duplicate ingestion of the same file | medium | T0 ingest, must dedupe |

---

## F01: currency or unit mismatch

A value crosses a boundary and its unit changes without its label changing. Rupees stored
where minor units were expected, so 100 becomes 10000 or 1. Or a foreign amount converted
once on write and once again on read.

**Why it is nasty.** The output is not obviously broken. It is a number of the right
shape and the wrong magnitude. Type checkers pass. Tests pass. Builds pass.

**Generated as.** A subset of records whose amount is expressed in a different unit or
currency from the header declaration, with no flag.

**Correct behaviour.** The `Money` type refuses to construct. The run fails loudly at
ingest. There is no acceptable outcome where this class produces a match.

**Provenance.** Incident B in `DESIGN.md`.

---

## F02: bundled settlement, one credit to many payments

The gateway settles many payments as a single bank credit, net of its fee. The bank shows
one number that appears nowhere in the payments file.

**Why it is nasty.** There is no field to join on. The relationship is arithmetic, not
referential. Finding which subset of payments sums to a given credit is a constrained
subset sum, and with realistic amounts there are usually several subsets that fit.

**Generated as.** Settlement groups of between 3 and 60 payments, netted, deposited on a
T+2 or T+3 schedule.

**Correct behaviour.** T2 solves it when the subset is unique. When more than one subset
fits, the record goes to `REVIEW` with the competing subsets listed. It never picks one.

---

## F03: fee, GST and TDS deductions

The credited amount is the gross minus a platform fee, minus GST on that fee, and
sometimes minus tax deducted at source.

**Why it is nasty.** It compounds F02. The solver is not looking for a subset summing to
the credit, it is looking for a subset whose net after a fee schedule sums to the credit,
and the fee schedule varies by payment method.

**Generated as.** A published fee table per method, GST applied to fee, TDS applied on a
subset of B2B records.

**Correct behaviour.** T2 models the fee schedule explicitly and reports the derived fee
as part of the evidence chain, so a human can check the arithmetic.

---

## F04: identical amounts on the same day

Two or more customers pay the same amount on the same day. A subscription tier does this
constantly.

**Why it is nasty.** It is the genuinely undecidable case. Without a reference the two
records are indistinguishable, and any system that picks one is guessing at a coin flip
while reporting confidence.

**Generated as.** Deliberate amount collisions at subscription price points, with and
without a distinguishing reference.

**Correct behaviour.** If a reference disambiguates, T4 uses it. If nothing does, the
record goes to `REVIEW`. This class exists specifically to catch systems that report
confidence they cannot possibly have, and its per class precision is the most diagnostic
number in the report.

---

## F05: date skew across a cutoff

The payment is dated one side of a boundary and the credit the other. Timezone, bank
cutoff time, weekend, or a public holiday.

**Generated as.** Settlement dates shifted across month ends, weekends and Indian bank
holidays.

**Correct behaviour.** T3 widens the date window rather than requiring an exact date, and
the widened window is recorded as a confidence penalty rather than a free pass.

---

## F06: missing or garbled UTR

The bank reference is absent, truncated by a fixed width field, or buried inside a free
text narration in an inconsistent format.

**Generated as.** Narration strings in several real world formats, some with the
reference truncated mid token, some with it absent entirely.

**Correct behaviour.** T4 parses the narration. This is the clearest case in the system
where a language model earns its place, and its contribution here is isolated in the
ablation table.

---

## F07: silent truncation at a page boundary

An export is capped at a page limit and returns successfully with fewer rows than exist.
The file looks complete. Nothing reports an error.

**Why it is nasty.** Every downstream number is computed over a partial set and every
downstream number looks reasonable. The failure is invisible by construction.

**Generated as.** A source file truncated at a round boundary, with a manifest row count
that disagrees with the actual row count.

**Correct behaviour.** Ingest verifies the declared count against the observed count and
**refuses the entire run**. Not a warning. A refusal. A reconciliation over an incomplete
set is not a partially correct reconciliation, it is a wrong one.

**Provenance.** A silent row cap that reported success in four separate call sites of one
production codebase operated by the author.

---

## F08: orphan bank credit, no record behind it

Money is in the bank and there is no payment, no invoice and no customer that explains
it.

**Why it is nasty.** It is the single highest value output of the whole system and the
one a coverage optimising matcher destroys. Given an unexplained credit, a greedy matcher
attaches it to the nearest plausible open invoice, coverage goes up, and a real accounting
discrepancy is erased.

**Generated as.** Bank credits with every corresponding record removed.

**Correct behaviour.** `REFUSED`, with the amount surfaced in the escaped loss total. The
report states the rupee value of what would have been buried.

**Provenance.** Incident A in `DESIGN.md`.

---

## F09: partial refund reducing the net

A refund is issued after the payment but before settlement, so the settled amount is the
payment minus the refund.

**Generated as.** Refunds at varying intervals, some crossing a settlement boundary so the
refund lands in the next cycle instead.

**Correct behaviour.** T2 accounts for refunds inside the settlement window and treats a
boundary crossing refund as a separate negative record rather than folding it in.

---

## F10: chargeback or reversal against an older payment

A debit appears in the bank reversing a payment settled weeks earlier, often bundled with
a fee.

**Why it is nasty.** It is a negative amount that must be matched backwards in time to a
record already marked reconciled. A forward only matcher never finds it.

**Generated as.** Reversals against payments from 15 to 120 days earlier.

**Correct behaviour.** T3 searches backwards over closed periods and, on a match, reopens
the original record rather than silently amending it.

---

## F11: foreign currency payment with conversion

A payment taken in one currency settles in another at a rate that is not published in the
file.

**Generated as.** A small share of records in USD, EUR and GBP settling to INR at rates
that vary daily.

**Correct behaviour.** The `Money` type prevents any cross currency arithmetic. A
conversion is an explicit typed operation carrying its rate, and the rate appears in the
evidence chain. Without a supplied rate the record goes to `REVIEW`, never to a guess.

---

## F12: duplicate ingestion of the same file

The same export is loaded twice, or two exports overlap on a date range.

**Why it is nasty.** It inflates totals and creates artificial perfect duplicates that a
matcher will happily match to the same record twice.

**Generated as.** Overlapping date ranges across two source files, plus one exact
duplicate load.

**Correct behaviour.** Ingest content addresses every row and deduplicates before
matching, reporting the count removed. A row may participate in at most one match.
