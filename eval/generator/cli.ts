/**
 * Regenerates a corpus split from its committed seed.
 *
 *   npm run gen:dev
 *   npm run gen:test
 *
 * Output is deterministic. Two runs on any machine produce byte identical files.
 */

import { EMIT, SEEDS, type Split, faultsFor, outDirFor, worldFor } from "./config.ts";
import { emitCorpus } from "./emit.ts";
import { planCorruption } from "./faults.ts";
import { Rng } from "./rng.ts";
import { difficultyProfile, verifyWorld } from "./verify.ts";
import { buildWorld } from "./world.ts";

function parseSplit(argv: readonly string[]): Split {
  const index = argv.indexOf("--split");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value !== "dev" && value !== "test" && value !== "large") {
    throw new Error("Usage: cli.ts --split dev|test|large");
  }
  return value;
}

export async function generate(split: Split): Promise<void> {
  const seed = SEEDS[split];
  const root = new Rng(seed);

  const world = buildWorld(root.fork("world"), worldFor(split));
  const { corruption, truth } = planCorruption(root.fork("faults"), world, faultsFor(split));
  const outDir = outDirFor(split);
  const { truth: emitted, counts } = await emitCorpus(
    outDir,
    world,
    truth,
    corruption,
    EMIT,
    root.fork("emit"),
  );

  const violations = verifyWorld(world, emitted);
  if (violations.length > 0) {
    for (const violation of violations.slice(0, 20)) {
      console.error(`  VIOLATION ${violation.check}: ${violation.detail}`);
    }
    throw new Error(
      `Corpus failed ${violations.length} invariant check(s). The ground truth is not true, so nothing downstream can be trusted.`,
    );
  }

  const profile = difficultyProfile(emitted, world);
  console.log(`\ncorpus: ${split}   seed: ${seed}   out: ${outDir}`);
  console.log(`  orders ${world.orders.length}, payments ${world.payments.length}, ` +
    `refunds ${world.refunds.length}, settlements ${world.settlements.length}`);
  console.log("  emitted rows:", counts);
  console.log("  invariants: all passed");
  console.log("  difficulty profile:");
  for (const [key, value] of Object.entries(profile)) {
    console.log(`    ${key.padEnd(24)} ${value}`);
  }
  console.log();
}

const isEntry = process.argv[1]?.replace(/\\/g, "/").endsWith("eval/generator/cli.ts");
if (isEntry) {
  await generate(parseSplit(process.argv));
}
