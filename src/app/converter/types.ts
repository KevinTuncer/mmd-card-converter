import type { PmxObject } from "babylon-mmd";

export type ConverterWarningLevel = "info" | "warn";

export interface ConverterWarning {
  level: ConverterWarningLevel;
  message: string;
}

export interface FidelityReport {
  sourceFormat: "BPMX";
  targetFormat: "PMX";
  totals: {
    vertices: number;
    indices: number;
    textures: number;
    materials: number;
    bones: number;
    morphs: number;
    displayFrames: number;
    rigidBodies: number;
    joints: number;
  };
  warnings: ConverterWarning[];
}

export interface ConversionResult {
  pmx: PmxObject;
  pmxBuffer: ArrayBuffer;
  zipBuffer: ArrayBuffer;
  report: FidelityReport;
}

export interface ConvertOptions {
  encoding?: PmxObject.Header.Encoding;
  restoreOriginalImageFormats?: boolean;
}
