/**
 * Deterministic pseudo random source.
 *
 * Math.random is banned in this directory. The corpus must be byte identical for any
 * reviewer who clones the repository and regenerates it, and a corpus that cannot be
 * regenerated cannot be used to verify a published number.
 *
 * xmur3 seeds sfc32. Both are small, well understood, and produce the same stream on
 * every platform because every operation is a 32 bit integer operation.
 */

function xmur3(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export class Rng {
  readonly seed: string;
  #next: () => number;

  constructor(seed: string) {
    this.seed = seed;
    const h = xmur3(seed);
    this.#next = sfc32(h(), h(), h(), h());
    // discard the first few, a common precaution with sfc32
    for (let i = 0; i < 12; i++) this.#next();
  }

  /** A fresh independent stream, so adding a generation step does not shift later draws. */
  fork(label: string): Rng {
    return new Rng(`${this.seed}::${label}`);
  }

  /** Float in [0, 1). */
  float(): number {
    return this.#next();
  }

  /** Integer in [min, max], inclusive both ends. */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`Rng.int: max ${max} below min ${min}`);
    return min + Math.floor(this.#next() * (max - min + 1));
  }

  /** True with probability p. */
  bool(p: number): boolean {
    return this.#next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Weighted choice. Weights need not sum to one. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((acc, [, w]) => acc + w, 0);
    if (total <= 0) throw new Error("Rng.weighted: weights sum to zero or less");
    let roll = this.#next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1]?.[0] as T;
  }

  /** Fisher Yates, returns a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  /** Draw n distinct members. Throws rather than silently returning fewer. */
  sample<T>(items: readonly T[], n: number): T[] {
    if (n > items.length) {
      throw new Error(`Rng.sample: asked for ${n} of ${items.length}`);
    }
    return this.shuffle(items).slice(0, n);
  }

  /**
   * Roughly normal via the sum of three uniforms, clamped. Used for realistic order
   * value spread without importing a statistics package.
   */
  aboutNormal(mean: number, spread: number): number {
    const u = (this.#next() + this.#next() + this.#next()) / 3;
    return mean + (u - 0.5) * 2 * spread;
  }

  /** Deterministic base62 token, for identifiers shaped like the real ones. */
  token(length: number): string {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let out = "";
    for (let i = 0; i < length; i++) {
      out += alphabet[this.int(0, alphabet.length - 1)] as string;
    }
    return out;
  }
}
