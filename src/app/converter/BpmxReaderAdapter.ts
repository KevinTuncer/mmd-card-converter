import { BpmxReader, type BpmxObject } from "babylon-mmd";

export async function parseBpmx(buffer: ArrayBuffer): Promise<BpmxObject> {
  // babylon-mmd's AlignedDataDeserializer creates Uint16/Uint32/Float32 views
  // over the whole buffer, which requires the byte length to be a multiple of
  // 4. BPMX chunks embedded in card PNGs can have odd lengths (e.g. no
  // padding after the embedded tEXt/zTXt data), so pad with zero bytes here.
  // The reader consumes declared sizes from the header, making trailing
  // padding harmless.
  const padded = buffer.byteLength % 4;
  if (padded !== 0) {
    const aligned = new Uint8Array(buffer.byteLength + (4 - padded));
    aligned.set(new Uint8Array(buffer), 0);
    return BpmxReader.ParseAsync(aligned.buffer);
  }
  return BpmxReader.ParseAsync(buffer);
}
