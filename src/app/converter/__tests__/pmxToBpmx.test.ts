// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  convertPmxToBpmx,
  ensurePmxLoaderRegistered,
} from "@/app/converter/PmxToBpmxConverter";
import { loadPmxFolder } from "./helpers";

ensurePmxLoaderRegistered();

describe("convertPmxToBpmx (PMX → BPMX)", () => {
  it("converts TestModelAsPmx/Ai.pmx without throwing", async () => {
    const { pmxFile, allFiles } = loadPmxFolder(
      "public/example/TestModelAsPmx",
    );
    const bpmxBuffer = await convertPmxToBpmx(pmxFile, allFiles);

    expect(bpmxBuffer).toBeInstanceOf(ArrayBuffer);
    expect(bpmxBuffer.byteLength).toBeGreaterThan(0);
  });

  it("converts TestModel2AsPmx/ローザスタウト.pmx without throwing", async () => {
    const { pmxFile, allFiles } = loadPmxFolder(
      "public/example/TestModel2AsPmx",
    );
    const bpmxBuffer = await convertPmxToBpmx(pmxFile, allFiles);

    expect(bpmxBuffer).toBeInstanceOf(ArrayBuffer);
    expect(bpmxBuffer.byteLength).toBeGreaterThan(0);
  });
});
