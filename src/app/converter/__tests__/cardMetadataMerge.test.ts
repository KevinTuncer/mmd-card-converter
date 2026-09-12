import { describe, expect, it } from "vitest";
import {
  computeCardMetadataEntryStates,
  finalizeCardMetadataEntries,
  hasCardMetadataFilterableEntries,
} from "@/app/converter/CardMetadataMerge";

interface TestEntry {
  ref: string;
  name?: string;
  sourceSeq?: number;
}

function states(entries: readonly TestEntry[], morphNames: readonly string[]) {
  return computeCardMetadataEntryStates(
    entries,
    morphNames,
    (entry) => entry.ref,
    (entry) => entry.name,
  );
}

function finalize(
  entries: readonly TestEntry[],
  morphNames: readonly string[],
) {
  return finalizeCardMetadataEntries(
    entries,
    morphNames,
    (entry) => entry.ref,
    (entry) => entry.name,
  );
}

function filterable(
  entries: readonly TestEntry[],
  morphNames: readonly string[],
) {
  return hasCardMetadataFilterableEntries(
    entries,
    morphNames,
    (entry) => entry.ref,
    (entry) => entry.name,
  );
}

describe("computeCardMetadataEntryStates", () => {
  it("marks entries referencing the same morph index as duplicates", () => {
    const result = states(
      [
        { ref: "1", sourceSeq: 1 },
        { ref: "01", sourceSeq: 2 },
        { ref: "2", sourceSeq: 3 },
      ],
      [],
    );
    expect(result).toEqual([
      { duplicate: true, invalid: false },
      { duplicate: true, invalid: false },
      { duplicate: false, invalid: false },
    ]);
  });

  it("never marks empty or junk refs as duplicates", () => {
    const result = states([{ ref: "" }, { ref: "" }, { ref: "x" }], []);
    expect(result.every((state) => !state.duplicate)).toBe(true);
  });

  it("does not flag invalid entries when no model morphs are known", () => {
    const result = states([{ ref: "99" }, { ref: "abc" }, { ref: "-1" }], []);
    expect(result.every((state) => !state.invalid)).toBe(true);
  });

  it("flags out-of-range, negative, junk indices as invalid with a model", () => {
    const morphNames = ["まばたき", "笑い", "怒り"];
    const result = states(
      [{ ref: "3" }, { ref: "-1" }, { ref: "abc" }, { ref: "2" }],
      morphNames,
    );
    expect(result.map((state) => state.invalid)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("keeps empty refs neutral even with a model", () => {
    const result = states([{ ref: "" }], ["a"]);
    expect(result).toEqual([{ duplicate: false, invalid: false }]);
  });

  it("flags moAi name mismatches but ignores empty names", () => {
    const morphNames = ["smile", "angry"];
    const result = states(
      [
        { ref: "0", name: "smile" },
        { ref: "1", name: "wrong" },
        { ref: "1", name: "" },
      ],
      morphNames,
    );
    expect(result.map((state) => state.invalid)).toEqual([false, true, false]);
  });

  it("can flag an entry as duplicate and invalid at once", () => {
    const morphNames = ["smile"];
    const result = states(
      [
        { ref: "5", sourceSeq: 1 },
        { ref: "5", sourceSeq: 2 },
      ],
      morphNames,
    );
    expect(result).toEqual([
      { duplicate: true, invalid: true },
      { duplicate: true, invalid: true },
    ]);
  });
});

describe("finalizeCardMetadataEntries", () => {
  it("keeps the most recently added entry per morph index", () => {
    const result = finalize(
      [
        { ref: "0", name: "old", sourceSeq: 1 },
        { ref: "1", name: "keep", sourceSeq: 1 },
        { ref: "0", name: "new", sourceSeq: 2 },
      ],
      [],
    );
    expect(result).toEqual([
      { ref: "1", name: "keep", sourceSeq: 1 },
      { ref: "0", name: "new", sourceSeq: 2 },
    ]);
  });

  it("treats entries without sourceSeq (manually added) as newest", () => {
    const result = finalize(
      [
        { ref: "0", name: "file", sourceSeq: 7 },
        { ref: "0", name: "manual" },
      ],
      [],
    );
    expect(result).toEqual([{ ref: "0", name: "manual" }]);
  });

  it("keeps the later array position on equal sourceSeq", () => {
    const result = finalize(
      [
        { ref: "3", name: "first", sourceSeq: 5 },
        { ref: "3", name: "second", sourceSeq: 5 },
      ],
      [],
    );
    expect(result).toEqual([{ ref: "3", name: "second", sourceSeq: 5 }]);
  });

  it("drops invalid entries when a model is selected", () => {
    const morphNames = ["smile", "angry"];
    const result = finalize(
      [
        { ref: "0", name: "smile", sourceSeq: 1 },
        { ref: "9", name: "gone", sourceSeq: 1 },
        { ref: "1", name: "mismatch", sourceSeq: 1 },
      ],
      morphNames,
    );
    expect(result).toEqual([{ ref: "0", name: "smile", sourceSeq: 1 }]);
  });

  it("drops duplicates first and then picks the newest valid entry", () => {
    const morphNames = ["smile"];
    const result = finalize(
      [
        { ref: "0", name: "smile", sourceSeq: 1 },
        { ref: "0", name: "smile", sourceSeq: 2 },
        { ref: "0", name: "wrong", sourceSeq: 3 },
      ],
      morphNames,
    );
    // Entry with seq 3 is invalid by name mismatch, so seq 2 wins.
    expect(result).toEqual([{ ref: "0", name: "smile", sourceSeq: 2 }]);
  });

  it("does not deduplicate empty or junk refs", () => {
    const result = finalize(
      [
        { ref: "", name: "" },
        { ref: "", name: "" },
        { ref: "x", name: "" },
      ],
      [],
    );
    expect(result).toHaveLength(3);
  });

  it("keeps everything when refs are unique and valid", () => {
    const morphNames = ["a", "b", "c"];
    const entries: TestEntry[] = [
      { ref: "0", name: "a" },
      { ref: "1", name: "b" },
      { ref: "2", name: "c" },
    ];
    expect(finalize(entries, morphNames)).toEqual(entries);
    expect(filterable(entries, morphNames)).toBe(false);
  });
});

describe("hasCardMetadataFilterableEntries", () => {
  it("is true for duplicates", () => {
    expect(
      filterable(
        [
          { ref: "1", sourceSeq: 1 },
          { ref: "1", sourceSeq: 2 },
        ],
        [],
      ),
    ).toBe(true);
  });

  it("is true for invalid entries with a model", () => {
    expect(filterable([{ ref: "42" }], ["a"])).toBe(true);
  });

  it("is false for clean entries", () => {
    expect(
      filterable(
        [
          { ref: "0", name: "a" },
          { ref: "1", name: "b" },
        ],
        ["a", "b"],
      ),
    ).toBe(false);
  });
});
