// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  buildPreparedImageCacheKey,
  collectCachedPreparedImages,
  mergeCompressionResults,
  type PreparedImageParams,
  PreparedImageCache,
  partitionForCachedCompression,
} from "@/app/converter/PreparedImageCache";

function makeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name);
}

function withRelativePath(file: File, relativePath: string): File {
  Object.defineProperty(file, "webkitRelativePath", {
    value: relativePath,
    configurable: true,
  });
  return file;
}

const LOSSLESS: PreparedImageParams = {
  compressionMode: "lossless",
  forceAvif: false,
  isLossyTarget: false,
};

const LOSSY_TARGET: PreparedImageParams = {
  compressionMode: "lossy",
  forceAvif: true,
  isLossyTarget: true,
};

describe("buildPreparedImageCacheKey", () => {
  it("prefers webkitRelativePath over the plain file name", () => {
    const a = buildPreparedImageCacheKey(
      withRelativePath(makeFile("tex.png", 10), "model/TEX/tex.png"),
      LOSSLESS,
    );
    const b = buildPreparedImageCacheKey(
      makeFile("model/TEX/tex.png", 10),
      LOSSLESS,
    );
    expect(a).toBe(b);
  });

  it("differs when size or any conversion parameter differs", () => {
    const base = makeFile("tex.png", 10);
    const reference = buildPreparedImageCacheKey(base, LOSSLESS);

    expect(
      buildPreparedImageCacheKey(makeFile("tex.png", 11), LOSSLESS),
    ).not.toBe(reference);
    expect(
      buildPreparedImageCacheKey(base, {
        ...LOSSLESS,
        compressionMode: "lossy",
      }),
    ).not.toBe(reference);
    expect(
      buildPreparedImageCacheKey(base, { ...LOSSLESS, forceAvif: true }),
    ).not.toBe(reference);
    expect(
      buildPreparedImageCacheKey(base, { ...LOSSLESS, isLossyTarget: true }),
    ).not.toBe(reference);
    expect(buildPreparedImageCacheKey(base, LOSSY_TARGET)).not.toBe(reference);
  });

  it("normalizes backslash paths", () => {
    const a = buildPreparedImageCacheKey(
      withRelativePath(makeFile("tex.png", 10), "model\\TEX\\tex.png"),
      LOSSLESS,
    );
    const b = buildPreparedImageCacheKey(
      withRelativePath(makeFile("tex.png", 10), "model/TEX/tex.png"),
      LOSSLESS,
    );
    expect(a).toBe(b);
  });
});

describe("PreparedImageCache", () => {
  it("stores and retrieves results per file + parameter set", () => {
    const cache = new PreparedImageCache();
    const source = makeFile("tex.png", 10);
    const losslessResult = makeFile("lossless.avif", 5);
    const lossyResult = makeFile("lossy.avif", 4);

    cache.set(source, LOSSLESS, losslessResult);
    cache.set(source, LOSSY_TARGET, lossyResult);

    expect(cache.get(source, LOSSLESS)).toBe(losslessResult);
    expect(cache.get(source, LOSSY_TARGET)).toBe(lossyResult);
    expect(cache.get(source, { ...LOSSLESS, forceAvif: true })).toBeUndefined();
    expect(cache.get(makeFile("tex.png", 10), LOSSLESS)).toBe(losslessResult);
    expect(cache.get(makeFile("other.png", 10), LOSSLESS)).toBeUndefined();
  });

  it("evicts the least recently used entries beyond the cap", () => {
    const cache = new PreparedImageCache(2);
    const a = makeFile("a.png", 1);
    const b = makeFile("b.png", 1);
    const c = makeFile("c.png", 1);

    cache.set(a, LOSSLESS, makeFile("a.avif", 1));
    cache.set(b, LOSSLESS, makeFile("b.avif", 1));
    // Touch a so b becomes the least recently used entry.
    expect(cache.get(a, LOSSLESS)).toBeDefined();
    cache.set(c, LOSSLESS, makeFile("c.avif", 1));

    expect(cache.get(a, LOSSLESS)).toBeDefined();
    expect(cache.get(b, LOSSLESS)).toBeUndefined();
    expect(cache.get(c, LOSSLESS)).toBeDefined();
  });

  it("evictFile removes every variant of the file but keeps others", () => {
    const cache = new PreparedImageCache();
    const tex = withRelativePath(makeFile("tex.png", 10), "model/tex.png");
    const other = makeFile("other.png", 10);
    cache.set(tex, LOSSLESS, makeFile("1.avif", 1));
    cache.set(tex, LOSSY_TARGET, makeFile("2.avif", 1));
    cache.set(other, LOSSLESS, makeFile("3.avif", 1));

    cache.evictFile("model/tex.png");

    expect(cache.get(tex, LOSSLESS)).toBeUndefined();
    expect(cache.get(tex, LOSSY_TARGET)).toBeUndefined();
    expect(cache.get(other, LOSSLESS)).toBeDefined();
  });

  it("retainFileKeys drops entries whose file key is no longer staged", () => {
    const cache = new PreparedImageCache();
    const kept = makeFile("kept.png", 1);
    const dropped = withRelativePath(makeFile("d.png", 1), "old/d.png");
    cache.set(kept, LOSSLESS, makeFile("k.avif", 1));
    cache.set(dropped, LOSSLESS, makeFile("d.avif", 1));

    cache.retainFileKeys(new Set(["kept.png"]));

    expect(cache.get(kept, LOSSLESS)).toBeDefined();
    expect(cache.get(dropped, LOSSLESS)).toBeUndefined();
  });
});

describe("collectCachedPreparedImages", () => {
  it("collects only hits and skips files without resolvable params", () => {
    const cache = new PreparedImageCache();
    const hit = makeFile("hit.png", 1);
    const miss = makeFile("miss.png", 1);
    const skipped = makeFile("model.pmx", 1);
    const result = makeFile("hit.avif", 1);
    cache.set(hit, LOSSLESS, result);

    const cached = collectCachedPreparedImages(
      [hit, miss, skipped],
      (file) => (file.name.endsWith(".png") ? LOSSLESS : null),
      cache,
    );

    expect(cached.size).toBe(1);
    expect(cached.get(hit)).toBe(result);
    expect(cached.has(miss)).toBe(false);
    expect(cached.has(skipped)).toBe(false);
  });
});

describe("partitionForCachedCompression / mergeCompressionResults", () => {
  const files = [
    makeFile("model.pmx", 1),
    makeFile("texA.png", 1),
    makeFile("notes.txt", 1),
    makeFile("texB.png", 1),
  ];

  it("splits cached hits from files to process and restores the original order", () => {
    const cachedResultA = makeFile("texA.avif", 1);
    const partition = partitionForCachedCompression(files, (file) =>
      file.name === "texA.png" ? cachedResultA : undefined,
    );

    expect(partition.cachedEntries).toEqual([
      { index: 1, result: cachedResultA },
    ]);
    expect(partition.filesToProcess).toEqual([files[0], files[2], files[3]]);

    const processed = [
      makeFile("pmx.pass", 1),
      makeFile("txt.pass", 1),
      makeFile("texB.avif", 1),
    ];
    const merged = mergeCompressionResults(partition, processed);
    expect(merged).toEqual([
      processed[0],
      cachedResultA,
      processed[1],
      processed[2],
    ]);
  });

  it("supports the full-hit fast path", () => {
    const cachedResults = files.map((file) => makeFile(`${file.name}.avif`, 1));
    const partition = partitionForCachedCompression(
      files,
      (file) => cachedResults[files.indexOf(file)],
    );
    expect(partition.filesToProcess).toEqual([]);
    expect(mergeCompressionResults(partition, [])).toEqual(cachedResults);
  });

  it("rejects a processed result count that does not match the partition", () => {
    const partition = partitionForCachedCompression(files, () => undefined);
    expect(() => mergeCompressionResults(partition, [])).toThrow();
  });
});
