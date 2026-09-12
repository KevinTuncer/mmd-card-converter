/**
 * Pure helpers for merging, validating and finalizing duplicated card
 * metadata entries (metadata.fBtn.json / metadata.moAi.json) in the
 * "Create card" flow.
 *
 * Entries reference a model morph by its numeric index. When the same morph
 * is referenced by more than one entry, all affected entries are marked as
 * duplicates (highlighted yellow in the editor); when the card is built, the
 * most recently added entry wins. When the selected model's morph list is
 * known, entries whose index does not exist in the model — or (moAi only)
 * whose stored name does not match the model's morph name at that index —
 * are marked invalid (highlighted red) and are dropped entirely.
 */

export interface CardMetadataEntryState {
  duplicate: boolean;
  invalid: boolean;
}

/**
 * Parses a morph reference into a numeric key.
 * Returns null for empty or non-numeric refs (those are not groupable).
 */
function parseMorphRef(morphRef: string): number | null {
  const trimmed = morphRef.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Computes per-entry duplicate/invalid state.
 *
 * - duplicate: more than one entry references the same numeric morph index
 *   (only possible while the ref is non-empty and numeric).
 * - invalid: only evaluated when `morphNames` is non-empty (i.e. a model is
 *   selected): the ref is non-empty but junk/out-of-range, or (when
 *   `getMorphName` is provided) the entry's non-empty name does not match
 *   the model's morph name at the referenced index. Empty refs stay neutral
 *   (they are filtered out by the build anyway).
 */
export function computeCardMetadataEntryStates<T>(
  entries: readonly T[],
  morphNames: readonly string[],
  getMorphRef: (entry: T) => string,
  getMorphName?: (entry: T) => string | undefined,
): CardMetadataEntryState[] {
  const counts = new Map<number, number>();
  const refs: Array<number | null> = [];
  for (const entry of entries) {
    const ref = parseMorphRef(getMorphRef(entry));
    refs.push(ref);
    if (ref !== null) {
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
  }

  const canValidate = morphNames.length > 0;
  return entries.map((entry, index) => {
    const ref = refs[index];
    const duplicate = ref !== null && (counts.get(ref) ?? 0) > 1;
    let invalid = false;
    if (canValidate) {
      const raw = getMorphRef(entry).trim();
      if (raw !== "") {
        if (ref === null) {
          invalid = true; // junk like "abc"
        } else if (
          !Number.isInteger(ref) ||
          ref < 0 ||
          ref >= morphNames.length
        ) {
          invalid = true; // index does not exist in the model
        } else if (getMorphName) {
          const name = getMorphName(entry);
          if (
            name !== undefined &&
            name.trim() !== "" &&
            name.trim() !== morphNames[ref]
          ) {
            invalid = true; // name mismatch with the model
          }
        }
      }
    }
    return { duplicate, invalid };
  });
}

/**
 * True when at least one entry would be removed or replaced when building
 * the card (duplicates or invalid entries).
 */
export function hasCardMetadataFilterableEntries<T>(
  entries: readonly T[],
  morphNames: readonly string[],
  getMorphRef: (entry: T) => string,
  getMorphName?: (entry: T) => string | undefined,
): boolean {
  return computeCardMetadataEntryStates(
    entries,
    morphNames,
    getMorphRef,
    getMorphName,
  ).some((state) => state.duplicate || state.invalid);
}

function isOlderThan(
  candidate: { sourceSeq?: number },
  current: { sourceSeq?: number },
): boolean {
  const candidateSeq = candidate.sourceSeq ?? Number.POSITIVE_INFINITY;
  const currentSeq = current.sourceSeq ?? Number.POSITIVE_INFINITY;
  return candidateSeq < currentSeq;
}

/**
 * Finalizes entries for embedding: drops invalid entries (when the model's
 * morph list is known) and de-duplicates entries that reference the same
 * morph index, keeping the most recently added entry ("last added wins":
 * highest `sourceSeq`; entries without `sourceSeq` count as manually added
 * and therefore as newest; equal seq keeps the later array position).
 * The original relative order of surviving entries is preserved.
 */
export function finalizeCardMetadataEntries<T extends { sourceSeq?: number }>(
  entries: readonly T[],
  morphNames: readonly string[],
  getMorphRef: (entry: T) => string,
  getMorphName?: (entry: T) => string | undefined,
): T[] {
  const states = computeCardMetadataEntryStates(
    entries,
    morphNames,
    getMorphRef,
    getMorphName,
  );
  const kept = entries.filter((_entry, index) => !states[index].invalid);

  const winnerIndex = new Map<number, number>();
  kept.forEach((entry, keptIndex) => {
    const ref = parseMorphRef(getMorphRef(entry));
    if (ref === null) return; // empty/junk refs are not de-duplicated
    const current = winnerIndex.get(ref);
    if (current === undefined || !isOlderThan(entry, kept[current])) {
      winnerIndex.set(ref, keptIndex);
    }
  });

  return kept.filter((_entry, keptIndex) => {
    const ref = parseMorphRef(getMorphRef(kept[keptIndex]));
    if (ref === null) return true;
    return winnerIndex.get(ref) === keptIndex;
  });
}
