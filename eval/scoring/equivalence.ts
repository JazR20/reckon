/**
 * The definition of a correct answer.
 *
 * This is the single most load bearing definition in the project, so it lives in one
 * small file with its own tests rather than being inlined into a scorer where it would
 * quietly drift. See docs/decisions/0005-value-equivalence-is-the-scoring-rule.md for
 * why it is shaped this way and what was measured to arrive at it.
 *
 * The short version: some payments in this domain are genuinely interchangeable. Two
 * customers on the same subscription plan, charged the same amount on the same day, with
 * late settlement putting one in each of two batches. Both assignments tie to the paisa
 * and no source file distinguishes them. Demanding the exact set therefore scores a coin
 * flip, and a perfect matcher tops out at 40 percent on the dev corpus.
 *
 * So the canonical form of a payment set discards identity and keeps the part the sources
 * actually determine: what money, from what day, in what currency.
 */

export interface PaymentFacts {
  readonly id: string;
  readonly captureDate: string;
  readonly currency: string;
  readonly minor: bigint;
}

/**
 * Sorted multiset of (captureDate, currency, minor). Stable, comparable as a string, and
 * deliberately blind to payment identity.
 */
export function canonicalForm(payments: readonly PaymentFacts[]): string {
  return payments
    .map((p) => `${p.captureDate}|${p.currency}|${p.minor.toString()}`)
    .sort()
    .join("\n");
}

/** The money is attributed correctly, whoever it is labelled as coming from. */
export function isValueEquivalent(
  predicted: readonly PaymentFacts[],
  truth: readonly PaymentFacts[],
): boolean {
  return canonicalForm(predicted) === canonicalForm(truth);
}

/** The exact same payments, by identity. Reported against the ceiling, never alone. */
export function isStrictlyEqual(
  predicted: readonly PaymentFacts[],
  truth: readonly PaymentFacts[],
): boolean {
  if (predicted.length !== truth.length) return false;
  const a = [...predicted.map((p) => p.id)].sort();
  const b = [...truth.map((p) => p.id)].sort();
  return a.every((id, i) => id === b[i]);
}

/**
 * Where a value equivalent match differs from the truth by identity alone, name the
 * substitutions. This goes into the evidence chain so a human reviewing the row sees
 * that the difference is a naming ambiguity and not a mis-attribution of money.
 */
export function describeSubstitutions(
  predicted: readonly PaymentFacts[],
  truth: readonly PaymentFacts[],
): string[] {
  if (!isValueEquivalent(predicted, truth)) return [];
  const truthIds = new Set(truth.map((p) => p.id));
  const predictedIds = new Set(predicted.map((p) => p.id));
  const added = predicted.filter((p) => !truthIds.has(p.id));
  const removed = truth.filter((p) => !predictedIds.has(p.id));
  return added.map((a, i) => {
    const r = removed[i];
    return r
      ? `${a.id} in place of ${r.id}, same day and same amount, indistinguishable in the sources`
      : `${a.id} unmatched in truth`;
  });
}
