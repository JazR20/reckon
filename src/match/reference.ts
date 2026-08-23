/**
 * Pulling a bank reference out of a narration string.
 *
 * This is the one place in the deterministic tiers where the input is genuinely
 * unstructured. A narration is free text assembled by whichever rail carried the money,
 * and the reference sits in a different position, with different delimiters, in each.
 *
 * The extraction here is deliberately DUMB and deliberately HIGH RECALL. It pulls every
 * token that could be a reference and hands back all of them. It does not try to pick.
 *
 * Choosing is a separate step, and it is done by intersecting with the set of settlement
 * references actually in hand, because that is real evidence. Picking on shape alone would
 * be a guess dressed up as a parse: a narration commonly carries two or three tokens of
 * identical shape, and the generator's `decoy_tokens` damage exists precisely to punish a
 * matcher that grabs the first one.
 *
 * Where this leaves a residue with nothing decidable, that residue is what tier 4 is for.
 */

/**
 * Alphanumeric runs long enough to be a reference and mixed enough not to be a plain
 * number or a plain word.
 *
 * Length floor of 12 excludes IFSC codes, which are 11. Requiring at least one letter and
 * at least one digit excludes account numbers and excludes words like SETTLEMENT.
 */
const TOKEN = /[A-Za-z0-9]{12,24}/g;

export function extractReferenceCandidates(narration: string, refNoColumn: string): string[] {
  const found = new Set<string>();

  // the dedicated column is the strongest signal when it is populated at all
  const declared = refNoColumn.trim();
  if (declared !== "") found.add(declared);

  for (const match of narration.matchAll(TOKEN)) {
    const token = match[0];
    if (!/[A-Za-z]/.test(token)) continue;
    if (!/[0-9]/.test(token)) continue;
    found.add(token);
  }

  return [...found];
}

export interface ReferenceResolution {
  readonly kind: "unique" | "ambiguous" | "none";
  readonly reference: string | null;
  readonly candidatesExtracted: number;
  readonly candidatesKnown: readonly string[];
}

/**
 * Resolve extracted tokens against references we actually hold.
 *
 * `unique` means exactly one extracted token is a reference we have a settlement for.
 * That is evidence, not a shape heuristic, and it survives decoy tokens.
 *
 * `none` covers two very different situations that a later tier must tell apart: the
 * reference was destroyed by a truncating export, or the reference is intact and the
 * settlement it points at is simply not in our export window. Both leave the amount and
 * the date as the only remaining evidence.
 */
export function resolveReference(
  narration: string,
  refNoColumn: string,
  known: ReadonlySet<string>,
): ReferenceResolution {
  const candidates = extractReferenceCandidates(narration, refNoColumn);
  const matches = candidates.filter((token) => known.has(token));
  if (matches.length === 1) {
    return {
      kind: "unique",
      reference: matches[0] as string,
      candidatesExtracted: candidates.length,
      candidatesKnown: matches,
    };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      reference: null,
      candidatesExtracted: candidates.length,
      candidatesKnown: matches,
    };
  }
  return {
    kind: "none",
    reference: null,
    candidatesExtracted: candidates.length,
    candidatesKnown: [],
  };
}
