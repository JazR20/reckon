import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EMIT, FAULTS, SEEDS, WORLD } from "./config.ts";
import { planCorruption } from "./faults.ts";
import { Rng } from "./rng.ts";
import { difficultyProfile, verifyWorld } from "./verify.ts";
import { buildWorld } from "./world.ts";
import {
  canonicalForm,
  describeSubstitutions,
  isStrictlyEqual,
  isValueEquivalent,
  type PaymentFacts,
} from "../scoring/equivalence.ts";

/** Build a world plus its corruption plan without touching the filesystem. */
function build(seed: string) {
  const root = new Rng(seed);
  const world = buildWorld(root.fork("world"), WORLD);
  const { truth } = planCorruption(root.fork("faults"), world, FAULTS);
  return { world, truth };
}

describe("rng determinism", () => {
  it("produces the same stream for the same seed", () => {
    const a = new Rng("abc");
    const b = new Rng("abc");
    const drawsA = Array.from({ length: 50 }, () => a.int(0, 1_000_000));
    const drawsB = Array.from({ length: 50 }, () => b.int(0, 1_000_000));
    assert.deepEqual(drawsA, drawsB);
  });

  it("produces a different stream for a different seed", () => {
    const a = new Rng("abc");
    const b = new Rng("abd");
    assert.notDeepEqual(
      Array.from({ length: 50 }, () => a.int(0, 1_000_000)),
      Array.from({ length: 50 }, () => b.int(0, 1_000_000)),
    );
  });

  it("forks into independent streams, so adding a step does not shift later draws", () => {
    const root = new Rng("root");
    const first = root.fork("alpha").int(0, 1_000_000);
    const second = new Rng("root").fork("beta").int(0, 1_000_000);
    const firstAgain = new Rng("root").fork("alpha").int(0, 1_000_000);
    assert.equal(first, firstAgain);
    assert.notEqual(first, second);
  });
});

describe("corpus", () => {
  it("regenerates identically from the same seed", () => {
    const a = build(SEEDS.dev);
    const b = build(SEEDS.dev);
    assert.equal(a.world.payments.length, b.world.payments.length);
    assert.equal(a.world.settlements.length, b.world.settlements.length);
    assert.deepEqual(
      a.world.bankTxns.map((t) => `${t.id}|${t.date}|${t.credit?.minor ?? "-"}`),
      b.world.bankTxns.map((t) => `${t.id}|${t.date}|${t.credit?.minor ?? "-"}`),
    );
  });

  it("draws a different corpus for the test seed", () => {
    const dev = build(SEEDS.dev);
    const test = build(SEEDS.test);
    assert.notDeepEqual(
      dev.world.bankTxns.map((t) => t.credit?.minor ?? 0n),
      test.world.bankTxns.map((t) => t.credit?.minor ?? 0n),
    );
  });

  it("satisfies every ground truth invariant on both splits", () => {
    for (const seed of [SEEDS.dev, SEEDS.test]) {
      const { world, truth } = build(seed);
      const asEmitted = truth.map((t, i) => ({
        row: i + 1,
        bankTxnId: t.bankTxnId,
        settlementId: t.settlementId,
        settlementRowPresent: true,
        paymentIds: t.paymentIds,
        faults: t.faults,
        note: t.note,
        duplicateOfRow: null,
      }));
      const violations = verifyWorld(world, asEmitted);
      assert.deepEqual(violations, [], `${seed}: ${JSON.stringify(violations.slice(0, 3))}`);
    }
  });

  it("lands inside the difficulty band section 6.1 requires", () => {
    const { world, truth } = build(SEEDS.dev);
    const asEmitted = truth.map((t, i) => ({
      row: i + 1,
      bankTxnId: t.bankTxnId,
      settlementId: t.settlementId,
      settlementRowPresent: true,
      paymentIds: t.paymentIds,
      faults: t.faults,
      note: t.note,
      duplicateOfRow: null,
    }));
    const profile = difficultyProfile(asEmitted, world);

    // a meaningful share must be unmatchable, or REFUSED is never the right answer
    assert.ok((profile.pctUnmatchable ?? 0) > 2, "too few unmatchable records");
    // and a meaningful share must be genuinely ambiguous, or REVIEW is never right either
    assert.ok((profile.pctPaymentsInterchangeable ?? 0) > 5, "too little real ambiguity");
    assert.ok(profile.rows !== undefined && profile.rows >= 50, "batch below the 50 record floor");
  });
});

describe("scoring rule", () => {
  const p = (id: string, date: string, minor: bigint): PaymentFacts => ({
    id,
    captureDate: date,
    currency: "INR",
    minor,
  });

  it("treats a set as equal to itself", () => {
    const set = [p("pay_a", "2026-01-05", 99900n), p("pay_b", "2026-01-05", 49900n)];
    assert.ok(isValueEquivalent(set, set));
    assert.ok(isStrictlyEqual(set, set));
  });

  it("is order independent", () => {
    const a = [p("pay_a", "2026-01-05", 99900n), p("pay_b", "2026-01-06", 49900n)];
    const b = [a[1] as PaymentFacts, a[0] as PaymentFacts];
    assert.equal(canonicalForm(a), canonicalForm(b));
    assert.ok(isStrictlyEqual(a, b));
  });

  /** The case ADR 0005 exists for. */
  it("accepts a swap of two indistinguishable payments, and strict equality does not", () => {
    const truth = [p("pay_a", "2026-01-05", 99900n), p("pay_c", "2026-01-05", 34900n)];
    const predicted = [p("pay_b", "2026-01-05", 99900n), p("pay_c", "2026-01-05", 34900n)];
    assert.ok(isValueEquivalent(predicted, truth), "same money, different label");
    assert.ok(!isStrictlyEqual(predicted, truth), "strict equality must still see a difference");
    assert.deepEqual(describeSubstitutions(predicted, truth), [
      "pay_b in place of pay_a, same day and same amount, indistinguishable in the sources",
    ]);
  });

  it("rejects a swap for a different amount", () => {
    const truth = [p("pay_a", "2026-01-05", 99900n)];
    const predicted = [p("pay_b", "2026-01-05", 99800n)];
    assert.ok(!isValueEquivalent(predicted, truth));
  });

  it("rejects a swap for the same amount on a different day", () => {
    const truth = [p("pay_a", "2026-01-05", 99900n)];
    const predicted = [p("pay_b", "2026-01-06", 99900n)];
    assert.ok(!isValueEquivalent(predicted, truth), "a different day is a different fact");
  });

  it("rejects a set with the right total but the wrong members", () => {
    // 999 + 499 against 1249 + 249. Same total, different money
    const truth = [p("pay_a", "2026-01-05", 99900n), p("pay_b", "2026-01-05", 49900n)];
    const predicted = [p("pay_c", "2026-01-05", 124900n), p("pay_d", "2026-01-05", 24900n)];
    assert.ok(!isValueEquivalent(predicted, truth), "matching the total is not matching the money");
  });

  it("treats an empty prediction against an empty truth as correct, which is REFUSED", () => {
    assert.ok(isValueEquivalent([], []));
  });

  it("rejects an empty prediction against a real truth", () => {
    assert.ok(!isValueEquivalent([], [p("pay_a", "2026-01-05", 99900n)]));
  });
});
