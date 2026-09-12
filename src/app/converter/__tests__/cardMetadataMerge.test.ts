import { describe, expect, it } from "vitest";
import {
  buildFastButtonEntries,
  computeCardMetadataEntryStates,
  createEmptyFastButtonDraft,
  finalizeCardMetadataEntries,
  hasCardMetadataFilterableEntries,
  parseFastButtonRows,
  type FastButtonDraft,
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

function finalizeWithRematch(
  entries: readonly TestEntry[],
  morphNames: readonly string[],
) {
  return finalizeCardMetadataEntries(
    entries,
    morphNames,
    (entry) => entry.ref,
    (entry) => entry.name,
    (entry, remappedIndex) => ({ ...entry, ref: String(remappedIndex) }),
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

  it("is true for rematch-only entries", () => {
    expect(filterable([{ ref: "0", name: "b" }], ["a", "b"])).toBe(true);
  });
});

describe("name rematch (blue)", () => {
  it("rematches entries whose name exists at another index", () => {
    const result = states([{ ref: "0", name: "angry" }], ["smile", "angry"]);
    expect(result).toEqual([
      { duplicate: false, invalid: false, remappedIndex: 1 },
    ]);
  });

  it("rematches out-of-range indexes when the name exists", () => {
    const result = states([{ ref: "999", name: "smile" }], ["smile", "x"]);
    expect(result[0].remappedIndex).toBe(0);
    expect(result[0].invalid).toBe(false);
  });

  it("rematches junk refs when the name exists", () => {
    const result = states([{ ref: "abc", name: "x" }], ["smile", "x"]);
    expect(result[0].remappedIndex).toBe(1);
    expect(result[0].invalid).toBe(false);
  });

  it("stays red when no morph with that name exists", () => {
    const result = states([{ ref: "0", name: "nope" }], ["smile", "angry"]);
    expect(result[0].invalid).toBe(true);
    expect(result[0].remappedIndex).toBeUndefined();
  });

  it("does not rematch without a model or without a name", () => {
    expect(
      states([{ ref: "0", name: "angry" }], [])[0].remappedIndex,
    ).toBeUndefined();
    expect(
      states([{ ref: "0", name: "" }], ["smile"])[0].remappedIndex,
    ).toBeUndefined();
  });

  it("groups duplicates by the rematch target", () => {
    const result = states(
      [
        { ref: "0", name: "angry", sourceSeq: 1 },
        { ref: "1", name: "angry", sourceSeq: 2 },
      ],
      ["smile", "angry"],
    );
    expect(result.every((state) => state.duplicate)).toBe(true);
    expect(result[0].remappedIndex).toBe(1);
    expect(result[1].remappedIndex).toBeUndefined();
  });

  it("embeds the remapped index via applyRematch", () => {
    const result = finalizeWithRematch(
      [
        { ref: "0", name: "angry", sourceSeq: 1 },
        { ref: "5", name: "smile", sourceSeq: 1 },
      ],
      ["smile", "angry"],
    );
    expect(result).toEqual([
      { ref: "1", name: "angry", sourceSeq: 1 },
      { ref: "0", name: "smile", sourceSeq: 1 },
    ]);
  });

  it("dedups remapped entries on the target index (last added wins)", () => {
    const result = finalizeWithRematch(
      [
        { ref: "9", name: "angry", sourceSeq: 1 },
        { ref: "1", name: "angry", sourceSeq: 2 },
      ],
      ["smile", "angry"],
    );
    expect(result).toEqual([{ ref: "1", name: "angry", sourceSeq: 2 }]);
  });
});

describe("parseFastButtonRows / buildFastButtonEntries (fbTn payload)", () => {
  it("parses default weights, visible flags and unknown fields", () => {
    const drafts = parseFastButtonRows([
      { name: "Smile", action: "morph", morph: 2 },
      {
        name: "Default Only",
        action: "morph",
        morph: 3,
        default: 0.5,
        visible: false,
      },
      { name: "Extra", action: "morph", morph: 4, custom: "keep" },
      { name: "String Default", action: "morph", morph: 5, default: "0.25" },
    ]);

    expect(drafts[0]).toEqual({
      name: "Smile",
      action: "morph",
      morph: "2",
      default: "",
      visible: true,
      raw: { name: "Smile", action: "morph", morph: 2 },
    });
    expect(drafts[1].default).toBe("0.5");
    expect(drafts[1].visible).toBe(false);
    expect(drafts[2].raw).toEqual({
      name: "Extra",
      action: "morph",
      morph: 4,
      custom: "keep",
    });
    expect(drafts[3].default).toBe("0.25");
  });

  it("returns an empty array for non-array payloads", () => {
    expect(parseFastButtonRows(null)).toEqual([]);
    expect(parseFastButtonRows({ name: "x" })).toEqual([]);
  });

  it("builds entries preserving unknown fields and original field order", () => {
    const [draft] = parseFastButtonRows([
      { name: "Smile", action: "morph", morph: 2, custom: "keep" },
    ]);
    const [entry] = buildFastButtonEntries([
      { ...draft, default: "0.5", visible: false },
    ]);

    expect(entry).toEqual({
      name: "Smile",
      action: "morph",
      morph: 2,
      custom: "keep",
      default: 0.5,
      visible: false,
    });
    expect(Object.keys(entry)).toEqual([
      "name",
      "action",
      "morph",
      "custom",
      "default",
      "visible",
    ]);
  });

  it("emits default only for finite values > 0 and visible only as false", () => {
    const buildOne = (defaultText: string, visible: boolean) =>
      buildFastButtonEntries([
        {
          ...createEmptyFastButtonDraft(),
          name: "A",
          morph: "1",
          default: defaultText,
          visible,
        },
      ])[0];

    expect(buildOne("0.5", true)).toEqual({
      name: "A",
      action: "morph",
      morph: 1,
      default: 0.5,
    });
    for (const invalid of ["0", "", "abc", "-1"]) {
      expect(buildOne(invalid, true)).not.toHaveProperty("default");
    }
    expect(buildOne("0.5", false).visible).toBe(false);
    expect(buildOne("0.5", true)).not.toHaveProperty("visible");
  });

  it("removes visible:true and cleared defaults from raw entries", () => {
    const [draft] = parseFastButtonRows([
      {
        name: "Legacy",
        action: "morph",
        morph: 1,
        default: 0.75,
        visible: true,
      },
    ]);
    const [entry] = buildFastButtonEntries([{ ...draft, default: "" }]);

    expect(entry).toEqual({ name: "Legacy", action: "morph", morph: 1 });
  });

  it("drops rows with an empty name and a non-numeric morph ref", () => {
    const entries = buildFastButtonEntries([
      { ...createEmptyFastButtonDraft(), name: "", morph: "abc" },
      { ...createEmptyFastButtonDraft(), name: "Keep", morph: "3" },
    ]);
    expect(entries).toEqual([{ name: "Keep", action: "morph", morph: 3 }]);
  });

  it("keeps default/visible/raw of the dedup winner (last added wins)", () => {
    const drafts: FastButtonDraft[] = [
      {
        name: "A",
        action: "morph",
        morph: "1",
        default: "",
        visible: true,
        raw: { name: "A", action: "morph", morph: 1 },
        sourceSeq: 1,
      },
      {
        name: "A2",
        action: "morph",
        morph: "1",
        default: "0.75",
        visible: false,
        raw: { name: "A2", action: "morph", morph: 1 },
        sourceSeq: 2,
      },
    ];
    const finalized = finalizeCardMetadataEntries(
      drafts,
      [],
      (draft) => draft.morph,
    );
    expect(finalized).toHaveLength(1);
    expect(buildFastButtonEntries(finalized)).toEqual([
      { name: "A2", action: "morph", morph: 1, default: 0.75, visible: false },
    ]);
  });
});
