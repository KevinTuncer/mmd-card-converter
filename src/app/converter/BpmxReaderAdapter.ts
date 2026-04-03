import { BpmxReader, type BpmxObject } from "babylon-mmd";

export async function parseBpmx(buffer: ArrayBuffer): Promise<BpmxObject> {
  return BpmxReader.ParseAsync(buffer);
}
