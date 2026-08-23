/**
 * Scores a run against ground truth.
 *
 *   npm run eval          the dev split
 *   npm run eval:test     the held out split, once, at the end
 *
 * The scoring rule is ADR 0005. Primary is value equivalence: the money is attributed to
 * the right credit, on the right day, in the right amount, and the only thing that may
 * differ is which of two indistinguishable payments was named. Strict set equality by
 * identity is reported too, always beside the ceiling a perfect matcher would hit.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ingest } from "../src/ingest/sources.ts";
import { type Decision, runDeterministic } from "../src/match/pipeline.ts";
import { canonicalForm, isStrictlyEqual, type PaymentFacts } from "./scoring/equivalence.ts";

interface TruthEntry {
  readonly row: number;
  readonly settlementId: string | null;
  readonly settlementRowPresent: boolean;
  readonly paymentIds: readonly string[];
  readonly faults: readonly string[];
  readonly note: string;
  readonly duplicateOfRow: number | null;
}

interface Scored {
  readonly decision: Decision;
  readonly truth: TruthEntry;
  readonly correctValueEquivalent: boolean;
  readonly correctStrict: boolean;
  readonly shouldRefuse: boolean;
}

function parseArgs(argv: readonly string[]): { split: "dev" | "test"; once: boolean } {
  const at = argv.indexOf("--split");
  const value = at >= 0 ? argv[at + 1] : "dev";
  if (value !== "dev" && value !== "test") throw new Error("--split must be dev or test");
  return { split: value, once: argv.includes("--once") };
}

export async function run(split: "dev" | "test"): Promise<void> {
  const dir = `eval/fixtures/${split}`;
  const started = Date.now();

  const sources = await ingest(join(dir, "sources"));
  const truthRaw = JSON.parse(await readFile(join(dir, "truth.json"), "utf8")) as {
    entries: TruthEntry[];
  };
  const truthByRow = new Map(truthRaw.entries.map((e) => [e.row, e] as const));

  const decisions = runDeterministic(sources);
  const elapsedMs = Date.now() - started;

  // payment facts, for the canonical form
  const factsById = new Map<string, PaymentFacts>();
  for (const payment of sources.payments) {
    factsById.set(payment.id, {
      id: payment.id,
      captureDate: payment.capturedAt,
      currency: payment.amount.currency,
      minor: payment.amount.minor,
    });
  }
  const facts = (ids: readonly string[]): PaymentFacts[] =>
    ids.flatMap((id) => {
      const f = factsById.get(id);
      return f ? [f] : [];
    });

  const scored: Scored[] = [];
  for (const decision of decisions) {
    const truth = truthByRow.get(decision.row);
    if (!truth) throw new Error(`no truth entry for row ${decision.row}`);
    if (truth.duplicateOfRow !== null) continue; // removed at ingest, not scored
    const predicted = facts(decision.paymentIds);
    const actual = facts(truth.paymentIds);
    const shouldRefuse = truth.paymentIds.length === 0;
    scored.push({
      decision,
      truth,
      correctValueEquivalent:
        decision.verdict === "MATCHED"
          ? canonicalForm(predicted) === canonicalForm(actual)
          : false,
      correctStrict:
        decision.verdict === "MATCHED" ? isStrictlyEqual(predicted, actual) : false,
      shouldRefuse,
    });
  }

  report(split, scored, sources, elapsedMs);
  await writeFile(
    join(dir, "last-run.json"),
    JSON.stringify({ split, elapsedMs, decisions }, null, 2) + "\n",
    "utf8",
  );
}

function report(
  split: string,
  scored: readonly Scored[],
  sources: Awaited<ReturnType<typeof ingest>>,
  elapsedMs: number,
): void {
  const total = scored.length;
  const matched = scored.filter((s) => s.decision.verdict === "MATCHED");
  const review = scored.filter((s) => s.decision.verdict === "REVIEW");
  const refused = scored.filter((s) => s.decision.verdict === "REFUSED");

  const correctVE = matched.filter((s) => s.correctValueEquivalent).length;
  const correctStrict = matched.filter((s) => s.correctStrict).length;
  const falseMatches = matched.filter((s) => !s.correctValueEquivalent);

  // refusals: was refusing right?
  const refusedCorrectly = refused.filter((s) => s.shouldRefuse).length;
  const shouldHaveRefused = scored.filter((s) => s.shouldRefuse).length;

  const pct = (n: number, d: number): string =>
    d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;

  console.log(`\n${"=".repeat(72)}`);
  console.log(`DETERMINISTIC BASELINE  ${split}  (tiers 0 to 2, no model)`);
  console.log("=".repeat(72));
  console.log(`  scored rows                 ${total}`);
  console.log(`  duplicates removed at ingest ${sources.report.duplicatesRemoved.bank} bank, ${sources.report.duplicatesRemoved.payments} payments`);
  console.log();
  console.log(`  MATCHED                     ${matched.length}  (${pct(matched.length, total)})`);
  console.log(`  REVIEW                      ${review.length}  (${pct(review.length, total)})`);
  console.log(`  REFUSED                     ${refused.length}  (${pct(refused.length, total)})`);
  console.log();
  console.log(`  PRECISION on auto matched   ${pct(correctVE, matched.length)}   <- the number that matters`);
  console.log(`  false matches               ${falseMatches.length}`);
  console.log(`  coverage (auto decided)     ${pct(matched.length, total)}`);
  console.log(`  strict set accuracy         ${pct(correctStrict, matched.length)}  (identity, see ADR 0005)`);
  console.log();
  console.log(`  refusals that were correct  ${refusedCorrectly} of ${refused.length}`);
  console.log(`  rows that SHOULD be refused ${shouldHaveRefused}, of which caught ${refusedCorrectly}`);
  console.log();
  console.log(`  wall clock                  ${elapsedMs} ms  (${(total / (elapsedMs / 1000)).toFixed(0)} rows/sec)`);
  console.log(`  model calls                 0`);
  console.log(`  cost                        0`);

  // per tier
  console.log(`\n  by deciding tier:`);
  for (const tier of ["T0", "T1", "T2", "T6"] as const) {
    const rows = scored.filter((s) => s.decision.tier === tier);
    if (rows.length === 0) continue;
    const m = rows.filter((s) => s.decision.verdict === "MATCHED");
    console.log(
      `    ${tier}  ${String(rows.length).padStart(4)} rows   matched ${String(m.length).padStart(4)}   precision ${pct(m.filter((s) => s.correctValueEquivalent).length, m.length)}`,
    );
  }

  // per failure class
  console.log(`\n  by failure class:`);
  const classes = ["F01", "F02", "F04", "F05", "F06", "F08", "F09", "F10", "F11", "F12"];
  for (const code of classes) {
    const rows = scored.filter((s) => s.truth.faults.includes(code));
    if (rows.length === 0) continue;
    const m = rows.filter((s) => s.decision.verdict === "MATCHED");
    const correct = m.filter((s) => s.correctValueEquivalent).length;
    console.log(
      `    ${code}  ${String(rows.length).padStart(4)} rows   matched ${String(m.length).padStart(4)}   precision ${pct(correct, m.length)}`,
    );
  }

  // the two structural populations
  console.log(`\n  by settlement availability:`);
  for (const [label, filter] of [
    ["settlement row present", (s: Scored) => s.truth.settlementRowPresent],
    [
      "settlement row MISSING",
      (s: Scored) => s.truth.settlementId !== null && !s.truth.settlementRowPresent,
    ],
    ["nothing to match", (s: Scored) => s.shouldRefuse],
  ] as const) {
    const rows = scored.filter(filter);
    const m = rows.filter((s) => s.decision.verdict === "MATCHED");
    console.log(
      `    ${label.padEnd(24)} ${String(rows.length).padStart(4)} rows   matched ${String(m.length).padStart(4)}   precision ${pct(m.filter((s) => s.correctValueEquivalent).length, m.length)}`,
    );
  }

  if (falseMatches.length > 0) {
    console.log(`\n  FALSE MATCHES (auto decided and wrong), first 5:`);
    for (const s of falseMatches.slice(0, 5)) {
      console.log(
        `    row ${s.decision.row}: predicted ${s.decision.paymentIds.length} payments, truth has ${s.truth.paymentIds.length}, faults ${s.truth.faults.join("+") || "none"}`,
      );
    }
  }

  console.log(`\n  PRECISION vs EVIDENCE STRENGTH:`);
  console.log(`    perturbation = payments that had to settle off cycle to explain the credit`);
  for (const p of [0, 1, 2, 3, 4, 5]) {
    const rows = matched.filter((s) => s.decision.perturbation === p);
    if (rows.length === 0) continue;
    const correct = rows.filter((s) => s.correctValueEquivalent).length;
    console.log(
      `    perturbation ${p}  ${String(rows.length).padStart(4)} matched  ${String(correct).padStart(4)} correct  precision ${pct(correct, rows.length)}`,
    );
  }
  console.log(`\n    by batch day offset from the derived anchor:`);
  for (const o of [-4, -3, -2, -1, 0, 1, 2, 3, 4]) {
    const rows = matched.filter((s) => s.decision.dayOffset === o);
    if (rows.length === 0) continue;
    const correct = rows.filter((s) => s.correctValueEquivalent).length;
    console.log(
      `    offset ${String(o).padStart(2)}  ${String(rows.length).padStart(4)} matched  ${String(correct).padStart(4)} correct  precision ${pct(correct, rows.length)}`,
    );
  }

  console.log(`\n  SECTION 6.1 CHECKPOINT`);
  const coverage = (matched.length / total) * 100;
  const band = coverage > 95 ? "TOO EASY" : coverage < 40 ? "TOO HARD" : "inside the band";
  console.log(`    deterministic coverage ${coverage.toFixed(1)}%  ->  ${band}`);
  console.log(`${"=".repeat(72)}\n`);
}

const isEntry = process.argv[1]?.replace(/\\/g, "/").endsWith("eval/run.ts");
if (isEntry) {
  const { split } = parseArgs(process.argv);
  await run(split);
}
