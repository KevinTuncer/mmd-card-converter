import { encodeToAvifViaJsquash } from "./ForceAvifEncoder";

interface ForceAvifWorkerRequest {
  id: number;
  file: File;
  quality: number;
}

addEventListener(
  "message",
  async (event: MessageEvent<ForceAvifWorkerRequest>) => {
    const { id, file, quality } = event.data;

    try {
      const blob = await encodeToAvifViaJsquash(file, quality);
      const buffer = await blob.arrayBuffer();
      postMessage({ id, buffer, type: blob.type }, { transfer: [buffer] });
    } catch (error) {
      postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
