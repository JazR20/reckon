/**
 * Confidence, fitted rather than invented.
 *
 * The first version was a hand written formula: start from a base, subtract for
 * perturbation, subtract for the propagation round, subtract if no settlement row.
 * It produced an expected calibration error of 0.176, and one bucket stated 0.21 while
 * observing 0.87.
 *
 * A confidence number that does not mean what it says is worse than no number, because a
 * human reading the report will act on it. So it is no longer a formula. It is the
 * measured precision of rows sharing the same evidence, fitted on the dev split and
 * loaded from `calibration.json`.
 *
 * THE RULE THAT MAKES THIS LEGITIMATE: fitted on dev, never on test. The test split is
 * generated on day one, never inspected, and run once at the end. If the fit does not
 * generalise, the test result says so and that gap is what gets published. See ADR 0003.
 *
 * Small buckets are handled by Laplace smoothing rather than by a fallback. A first
 * version fell back to the pooled rate below eight observations, which replaced a
 * measured 0.60 with a pooled 0.82 and made the calibration worse in exactly the buckets
 * that most needed honesty. (correct + 1) / (n + 2) shrinks a small bucket toward 0.5 on
 * its own, which is the conservative direction, and it does so smoothly.
 */

import { readFileSync } from "node:fs";

export interface Features {
  /** payments that had to settle off cycle to explain the credit */
  readonly perturbation: number;
  /** was a settlement row available to pin the gross exactly */
  readonly settlementPresent: boolean;
  /** committed in the first propagation round, or later after contests resolved */
  readonly firstRound: boolean;
  /**
   * How far ahead of the next materially different answer this one is.
   *
   * Two earlier features measured whether an alternative EXISTED and both collapsed to a
   * constant, once via same day twins and once via cross day availability. This measures
   * whether an alternative was COMPETITIVE, which is what actually predicts an error, and
   * it is the standard margin signal for any search that returns a best candidate.
   */
  readonly margin: number;
}

export interface Bucket {
  readonly key: string;
  readonly n: number;
  readonly correct: number;
  readonly precision: number;
}

export interface CalibrationTable {
  readonly fittedOn: string;
  readonly fittedAt: string;
  readonly minObservations: number;
  readonly pooled: number;
  readonly buckets: Record<string, Bucket>;
  readonly note: string;
}

export function featureKey(features: Features): string {
  const p = Math.min(features.perturbation, 3);
  // wide, narrow, none. A margin of 1 means a rival was one step behind
  const m = features.margin >= 3 ? 2 : features.margin >= 2 ? 1 : 0;
  return `p${p}|s${features.settlementPresent ? 1 : 0}|r${features.firstRound ? 1 : 0}|m${m}`;
}

let cached: CalibrationTable | null = null;

export function loadCalibration(path = "src/match/calibration.json"): CalibrationTable | null {
  if (cached) return cached;
  try {
    cached = JSON.parse(readFileSync(path, "utf8")) as CalibrationTable;
    return cached;
  } catch {
    // no table fitted yet. The matcher still runs, it simply cannot state a calibrated
    // confidence, and says so by returning null rather than inventing one.
    return null;
  }
}

export function confidenceFor(features: Features, table: CalibrationTable | null): number {
  if (!table) return 0.5;
  const bucket = table.buckets[featureKey(features)];
  if (!bucket) return table.pooled;
  return bucket.precision;
}

/** Build a table from observed outcomes. Used by `npm run fit`, never at match time. */
export function fitCalibration(
  observations: readonly { features: Features; correct: boolean }[],
  options: { fittedOn: string; fittedAt: string; minObservations: number },
): CalibrationTable {
  const buckets: Record<string, Bucket> = {};
  const counts = new Map<string, { n: number; correct: number }>();
  for (const observation of observations) {
    const key = featureKey(observation.features);
    const entry = counts.get(key) ?? { n: 0, correct: 0 };
    entry.n++;
    if (observation.correct) entry.correct++;
    counts.set(key, entry);
  }
  for (const [key, entry] of counts) {
    buckets[key] = {
      key,
      n: entry.n,
      correct: entry.correct,
      // Laplace smoothing, so a bucket that happens to be perfect on twelve samples does
      // not claim 1.00 and a bucket that happens to be empty of successes does not claim 0
      precision: Number(((entry.correct + 1) / (entry.n + 2)).toFixed(4)),
    };
  }
  const totalN = observations.length;
  const totalCorrect = observations.filter((o) => o.correct).length;
  return {
    fittedOn: options.fittedOn,
    fittedAt: options.fittedAt,
    minObservations: options.minObservations,
    pooled: Number(((totalCorrect + 1) / (totalN + 2)).toFixed(4)),
    buckets,
    note:
      "Fitted on the dev split only. Never fitted on test. Precision figures carry Laplace smoothing so a small bucket cannot claim certainty. Regenerate with npm run fit.",
  };
}
