// In-memory cache for prepared (AVIF-compressed) texture files.
//
// Results are keyed by BOTH the source file identity (path + size) and the
// conversion parameters that influence the encoded output (compression mode,
// force-AVIF flag, per-file lossy selection). Different parameter sets
// therefore coexist in the cache, and a cached entry is only ever reused when
// every parameter that could change the result is unchanged.
//
// The cache holds plain `File` objects produced by `compressImagesToAvif`;
// those keep their `webkitRelativePath`, so cached results can be fed back
// into downstream conversion steps (PMX→BPMX embedding) unchanged.

export type PreparedCompressionMode = "lossless" | "lossy" | "raw";

export interface PreparedImageParams {
  compressionMode: PreparedCompressionMode;
  forceAvif: boolean;
  isLossyTarget: boolean;
}

const KEY_SEPARATOR = "\u0000";

const DEFAULT_MAX_ENTRIES = 64;

export function getPreparedImageFileKey(file: File): string {
  return (
    (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
    file.name
  ).replace(/\\/g, "/");
}

export function buildPreparedImageCacheKey(
  file: File,
  params: PreparedImageParams,
): string {
  return [
    getPreparedImageFileKey(file),
    String(file.size),
    params.compressionMode,
    params.forceAvif ? "1" : "0",
    params.isLossyTarget ? "1" : "0",
  ].join(KEY_SEPARATOR);
}

/**
 * Cache for prepared image files. Bounded via least-recently-used eviction so
 * long editing sessions cannot grow memory without limit.
 */
export class PreparedImageCache {
  private readonly entries = new Map<string, File>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(file: File, params: PreparedImageParams): File | undefined {
    const key = buildPreparedImageCacheKey(file, params);
    const value = this.entries.get(key);
    if (value !== undefined) {
      // Refresh recency (Map iteration order) for LRU eviction.
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(file: File, params: PreparedImageParams, result: File): void {
    this.entries.set(buildPreparedImageCacheKey(file, params), result);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Removes every cache entry recorded for the given file key (all parameter variants and sizes). */
  evictFile(fileKey: string): void {
    const prefix = `${fileKey}${KEY_SEPARATOR}`;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Removes every cache entry whose file key is NOT contained in `keptKeys`. */
  retainFileKeys(keptKeys: ReadonlySet<string>): void {
    for (const key of Array.from(this.entries.keys())) {
      const fileKey = key.slice(0, key.indexOf(KEY_SEPARATOR));
      if (!keptKeys.has(fileKey)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Resolves the cache parameters for a file, or `null` when the file must never be cached (non-image files). */
export type PreparedImageParamsResolver = (
  file: File,
) => PreparedImageParams | null;

/** Builds a source→result map of all cache hits for the given files. */
export function collectCachedPreparedImages(
  files: readonly File[],
  resolveParams: PreparedImageParamsResolver,
  cache: PreparedImageCache,
): Map<File, File> {
  const cached = new Map<File, File>();
  for (const file of files) {
    const params = resolveParams(file);
    if (params === null) continue;
    const result = cache.get(file, params);
    if (result !== undefined) cached.set(file, result);
  }
  return cached;
}

export interface PreparedCachedEntry {
  /** Index of the source file within the original files array. */
  index: number;
  result: File;
}

export interface PreparedCompressionPartition {
  cachedEntries: PreparedCachedEntry[];
  /** Files that still need processing, in original order. */
  filesToProcess: File[];
}

/**
 * Splits `files` into entries already covered by the cache and files that
 * still need to run through compression. Files without a cached result
 * (including non-image pass-throughs) end up in `filesToProcess`.
 */
export function partitionForCachedCompression(
  files: readonly File[],
  getCachedResult: (file: File) => File | undefined,
): PreparedCompressionPartition {
  const cachedEntries: PreparedCachedEntry[] = [];
  const filesToProcess: File[] = [];
  files.forEach((file, index) => {
    const cached = getCachedResult(file);
    if (cached !== undefined) {
      cachedEntries.push({ index, result: cached });
    } else {
      filesToProcess.push(file);
    }
  });
  return { cachedEntries, filesToProcess };
}

/**
 * Merges cached entries and freshly processed results back into a single
 * array that is index-aligned with the original files array.
 */
export function mergeCompressionResults(
  partition: PreparedCompressionPartition,
  processedResults: readonly File[],
): File[] {
  if (processedResults.length !== partition.filesToProcess.length) {
    throw new Error(
      `mergeCompressionResults: expected ${partition.filesToProcess.length} processed results, got ${processedResults.length}`,
    );
  }
  const results: File[] = new Array<File>(
    partition.cachedEntries.length + processedResults.length,
  );
  for (const entry of partition.cachedEntries) {
    results[entry.index] = entry.result;
  }
  let processedIndex = 0;
  const cachedIndices = new Set(
    partition.cachedEntries.map((entry) => entry.index),
  );
  for (let index = 0; index < results.length; index++) {
    if (!cachedIndices.has(index)) {
      results[index] = processedResults[processedIndex++];
    }
  }
  return results;
}
