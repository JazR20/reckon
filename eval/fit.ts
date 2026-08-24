/**
 * Fits the confidence table from the dev split.
 *
 *   npm run fit
 *
 * Runs the matcher against dev, scores every auto matched row, and writes the observed
 * precision per evidence bucket to src/match/calibration.json.
 *
 * This reads dev and only dev. Fitting on the held out split would make its result a
 * measurement of the fit rather than of the system, which is the whole point of ADR 0003.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ingest } from "../src/ingest/sources.ts";
import { DEFAULT_RUN, runDeterministic } from "../src/match/pipeline.ts";
import { fitCalibration, type Features } from "../src/match/confidence.ts";
import { canonicalForm, type PaymentFacts } from "./scoring/equivalence.ts";

const SPLIT = "dev";
const dir = `eval/fixtures/${SPLIT}`;

const sources = await ingest(join(dir, "sources"));
const truth = JSON.parse(await readFile(join(dir, "truth.json"), "utf8")) as {
  entries: { row: number; paymentIds: string[]; duplicateOfRow: number | null }[];
};
const truthByRow = new Map(truth.entries.map((e) => [e.row, e] as const));

const factsById = new Map<string, PaymentFacts>();
for (const p of sources.payments) {
  factsById.set(p.id, {
    id: p.id,
    captureDate: p.capturedAt,
    currency: p.amount.currency,
    minor: p.amount.minor,
  });
}
const facts = (ids: readonly string[]): PaymentFacts[] =>
  ids.flatMap((id) => {
    const f = factsById.get(id);
    return f ? [f] : [];
  });

// Fitted from an UNGATED run, deliberately.
//
// Confidence is the measured precision of rows carrying the same evidence, and the gate
// then admits rows by that confidence. Fitting from a gated run would measure the gate's
// own output and the two would chase each other. So the gate is opened fully here, every
// candidate the solver produces is scored, and the table describes the solver rather than
// the gate applied to it.
const decisions = runDeterministic(sources, { ...DEFAULT_RUN, minConfidence: 0 });
const observations: { features: Features; correct: boolean }[] = [];
for (const decision of decisions) {
  if (decision.verdict !== "MATCHED") continue;
  const entry = truthByRow.get(decision.row);
  if (!entry || entry.duplicateOfRow !== null) continue;
  observations.push({
    features: {
      perturbation: decision.perturbation,
      settlementPresent: decision.settlementId !== null,
      firstRound: decision.round <= 1,
    },
    correct: canonicalForm(facts(decision.paymentIds)) === canonicalForm(facts(entry.paymentIds)),
  });
}

const table = fitCalibration(observations, {
  fittedOn: SPLIT,
  fittedAt: sources.bank[0]?.date ?? "unknown",
  minObservations: 1,
});

await writeFile("src/match/calibration.json", JSON.stringify(table, null, 2) + "\n", "utf8");
console.log(`\nfitted on ${observations.length} auto matched rows from ${SPLIT}`);
console.log(`  pooled precision ${table.pooled}`);
for (const bucket of Object.values(table.buckets).sort((a, b) => a.key.localeCompare(b.key))) {
  const trusted = bucket.n < 8 ? `  (n=${bucket.n}, smoothed toward 0.5)` : "";
  console.log(`  ${bucket.key.padEnd(12)} n=${String(bucket.n).padStart(3)}  precision ${bucket.precision}${trusted}`);
}
console.log(`\nwrote src/match/calibration.json\n`);
