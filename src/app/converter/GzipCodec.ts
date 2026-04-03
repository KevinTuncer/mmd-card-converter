import { gunzipSync, gzipSync } from "fflate";

export async function compressGzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "function") {
    const compressedStream = new CompressionStream("gzip");
    const writer = compressedStream.writable.getWriter();
    const reader = compressedStream.readable.getReader();

    const chunks: Uint8Array[] = [];
    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    })();

    await writer.write(toOwnedUint8Array(data) as unknown as BufferSource);
    await writer.close();
    await readPromise;

    return concatChunks(chunks);
  }

  return toOwnedUint8Array(gzipSync(data, { mtime: new Date(0) }));
}

export async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "function") {
    const stream = new DecompressionStream("gzip");
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    const chunks: Uint8Array[] = [];
    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    })();

    await writer.write(toOwnedUint8Array(data) as unknown as BufferSource);
    await writer.close();
    await readPromise;

    const totalLength = chunks.reduce(
      (sum, chunk) => sum + chunk.byteLength,
      0,
    );
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  return toOwnedUint8Array(gunzipSync(data));
}

function toOwnedUint8Array(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(toOwnedArrayBuffer(bytes));
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
