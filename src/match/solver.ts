/**
 * Recovering which payments are behind a bank credit.
 *
 * The corpus withholds the payment to settlement mapping on purpose, so this is a
 * constrained subset search rather than a join.
 *
 * THE ALGORITHM, and why it is shaped this way. Three versions were measured.
 *
 * The first searched a six calendar day window for the batch day and accepted the first
 * subset that summed correctly. It scored 5.3 percent coverage at 57 percent precision,
 * because on any given wrong day some combination of that day's payments happens to hit
 * the target. Searching for a fact that is derivable is how a matcher manufactures a
 * confident wrong answer.
 *
 * The second derived the batch day from the credit date, T+2 working days, and enumerated
 * removals and additions by identity. That reached 23.3 percent at 82.8 percent precision.
 * Measuring the true answers then showed why it stalled: a batch needs up to five payments
 * removed, and enumerating five removals from thirteen by identity is 1,287 sets per day
 * before additions are considered at all.
 *
 * The third, this one, searches over COUNTS rather than identities.
 *
 * That change comes from the same fact that broke the scoring rule in ADR 0005. Two
 * payments of the same amount captured on the same day are indistinguishable, so
 * enumerating both orderings explores two paths to one answer. Bucketing the pool by
 * (capture day, amount) and choosing how many to take from each bucket collapses the
 * search into exactly the space of distinguishable answers. It is faster, and it removes
 * a class of spurious ambiguity: two solutions that were only ever a relabelling now
 * collide into one entry instead of sending a decidable row to review.
 *
 * The bucket key IS the canonical form of ADR 0005. That is not a coincidence.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: choose between materially different answers. If two
 * genuinely distinct payment sets reproduce the credit, both are returned and the caller
 * sends the row to review.
 */

import { type Money, equals, sum } from "../money/index.ts";
import type { PaymentRow } from "../ingest/sources.ts";
import { type PaymentEconomics, netOfBatch } from "./fees.ts";

export interface ValuedPayment {
  readonly payment: PaymentRow;
  readonly gross: Money;
  readonly economics: PaymentEconomics;
  /** false when a foreign payment has no published rate, so it cannot be valued at all */
  readonly resolvable: boolean;
  /**
   * True when the value was reached by converting from another currency.
   *
   * A converted value is APPROXIMATE and cannot be treated as exact. The gateway settled
   * at its own rate at its own timestamp; a published daily rate does not reproduce that.
   * Measured on the dev corpus: 120 of 120 convertible payments land off their true value,
   * for example a 349.00 charge reported as USD 4.17 converting back to 349.07.
   *
   * Before this flag existed, a batch containing one of these could never tie exactly, so
   * the solver found a DIFFERENT subset that did. F11 precision was 0.0 percent across ten
   * auto matched rows. Every one was a plausible wrong answer produced by a currency round
   * trip, which is the same failure that motivated ADR 0002.
   */
  readonly approximate: boolean;
}

export interface SolveOptions {
  readonly maxRemove: number;
  readonly maxAdd: number;
  /** working days between the batch day and the credit. The contracted settlement cycle */
  readonly settlementLagWorkingDays: number;
  /** calendar days either side of the derived batch day, for holidays and statement skew */
  readonly batchDayTolerance: number;
  /** how many calendar days before the batch day a straggler may have been captured */
  readonly stragglerLookback: number;
  /** stop after this many distinct solutions. Two is enough to know it is ambiguous */
  readonly solutionLimit: number;
}

/**
 * Bounds chosen from measurement, and then deliberately tightened below what coverage
 * alone would want.
 *
 * The true answers need up to 5 removals to be reachable at all, and a first pass used 5.
 * Two measurements argued it back down to 3.
 *
 * Precision by perturbation: 92.3 percent at zero, 81.5 at one, 61.1 at two, 40.0 at
 * three, 0.0 at five. Everything found beyond three is worse than a coin flip, so
 * searching for it buys wrong answers.
 *
 * Cost: removal vectors grow combinatorially. At 5 over eight buckets the search did not
 * finish a 399 row corpus inside two minutes; at 3 it is a fraction of the work.
 *
 * Faster and more accurate at once, because the expensive part and the inaccurate part
 * were the same part. What is given up is reachability of the tail, and the honest
 * consequence is that those rows go to review rather than to a confident wrong answer.
 */
export const DEFAULT_SOLVE: SolveOptions = {
  maxRemove: 3,
  maxAdd: 3,
  settlementLagWorkingDays: 2,
  batchDayTolerance: 3,
  stragglerLookback: 5,
  solutionLimit: 3,
};

export type SolveMode =
  | { readonly kind: "gross"; readonly target: Money; readonly refunds: Money }
  | { readonly kind: "net"; readonly target: Money; readonly refunds: Money };

export interface Solution {
  readonly members: readonly ValuedPayment[];
  readonly batchDay: string;
  readonly removed: number;
  readonly added: number;
  /** members whose value is a conversion, so the tie is approximate rather than exact */
  readonly approximateMembers: number;
  /**
   * True when the day this solution was drawn from contains a payment whose rupee value
   * is a conversion.
   *
   * Scoped to the SOLUTION's day, not the anchor day. An earlier version checked only the
   * anchor and missed three false matches whose true batch sat at offset +1 or +2: the
   * true batch contained a converted payment and so could never tie exactly, and the
   * solver quietly fell through to an all-rupee alternative on the same day.
   */
  readonly batchDayHasConversion: boolean;
  /**
   * Members that could have been a different payment.
   *
   * A member drawn from a bucket that still held others is interchangeable: an
   * amount identical payment captured the same day was left behind, and nothing in the
   * sources says which of them belongs here.
   *
   * This exists because a confidence table fitted on the dev corpus did not transfer to a
   * four times denser one. Dev buckets measured at 90 percent precision scored 40 percent
   * at scale. The cause is that identical evidence means something different when
   * interchangeability is 56 percent rather than 23: the same perturbation, on the same
   * kind of reference, is a far weaker claim in a dense book.
   *
   * Counting the ambiguity a solution actually faced, rather than inferring it from the
   * corpus it came from, is what lets one fitted table hold across densities.
   */
  readonly interchangeableMembers: number;
}

export interface SolveResult {
  readonly kind: "unique" | "ambiguous" | "none";
  readonly solutions: readonly Solution[];
  readonly daysTried: number;
  readonly nodesVisited: number;
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = Date.UTC(y as number, (m as number) - 1, d as number) + days * DAY_MS;
  const out = new Date(at);
  return `${out.getUTCFullYear()}-${String(out.getUTCMonth() + 1).padStart(2, "0")}-${String(out.getUTCDate()).padStart(2, "0")}`;
}

function isWeekend(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y as number, (m as number) - 1, d as number)).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Step back n working days, skipping weekends.
 *
 * Bank holidays are deliberately NOT modelled. A holiday shifts the real cycle by a day,
 * the derived anchor is then wrong, and the row falls to review rather than to a confident
 * wrong answer. Encoding a holiday calendar that cannot be checked against the sources
 * would buy coverage by assuming something the sources never state.
 */
export function workingDaysBefore(date: string, n: number): string {
  let cursor = date;
  let remaining = n;
  let guard = 0;
  while (remaining > 0) {
    cursor = addDays(cursor, -1);
    if (!isWeekend(cursor)) remaining--;
    if (++guard > 60) break;
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// buckets: the unit of search
// ---------------------------------------------------------------------------

export interface Bucket {
  readonly day: string;
  readonly minor: bigint;
  readonly members: ValuedPayment[];
}

export function bucketise(payments: readonly ValuedPayment[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const valued of payments) {
    const key = `${valued.payment.capturedAt}|${valued.gross.minor.toString()}`;
    const existing = map.get(key);
    if (existing) existing.members.push(valued);
    else
      map.set(key, {
        day: valued.payment.capturedAt,
        minor: valued.gross.minor,
        members: [valued],
      });
  }
  // largest amounts first: the strongest prune in a positive-only subset sum
  return [...map.values()].sort((a, b) => (b.minor > a.minor ? 1 : b.minor < a.minor ? -1 : 0));
}

/** How many to take from each bucket. Index aligned with a bucket list. */
type Counts = number[];

function countsKey(buckets: readonly Bucket[], counts: Counts): string {
  const parts: string[] = [];
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i] as number;
    if (n > 0) {
      const bucket = buckets[i] as Bucket;
      parts.push(`${bucket.day}|${bucket.minor.toString()}|${n}`);
    }
  }
  return parts.sort().join("\n");
}

function materialise(buckets: readonly Bucket[], counts: Counts): ValuedPayment[] {
  const out: ValuedPayment[] = [];
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i] as number;
    if (n > 0) out.push(...(buckets[i] as Bucket).members.slice(0, n));
  }
  return out;
}

/**
 * Members taken from a bucket that still held others. Each is a coin flip the sources do
 * not decide, so each is a reason to trust the answer less.
 */
function countInterchangeable(buckets: readonly Bucket[], counts: Counts): number {
  let total = 0;
  for (let i = 0; i < counts.length; i++) {
    const taken = counts[i] as number;
    if (taken <= 0) continue;
    const stock = (buckets[i] as Bucket).members.length;
    if (stock > taken) total += taken;
  }
  return total;
}

function grossOf(buckets: readonly Bucket[], counts: Counts): bigint {
  let total = 0n;
  for (let i = 0; i < counts.length; i++) {
    total += (buckets[i] as Bucket).minor * BigInt(counts[i] as number);
  }
  return total;
}

/**
 * Every count vector over `buckets` whose value falls in [low, high], taking at most
 * `maxTotal` items overall.
 *
 * Depth first over buckets sorted by descending amount. Every amount is positive, so a
 * running value above `high` can never recover and that branch is abandoned.
 */
export function countVectorsSummingInto(
  buckets: readonly Bucket[],
  low: bigint,
  high: bigint,
  maxTotal: number,
  limit: number,
  counter: { nodes: number },
): Counts[] {
  const found: Counts[] = [];
  if (maxTotal < 0) return found;
  // nothing to add is a valid answer whenever zero is inside the range, and it is by far
  // the most common one, so it is checked before any search happens
  if (low <= 0n && high >= 0n) found.push(new Array<number>(buckets.length).fill(0));
  if (high <= 0n || buckets.length === 0 || maxTotal === 0) return found;

  const counts: Counts = new Array<number>(buckets.length).fill(0);

  // THE PRUNE THAT MAKES THIS TRACTABLE.
  //
  // suffixMax[i][k] is the largest value reachable using at most k items drawn from
  // buckets i onward. Without it, a search that cannot possibly reach the target still
  // walks the entire skip chain, and exhausting a row with no answer costs more than
  // solving one. Rows with no answer are the orphan credits, which is precisely the
  // population this system exists to surface, so making them the slowest case would have
  // been the wrong trade.
  const n = buckets.length;
  const suffixMax: bigint[][] = [];
  for (let i = n; i >= 0; i--) {
    const row: bigint[] = new Array<bigint>(maxTotal + 1).fill(0n);
    if (i < n) {
      const bucket = buckets[i] as Bucket;
      const next = suffixMax[i + 1] as bigint[];
      for (let k = 0; k <= maxTotal; k++) {
        let best = next[k] as bigint;
        const capacity = Math.min(bucket.members.length, k);
        for (let take = 1; take <= capacity; take++) {
          const candidate = bucket.minor * BigInt(take) + ((next[k - take] as bigint) ?? 0n);
          if (candidate > best) best = candidate;
        }
        row[k] = best;
      }
    }
    suffixMax[i] = row;
  }

  const recurse = (index: number, running: bigint, taken: number): void => {
    counter.nodes++;
    if (found.length >= limit) return;
    if (running > 0n && running >= low && running <= high) {
      found.push([...counts]);
      if (found.length >= limit) return;
    }
    if (index >= n || taken >= maxTotal || running > high) return;
    // cannot reach the floor of the range with what is left
    if (running + ((suffixMax[index] as bigint[])[maxTotal - taken] as bigint) < low) return;

    const bucket = buckets[index] as Bucket;
    const capacity = Math.min(bucket.members.length, maxTotal - taken);
    for (let take = capacity; take >= 1; take--) {
      const next = running + bucket.minor * BigInt(take);
      if (next > high) continue;
      counts[index] = take;
      recurse(index + 1, next, taken + take);
      counts[index] = 0;
      if (found.length >= limit) return;
    }
    recurse(index + 1, running, taken);
  };

  recurse(0, 0n, 0);
  return found;
}

/** Every way to take exactly `size` items across buckets, respecting each bucket's stock. */
function countVectorsOfExactSize(
  buckets: readonly Bucket[],
  size: number,
  counter: { nodes: number },
): Counts[] {
  const out: Counts[] = [];
  const counts: Counts = new Array<number>(buckets.length).fill(0);
  const recurse = (index: number, remaining: number): void => {
    counter.nodes++;
    if (remaining === 0) {
      out.push([...counts]);
      return;
    }
    if (index >= buckets.length) return;
    const capacity = Math.min((buckets[index] as Bucket).members.length, remaining);
    for (let n = capacity; n >= 0; n--) {
      counts[index] = n;
      recurse(index + 1, remaining - n);
      counts[index] = 0;
    }
  };
  recurse(0, size);
  return out;
}

// ---------------------------------------------------------------------------
// the solve
// ---------------------------------------------------------------------------

/**
 * Buckets are computed once per day and reused across every row that considers that day.
 *
 * Without this the same day is re-bucketised for every credit that could plausibly draw
 * from it, which on a year of data is thousands of redundant passes. Throughput is a
 * reported metric, and rebuilding an immutable structure inside the hot loop is the
 * cheapest possible thing to stop doing.
 */
export interface SolveCache {
  readonly byDay: Map<string, ValuedPayment[]>;
  /** available payments on a day, after exclusions */
  readonly available: Map<string, ValuedPayment[]>;
  /** buckets for a single day */
  readonly buckets: Map<string, Bucket[]>;
  /** buckets for the straggler window behind a batch day */
  readonly stragglerBuckets: Map<string, Bucket[]>;
  /** every reachable addition sum for a batch day, indexed. See addIndexFor */
  readonly addIndex: Map<string, AddIndex>;
  readonly excluded: Set<string>;
  /**
   * Batch days already claimed by a committed credit.
   *
   * A gateway produces one settlement per batch day, so two credits cannot both be that
   * day's payout. This is a stronger constraint than payment exclusivity and it targets
   * the measured weakness directly: weekend captures settle alongside Friday's, so a
   * Tuesday statement carries up to three credits competing for three batch days. Solving
   * them independently let each prefer the nearest day, and offset 0 measured 54.2 percent
   * precision against 90 and 100 percent at offsets 1 and 2.
   */
  readonly claimedDays: Set<string>;
  /** days touched by the most recent exclusion, so unaffected rows need not re-solve */
  dirtyDays: Set<string>;
}

export function buildCache(pool: readonly ValuedPayment[]): SolveCache {
  const byDay = new Map<string, ValuedPayment[]>();
  for (const valued of pool) {
    const bucket = byDay.get(valued.payment.capturedAt);
    if (bucket) bucket.push(valued);
    else byDay.set(valued.payment.capturedAt, [valued]);
  }
  return {
    byDay,
    available: new Map(),
    buckets: new Map(),
    stragglerBuckets: new Map(),
    addIndex: new Map(),
    excluded: new Set(),
    claimedDays: new Set(),
    dirtyDays: new Set(),
  };
}

/** Days whose contents changed since the last call, for skipping unaffected rows. */
export function dirtyDaysOf(cache: SolveCache): ReadonlySet<string> {
  return cache.dirtyDays;
}

export function clearDirty(cache: SolveCache): void {
  cache.dirtyDays = new Set();
}

/** Payments already committed to another credit are no longer available to this one. */
/** Mark a batch day as spoken for. No other credit may be explained by it. */
export function claimBatchDay(cache: SolveCache, day: string): void {
  cache.claimedDays.add(day);
  cache.dirtyDays.add(day);
}

export function excludeFromCache(
  cache: SolveCache,
  payments: Iterable<{ id: string; day: string }>,
): void {
  for (const { id, day } of payments) {
    cache.excluded.add(id);
    cache.dirtyDays.add(day);
    cache.available.delete(day);
    cache.buckets.delete(day);
  }
  // a straggler window spans several days, so any cached window overlapping a dirty day
  // is stale. Clearing the whole window map is cheaper than tracking the overlap.
  cache.stragglerBuckets.clear();
  cache.addIndex.clear();
}

function bucketsFor(cache: SolveCache, day: string): Bucket[] {
  const hit = cache.buckets.get(day);
  if (hit) return hit;
  const built = bucketise(availableOn(cache, day));
  cache.buckets.set(day, built);
  return built;
}

function availableOn(cache: SolveCache, day: string): ValuedPayment[] {
  const hit = cache.available.get(day);
  if (hit) return hit;
  const source = cache.byDay.get(day) ?? [];
  const built =
    cache.excluded.size === 0 ? source : source.filter((m) => !cache.excluded.has(m.payment.id));
  cache.available.set(day, built);
  return built;
}

/**
 * Every addition a batch day can supply, indexed by the value it adds.
 *
 * THE SCALING FIX. The inner search asks the same question once per removal vector: which
 * subsets of the straggler pool sum to this value? That question depends only on the batch
 * day, not on which payments were removed from the base, yet a depth first search was
 * being rerun for every one of roughly 286 removal vectors, on every candidate day, for
 * every row.
 *
 * On the dev corpus that is wasteful. On the large corpus it does not finish: a denser day
 * means more stock per bucket, which multiplies both the removal vectors and the paths
 * through each search.
 *
 * So it is enumerated once per batch day and cached. Lookups are then a hash hit for an
 * exact target, or a binary search over sorted sums for a range.
 *
 * The enumeration is bounded and small because the merchant sells a fixed catalogue: a
 * handful of distinct amounts across a handful of days, taken at most maxAdd at a time.
 */
interface AddIndex {
  readonly buckets: Bucket[];
  readonly bySum: Map<string, Counts[]>;
  readonly sorted: bigint[];
}

function addIndexFor(
  cache: SolveCache,
  batchDay: string,
  lookback: number,
  maxAdd: number,
): AddIndex {
  const hit = cache.addIndex.get(batchDay);
  if (hit) return hit;

  const buckets = stragglerBucketsFor(cache, batchDay, lookback);
  const bySum = new Map<string, Counts[]>();
  const counts: Counts = new Array<number>(buckets.length).fill(0);

  const record = (sum: bigint): void => {
    const key = sum.toString();
    const list = bySum.get(key);
    if (list) {
      if (list.length < 8) list.push([...counts]);
    } else {
      bySum.set(key, [[...counts]]);
    }
  };

  const recurse = (index: number, running: bigint, taken: number): void => {
    record(running);
    if (index >= buckets.length || taken >= maxAdd) return;
    const bucket = buckets[index] as Bucket;
    const capacity = Math.min(bucket.members.length, maxAdd - taken);
    for (let take = capacity; take >= 1; take--) {
      counts[index] = take;
      recurse(index + 1, running + bucket.minor * BigInt(take), taken + take);
      counts[index] = 0;
    }
    recurse(index + 1, running, taken);
  };
  recurse(0, 0n, 0);

  const sorted = [...bySum.keys()].map((k) => BigInt(k)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const built: AddIndex = { buckets, bySum, sorted };
  cache.addIndex.set(batchDay, built);
  return built;
}

/** Count vectors whose value lands in [low, high], via the cached index. */
function additionsInRange(index: AddIndex, low: bigint, high: bigint, limit: number): Counts[] {
  if (low === high) return index.bySum.get(low.toString()) ?? [];
  const out: Counts[] = [];
  let lo = 0;
  let hi = index.sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((index.sorted[mid] as bigint) < low) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < index.sorted.length; i++) {
    const value = index.sorted[i] as bigint;
    if (value > high) break;
    out.push(...(index.bySum.get(value.toString()) ?? []));
    if (out.length >= limit) break;
  }
  return out;
}

function stragglerBucketsFor(cache: SolveCache, batchDay: string, lookback: number): Bucket[] {
  const hit = cache.stragglerBuckets.get(batchDay);
  if (hit) return hit;
  const members: ValuedPayment[] = [];
  for (let s = 1; s <= lookback; s++) {
    for (const m of availableOn(cache, addDays(batchDay, -s))) {
      if (m.resolvable) members.push(m);
    }
  }
  const built = bucketise(members);
  cache.stragglerBuckets.set(batchDay, built);
  return built;
}

export function solve(
  creditDate: string,
  mode: SolveMode,
  cache: SolveCache,
  options: SolveOptions = DEFAULT_SOLVE,
): SolveResult {
  const currency = mode.target.currency;
  const counter = { nodes: 0 };
  const byCanonical = new Map<string, Solution>();

  // The batch day is DERIVED, not searched for. Tolerance covers a bank holiday shifting
  // the cycle, weekend captures that settle alongside Friday's batch, and statement skew.
  const anchor = workingDaysBefore(creditDate, options.settlementLagWorkingDays);
  const candidateDays: string[] = [anchor];
  for (let offset = 1; offset <= options.batchDayTolerance; offset++) {
    candidateDays.push(addDays(anchor, offset), addDays(anchor, -offset));
  }

  // Solutions are ranked by how far they deviate from a clean day of captures. Every
  // removal or addition is a claim that a payment settled off cycle, so the explanation
  // making fewest such claims wins. That is Occam applied to a real mechanism, not a tie
  // break invented to raise coverage. Two materially different answers at the SAME level
  // is genuine ambiguity and goes to review.
  let bestPerturbation = Number.POSITIVE_INFINITY;
  let daysTried = 0;

  for (const batchDay of candidateDays) {
    if (cache.claimedDays.has(batchDay)) continue;
    const base = availableOn(cache, batchDay);
    if (base.length === 0) continue;
    daysTried++;
    if (base.some((m) => !m.resolvable)) continue;

    const baseBuckets = bucketsFor(cache, batchDay);
    const index = addIndexFor(cache, batchDay, options.stragglerLookback, options.maxAdd);
    const addBuckets = index.buckets;
    const baseGross = base.reduce((acc, m) => acc + m.gross.minor, 0n);

    for (let removeTotal = 0; removeTotal <= options.maxRemove; removeTotal++) {
      if (removeTotal > bestPerturbation) break;

      const removals =
        removeTotal === 0
          ? [new Array<number>(baseBuckets.length).fill(0)]
          : countVectorsOfExactSize(baseBuckets, removeTotal, counter);

      for (const removed of removals) {
        const removedGross = grossOf(baseBuckets, removed);
        const keptCounts = baseBuckets.map((b, i) => b.members.length - (removed[i] as number));
        const kept = materialise(baseBuckets, keptCounts);
        const keptGross = baseGross - removedGross;

        const { low, high } = requiredAddGross(mode, keptGross, kept);
        if (high < 0n) continue;

        const addBudget = Math.min(
          options.maxAdd,
          Math.max(
            0,
            (Number.isFinite(bestPerturbation) ? bestPerturbation : options.maxAdd + removeTotal) -
              removeTotal,
          ),
        );
        counter.nodes++;
        const additions = additionsInRange(index, low, high, 24).filter(
          (c) => c.reduce((a, b) => a + b, 0) <= addBudget,
        );

        for (const addCounts of additions) {
          const addedTotal = addCounts.reduce((a, b) => a + b, 0);
          const perturbation = removeTotal + addedTotal;
          if (perturbation > bestPerturbation) continue;

          const added = materialise(addBuckets, addCounts);
          const members = [...kept, ...added];
          if (members.length === 0) continue;
          if (!verify(mode, members, currency)) continue;

          if (perturbation < bestPerturbation) {
            bestPerturbation = perturbation;
            byCanonical.clear();
          }
          const key = `${countsKey(baseBuckets, keptCounts)}\n--\n${countsKey(addBuckets, addCounts)}`;
          if (!byCanonical.has(key)) {
            byCanonical.set(key, {
              members,
              batchDay,
              removed: removeTotal,
              added: addedTotal,
              approximateMembers: members.filter((m) => m.approximate).length,
              interchangeableMembers:
                countInterchangeable(baseBuckets, keptCounts) +
                countInterchangeable(addBuckets, addCounts),
              batchDayHasConversion: (cache.byDay.get(batchDay) ?? []).some((m) => m.approximate),
            });
          }
          if (byCanonical.size > options.solutionLimit) break;
        }
        if (byCanonical.size > options.solutionLimit) break;
      }
    }
  }

  const solutions = [...byCanonical.values()];
  return {
    kind: solutions.length === 1 ? "unique" : solutions.length === 0 ? "none" : "ambiguous",
    solutions,
    daysTried,
    nodesVisited: counter.nodes,
  };
}

/**
 * The gross the added payments must supply.
 *
 * In gross mode the target is exact, so the range is a point.
 *
 * In net mode the target is a credit and gross is not recoverable in closed form, because
 * GST is applied to the summed fee and rounded once. The range is widened by the plausible
 * deduction band and every candidate inside it is verified exactly afterwards. The band
 * bounds the search. It never decides a match.
 */
function requiredAddGross(
  mode: SolveMode,
  keptGross: bigint,
  kept: readonly ValuedPayment[],
): { low: bigint; high: bigint } {
  if (mode.kind === "gross") {
    const needed = mode.target.minor - keptGross;
    return { low: needed, high: needed };
  }
  const keptNet = netOfBatch(
    kept.map((m) => m.economics),
    mode.refunds,
  ).net;
  const shortfall = mode.target.minor - keptNet.minor;
  const slack = 200n; // two rupees absorbs the single GST rounding point
  const low = shortfall - slack;
  const high = shortfall + (shortfall > 0n ? (shortfall * 700n) / 10000n : 0n) + slack;
  return { low, high };
}

/**
 * Does this batch reproduce the target? Exactly, always.
 *
 * A tolerance was tried and removed. Allowing a one rupee band per converted member let a
 * batch containing a cross currency payment tie, but it also let UNRELATED subsets tie to
 * orphan credits. Correct refusals fell from 24 of 25 to 11 of 25. The orphan credit is
 * the highest value output this system produces, so a change that buys coverage by
 * blurring the arithmetic that finds them is the wrong trade at any exchange rate.
 *
 * Cross currency batches are handled where the information actually is, in the caller: a
 * window containing a converted value cannot be verified exactly, so the row is offered
 * for review rather than force fitted here.
 */
function verify(
  mode: SolveMode,
  members: readonly ValuedPayment[],
  currency: Money["currency"],
): boolean {
  const actual =
    mode.kind === "gross"
      ? sum(
          members.map((m) => m.gross),
          currency,
        )
      : netOfBatch(
          members.map((m) => m.economics),
          mode.refunds,
        ).net;
  return equals(actual, mode.target);
}
