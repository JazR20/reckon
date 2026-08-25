# HANDOFF

Written 2026-08-24. Read this first, then `docs/DESIGN.md`.

**Deadline: applications close 5 September 2026.** Target: finish the build in 2 to 3 working
days so there is room left for further ideas, then submit.

**Submission is one shot.** The Google Form takes a repo URL and a video link and cannot be
edited afterwards. Nothing goes in until the repo is final.

---

## If you read only one thing

The project is a reconciliation agent for the Razorpay AI Buildathon, Track 4, AI Finance
Controller. It reconciles bank credits against gateway settlements and payments, and its
product is **knowing when to refuse**.

Tiers 0 to 3 are built, measured and honest. **Tiers 4 and 5, the two model tiers, do not
exist yet, and that is the single most important gap.** It is an AI buildathon and
`grep -r "anthropic" src/ eval/` currently returns nothing.

Second most important gap: **there is no README.** It is the first thing a judge opens.

---

## Where the work stands

Repo: <https://github.com/JazR20/reckon> · public · 30 commits · `main`
Local: `C:\Coding Projects\reckon`
Author identity: `JazR20 <jusnoorsingh74@gmail.com>`

### Current measured results

Dev split, deterministic tiers only, gate at confidence >= 0.85:

```
scored rows                 399
MATCHED                     20  (5.0%)
REVIEW                     290  (72.7%)
REFUSED                     89  (22.3%)

precision on auto matched   95.0%      false matches 1
strict set accuracy         95.0%      ECE 0.074
orphan credits caught       22 of 25
throughput                  84 rows/sec, 0 model calls, 0 cost
```

Large split, 1,471 rows over 51,193 payments, same gate:

```
MATCHED                      0  (0.0%)
REFUSED                    824      orphan credits caught 200 of 200
false matches                0
throughput                  20 rows/sec
```

Zero coverage at scale is real and is not tuned away. At roughly 34 orders a day against
eleven catalogue prices, a batch that is an untouched full day of captures barely occurs,
so nothing clears the evidence bar. **Orphan recall stayed perfect and no false match was
ever produced at volume: the failure mode at scale is silence, not error.**

### What exists

```
src/money/        branded Money type, bigint minor units, 25 tests
src/ingest/       strict CSV, F01 F07 F12 decided here, Money at the boundary
src/match/        fees, reference extraction, count based solver,
                  constraint propagation pipeline, fitted confidence
eval/generator/   seeded corpus, 12 failure classes, invariants machine checked
eval/scoring/     equivalence.ts, the definition of a correct answer
eval/run.ts       scorer, sweep, calibration, per class breakdown
eval/fit.ts       fits src/match/calibration.json
scripts/          capture-schemas.ts, live Razorpay test mode shapes
docs/             DESIGN, FAILURE-CATALOGUE, REDLINES, SCHEMA-PROVENANCE,
                  BUILD-LOG, decisions/0001-0007
```

40 tests pass. `npx tsc --noEmit` is clean.

### What does not exist

| Missing | Promised in | Notes |
|---|---|---|
| **Tiers 4 and 5** | DESIGN D1 | the model tiers. Biggest gap |
| **`eval/cache/`** | ADR 0005 | committed cache so a judge needs no API key. Empty |
| **Ablation table** | DESIGN §6 | needs tiers 4/5 |
| **README.md** | — | first thing a judge sees |
| **`report/index.html`** | plan | one file, whole result |
| **`src/audit/`** | DESIGN §5 | empty directory |
| **F07 fixture + test** | FAILURE-CATALOGUE | documented as tested separately, never written |
| **`docs/EVALUATION.md`** | CLAUDE.md | referenced, absent |
| **Held out test run** | ADR 0003 | never executed. Runs ONCE, at the very end |

---

## Two decisions still open, both needed early

### 1. How tiers 4 and 5 call a model

`.env.local` has `ANTHROPIC_API_KEY=` empty. Either:

- **paste a key** into `.env.local`, cleanest, roughly 300 residue rows at small prompts
  costs pennies; or
- **route through `claude -p`** on the Max plan, free, slower, harder to make structured.

A judge needs neither once `eval/cache/` is committed. The key is only to generate it.

### 2. Section 6.1 of `DESIGN.md`

It requires deterministic coverage between 40 and 95 percent. We are at 5.0 percent.

That 40 was written on day one with no data. **Recommendation: amend section 6.1 and
publish why**, rather than loosen the gate (costs precision, the curve is published) or
weaken the corpus (refused). The honest claim is: the deterministic tiers reach 95 percent
precision at 5 percent coverage, and here is what the model tiers add on top.

### 3. Minor, but decide before the final push

Every commit carries `Co-Authored-By: Claude Opus 5`. Kept deliberately: Razorpay is hiring
people who "use AI tools to think, build, debug, research, and ship faster," and Agent
Studio is built on the Claude Agent SDK, so it reads as fluency rather than confession.
Jaz has been asked twice and has not objected. One `filter-branch` strips it if he wants.

---

## The plan, 2 to 3 days

### Day 9: the model tiers. This is the day that matters

1. **Tier 4, adjudicator.** Runs only on the residue where tiers 0 to 3 produced REVIEW.
   Two jobs, both genuinely language shaped:
   - parse a damaged bank narration and extract the reference (failure class F06)
   - choose between candidate batches and state a reason
   It must NOT be handed rows the deterministic tiers already decided. The whole argument
   of ADR 0001 is that the model works only where deterministic logic cannot.
2. **Tier 5, adversarial verifier.** Given a proposed match, try to REFUTE it. Prompt it to
   default to refuted when uncertain. A proposal survives or drops to REVIEW.
3. **Response cache.** Temperature zero, keyed by a hash of the exact prompt, written to
   `eval/cache/` and committed. This is what makes `npm install && npm run eval` reproduce
   every published number with no key and no spend.
4. **Ablation table.** deterministic → +adjudicator → +verifier, with coverage, precision,
   false match count and cost per thousand records for each row. **If the verifier does not
   improve precision, publish the null result.** That is stated in ADR 0001.
5. Re-run `npm run fit` afterwards. The confidence table describes the matcher; changing
   the matcher invalidates it.

Read `docs/decisions/0001-llm-is-not-the-matcher.md` before writing any of this.

### Day 10: make it legible

1. **README.md.** Results table at the top, architecture diagram, how to reproduce in two
   commands, an honest Limitations section, and the invisible payer narrative below.
2. **`report/index.html`**, generated and committed. Calibration curve, coverage/precision
   sweep, per class table, exceptions list. Jaz is strong at frontend; this is where it
   converts.
3. **`src/audit/`**: append only decision log, content addressed.
4. **F07 fixture + test**: a tiny corpus whose manifest disagrees with the file, and a test
   asserting the run is REFUSED, not warned about.
5. **`docs/EVALUATION.md`**: methodology, the dev/test split rule, why value equivalence.

### Day 11: prove it, then stop

1. **Difficulty sensitivity sweep.** `settlementExportGapRate` (currently 0.18) and
   `latePaymentRate` (0.14) were picked on day two with no evidence about realism. Sweep
   them and publish coverage as a function of book difficulty. This turns "0 percent at
   scale" from an embarrassment into an analysis: here is where the approach works and
   here is where it stops.
2. **Held out test run. Once.** `npm run eval:test`. Publish whatever it says, including a
   gap against dev. That gap is the finding, not a failure.
3. Final tidy, verify a fresh clone reproduces, submit.

---

## How to work in this repo

```
npm install
npm run typecheck        tsc --noEmit
npm test                 40 tests
npm run gen:dev          regenerate dev corpus from seed
npm run gen:large        regenerate the large corpus, ~13MB, gitignored
npm run eval             score dev
npm run eval:large       score large, takes about 70 seconds
npm run eval:test        THE HELD OUT SPLIT. Run once, at the end
npm run fit              refit src/match/calibration.json
npm run capture:schemas  live Razorpay test mode shapes
```

### Hard rules, carried from `CLAUDE.md`

1. **Money is never a number.** Use `src/money`. No floats, no bare numerics in a money
   position.
2. **Three verdicts only**: `MATCHED`, `REVIEW`, `REFUSED`. No fourth, no silent default.
3. **The model does not match.** Tiers 1 to 3 deterministic; 4 and 5 handle residue only.
4. **Never tune against the test split.** It is opened once, at the end.
5. **No credentials, no real identifiers, no customer data.** See `docs/REDLINES.md`.
6. **Every published number comes from `npm run eval`.** If it cannot be regenerated by
   that command it does not go in the README.

### Gotchas that cost time already

- **Node runs TypeScript by stripping types.** No parameter properties, no enums, no
  namespaces, no decorators. Imports carry `.ts`. See ADR 0004.
- **Bash heredocs break on apostrophes** in this environment. For prose files use the Write
  tool, not `cat <<'EOF'`.
- **`python - <<'PY'` string replaces fail silently** when the target does not match.
  Always assert, and verify with grep afterwards.
- **`eval/fixtures/large/` is gitignored** at 13MB. Regenerate with `npm run gen:large`;
  it is byte identical from its seed. `dev` and `test` ARE committed.
- **Credentials**: `GITHUB_TOKEN` lives in `C:\Coding Projects\Elvatio Internal OS\.env.local`.
  Read it into a shell variable, never echo it, push using
  `git -c http.extraheader="Authorization: Basic $AUTH"` so it never enters `.git/config`.
  Filter all output through a redaction sed.

---

## Things already tried. Do not repeat them

Each was measured and rejected on evidence. Full detail in `docs/BUILD-LOG.md`.

| Tried | Result |
|---|---|
| Searching a 6 day window for the batch day | 5.3% coverage. The batch day is DERIVED, T+2 working days |
| Enumerating removals by identity | 1,287 sets per day. Search over COUNTS instead |
| `maxRemove: 5` | did not finish 399 rows in 2 minutes, and precision past perturbation 3 is worse than a coin flip |
| A tolerance for converted amounts | correct refusals fell 24/25 → 11/25. Unrelated subsets tied to orphans |
| A 12 day conversion window check | coverage to zero. The batch DAY is the right granularity |
| Hand written confidence formula | ECE 0.176, one bucket stated 0.21 while observing 0.87 |
| Pooled fallback below 8 observations | replaced a measured 0.60 with 0.82. Laplace smoothing instead |
| Fitting calibration on a GATED run | circular. Fit from `minConfidence: 0` |
| Ambiguity feature v1, same day twins | measures what ADR 0005 discards. Refused all 1,471 rows at scale |
| Ambiguity feature v2, cross day availability | collapsed to a constant, nearly every payment qualifies |
| Mutual exclusion alone | tested BEFORE building: worth 3 of 17 false matches |
| Batch day exclusivity | built and measured: changed nothing. Kept because it is true |

**The pattern worth remembering:** twice a feature was implemented before checking whether
its value varied across the corpus. A two minute histogram would have killed both. Measure
the distribution of a signal before building on it.

The one that worked, ambiguity feature v3, is **search margin**: how far ahead the winning
answer is from the next materially different one. Monotonic in every family. Both failures
measured whether an alternative EXISTED; what predicts an error is whether one was
COMPETITIVE.

---

## The narrative, for the README and the video

Two real incidents at a business Jaz operates drive the whole design. Neither names a
customer; both are described by failure class only.

- **The invisible payer.** A subscription charged successfully for 43 days while no
  customer record existed. Revenue arriving, attributed to nothing, found by a human
  noticing a total that felt wrong. This is class **F08**, the orphan credit, and it is why
  `REFUSED` is the most valuable output the system has.
- **The plausible wrong number.** A currency conversion applied at two layers made reported
  revenue read roughly 3.6x its true value. Nothing caught it. This is class **F01**, and it
  is why `src/money` exists. `src/money/money.test.ts` contains a test named *"makes a
  double conversion impossible to express"* that reproduces it and proves it now throws.

Two findings from the build itself are worth as much:

- **The API returns `amount` as an integer in paise; a dashboard export writes rupees with
  two decimals.** Same field, two units, neither payload naming which. F01 exists in the
  shipped product, not just in the corpus. See `docs/SCHEMA-PROVENANCE.md`.
- **The report once printed `precision n/a`, `false matches 0`, `ECE 0.000 (0 is perfect)`
  over zero auto matched rows.** A system that answers nothing scores perfectly on every
  ratio metric. That is the exact failure this project argues against, found in its own
  reporting layer. It now refuses to render vacuous ratios.

---

## Open questions worth thinking about

- Is the corpus realistic, or merely hard? `settlementExportGapRate: 0.18` and
  `latePaymentRate: 0.14` were guesses. The sensitivity sweep answers this.
- Can tiers 4 and 5 lift coverage at scale, or is a dense book with a small price catalogue
  simply not reconcilable to this precision by evidence alone? Either answer is publishable.
- Should the confidence table ship per corpus density rather than as one fitted artefact?
  It did not transfer from dev to large, and that limitation is currently undisclosed
  outside the build log.
