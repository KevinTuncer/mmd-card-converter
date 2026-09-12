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
 * are marked invalid (highlighted red) and are dropped entirely. moAi
 * entries whose name MISMATCHES their index but matches a morph at another
 * index are rematched to that index (highlighted blue).
 */

export interface CardMetadataEntryState {
  duplicate: boolean;
  invalid: boolean;
  /**
   * Morph index the entry will be remapped to (the model has a morph with
   * this entry's name at that index, but not at the referenced one).
   */
  remappedIndex?: number;
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
 * Computes per-entry duplicate/invalid/rematch state.
 *
 * - rematch (moAi only, with a loaded model): the entry's non-empty name
 *   does not match the model's morph name at the referenced index, but a
 *   morph with that name exists at another index → `remappedIndex` points
 *   there; the entry is valid and will be embedded with that index.
 * - duplicate: more than one entry references the same numeric morph index
 *   — AFTER rematch resolution (two entries remapped onto the same target
 *   are duplicates of each other).
 * - invalid: only evaluated when `morphNames` is non-empty (i.e. a model is
 *   selected): the ref is non-empty but junk/out-of-range, or (when
 *   `getMorphName` is provided) the entry's non-empty name matches neither
 *   the referenced morph nor ANY morph in the model. Empty refs stay
 *   neutral (they are filtered out by the build anyway).
 */
export function computeCardMetadataEntryStates<T>(
  entries: readonly T[],
  morphNames: readonly string[],
  getMorphRef: (entry: T) => string,
  getMorphName?: (entry: T) => string | undefined,
): CardMetadataEntryState[] {
  const canValidate = morphNames.length > 0;

  // Pass 1: parse refs and resolve name-based rematches.
  const refs: Array<number | null> = [];
  const remappedIndexes: Array<number | undefined> = [];
  for (const entry of entries) {
    const ref = parseMorphRef(getMorphRef(entry));
    refs.push(ref);
    let remappedIndex: number | undefined;
    if (canValidate && getMorphName) {
      const name = getMorphName(entry);
      const trimmedName = name?.trim() ?? "";
      if (trimmedName !== "") {
        const nameMatchesRef =
          ref !== null &&
          Number.isInteger(ref) &&
          ref >= 0 &&
          ref < morphNames.length &&
          morphNames[ref] === trimmedName;
        if (!nameMatchesRef) {
          const matchIndex = morphNames.indexOf(trimmedName);
          if (matchIndex >= 0) {
            remappedIndex = matchIndex; // name wins over the index
          }
        }
      }
    }
    remappedIndexes.push(remappedIndex);
  }

  // Pass 2: group duplicates by the EFFECTIVE ref (rematch target wins over
  // the originally referenced index).
  const counts = new Map<number, number>();
  const effectiveRefs: Array<number | null> = [];
  entries.forEach((_entry, index) => {
    const effective =
      remappedIndexes[index] !== undefined
        ? remappedIndexes[index]
        : refs[index];
    effectiveRefs.push(effective);
    if (effective !== null) {
      counts.set(effective, (counts.get(effective) ?? 0) + 1);
    }
  });

  return entries.map((entry, index) => {
    const ref = refs[index];
    const remappedIndex = remappedIndexes[index];
    const effective = effectiveRefs[index];
    const duplicate = effective !== null && (counts.get(effective) ?? 0) > 1;
    let invalid = false;
    if (canValidate && remappedIndex === undefined) {
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
            invalid = true; // name matches no morph in the model
          }
        }
      }
    }
    return remappedIndex === undefined
      ? { duplicate, invalid }
      : { duplicate, invalid: false, remappedIndex };
  });
}

/**
 * True when at least one entry would be removed, replaced or re-indexed when
 * building the card (duplicates, invalid entries or name-based rematches).
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
  ).some(
    (state) =>
      state.duplicate || state.invalid || state.remappedIndex !== undefined,
  );
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
 * morph list is known), de-duplicates entries that reference the same
 * EFFECTIVE morph index (rematch target wins over the original ref),
 * keeping the most recently added entry ("last added wins": highest
 * `sourceSeq`; entries without `sourceSeq` count as manually added and
 * therefore as newest; equal seq keeps the later array position), and
 * applies name-based rematches via `applyRematch` (copy with the new index).
 * `applyRematch` should be passed whenever `getMorphName` is provided.
 * The original relative order of surviving entries is preserved.
 */
export function finalizeCardMetadataEntries<T extends { sourceSeq?: number }>(
  entries: readonly T[],
  morphNames: readonly string[],
  getMorphRef: (entry: T) => string,
  getMorphName?: (entry: T) => string | undefined,
  applyRematch?: (entry: T, remappedIndex: number) => T,
): T[] {
  const states = computeCardMetadataEntryStates(
    entries,
    morphNames,
    getMorphRef,
    getMorphName,
  );
  const effectiveRef = (index: number): number | null =>
    states[index].remappedIndex ?? parseMorphRef(getMorphRef(entries[index]));

  const keptIndexes: number[] = [];
  entries.forEach((_entry, index) => {
    if (!states[index].invalid) keptIndexes.push(index);
  });

  const winnerKeptIndex = new Map<number, number>();
  keptIndexes.forEach((originalIndex, keptIndex) => {
    const ref = effectiveRef(originalIndex);
    if (ref === null) return; // empty/junk refs are not de-duplicated
    const current = winnerKeptIndex.get(ref);
    if (
      current === undefined ||
      !isOlderThan(entries[originalIndex], entries[keptIndexes[current]])
    ) {
      winnerKeptIndex.set(ref, keptIndex);
    }
  });

  return keptIndexes
    .filter((originalIndex, keptIndex) => {
      const ref = effectiveRef(originalIndex);
      if (ref === null) return true;
      return winnerKeptIndex.get(ref) === keptIndex;
    })
    .map((originalIndex) => {
      const remappedIndex = states[originalIndex].remappedIndex;
      if (remappedIndex !== undefined && applyRematch !== undefined) {
        return applyRematch(entries[originalIndex], remappedIndex);
      }
      return entries[originalIndex];
    });
}
