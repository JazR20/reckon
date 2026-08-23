/**
 * Corpus configuration, per split.
 *
 * dev and test share IDENTICAL parameters and differ only in seed. That is the point of
 * ADR 0003: the held out split must be the same problem drawn again, not an easier or
 * harder one. Anything that differs between them would make the comparison meaningless.
 *
 * The period is a full financial year, 2025-07-01 to 2026-06-30. A year is chosen rather
 * than a month because throughput and cost per thousand records are reported metrics and
 * both are uninformative over a small batch.
 */

import { type IsoDate, isoDate } from "./dates.ts";
import type { FaultConfig } from "./faults.ts";
import type { EmitConfig } from "./emit.ts";
import type { WorldConfig } from "./world.ts";

export type Split = "dev" | "test";

export const PERIOD_START: IsoDate = isoDate(2025, 7, 1);
export const PERIOD_END: IsoDate = isoDate(2026, 6, 30);

export const WORLD: WorldConfig = {
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  subscriberCount: 140,
  dailyOrdersMean: 9,
  dailyOrdersSpread: 4,
  failedPaymentRate: 0.08,
  latePaymentRate: 0.14,
  refundRate: 0.05,
  chargebackRate: 0.004,
  orphanCreditCount: 11,
  noiseCreditCount: 14,
};

export const FAULTS: FaultConfig = {
  dateSkewRate: 0.12,
  narrationDamageRate: 0.22,
  foreignPaymentRate: 0.03,
  missingRateDayCount: 4,
  unitAmbiguityCount: 8,
  duplicatePaymentCount: 6,
  duplicateBankTxnCount: 5,
};

export const EMIT: EmitConfig = {
  // the single most load bearing difficulty parameter. See the header of emit.ts
  settlementExportGapRate: 0.18,
};

export const SEEDS: Record<Split, string> = {
  dev: "reckon-dev-v1",
  test: "reckon-test-v1",
};

export function outDirFor(split: Split): string {
  return `eval/fixtures/${split}`;
}
