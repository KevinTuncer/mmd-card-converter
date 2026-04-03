// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mediabunnyMocks = vi.hoisted(() => ({
  canEncodeAudio: vi.fn(),
  conversionInit: vi.fn(),
  Input: vi.fn(),
  Output: vi.fn(),
  BlobSource: vi.fn(),
  BufferTarget: vi.fn(),
  WebMOutputFormat: vi.fn(),
}));

vi.mock("mediabunny", () => ({
  ALL_FORMATS: Symbol("ALL_FORMATS"),
  BlobSource: mediabunnyMocks.BlobSource,
  BufferTarget: mediabunnyMocks.BufferTarget,
  canEncodeAudio: mediabunnyMocks.canEncodeAudio,
  Conversion: {
    init: mediabunnyMocks.conversionInit,
  },
  Input: mediabunnyMocks.Input,
  Output: mediabunnyMocks.Output,
  WebMOutputFormat: mediabunnyMocks.WebMOutputFormat,
}));

import {
  AUDIO_WEBM_BITRATE,
  AUDIO_WEBM_CODEC,
  convertAudioFileToWebm,
  getAudioToWebmSupport,
} from "../AudioToWebmConverter";

describe("AudioToWebmConverter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "AudioEncoder", {
      configurable: true,
      writable: true,
      value: class AudioEncoderMock {},
    });

    mediabunnyMocks.BlobSource.mockImplementation(function (this: unknown) {
      return { kind: "blob-source" };
    });
    mediabunnyMocks.BufferTarget.mockImplementation(function (this: unknown) {
      return { buffer: null };
    });
    mediabunnyMocks.WebMOutputFormat.mockImplementation(function (
      this: unknown,
    ) {
      return { mimeType: "video/webm" };
    });
  });

  it("reports unsupported browsers when Opus encoding is unavailable", async () => {
    mediabunnyMocks.canEncodeAudio.mockResolvedValue(false);

    await expect(getAudioToWebmSupport()).resolves.toEqual({
      supported: false,
      reason: "Opus-Encoding ist in diesem Browser derzeit nicht verfügbar.",
    });
  });

  it("rejects unsupported file extensions early", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "sample.ogg", {
      type: "audio/ogg",
    });

    await expect(convertAudioFileToWebm(file)).rejects.toThrow(
      "Es werden nur WAV- und MP3-Dateien unterstützt.",
    );
  });

  it("converts a supported audio file and returns a summary", async () => {
    mediabunnyMocks.canEncodeAudio.mockResolvedValue(true);

    const audioTrack = {
      codec: "mp3",
      numberOfChannels: 2,
      sampleRate: 44_100,
    };
    const inputInstance = {
      computeDuration: vi.fn().mockResolvedValue(3.25),
      getPrimaryAudioTrack: vi.fn().mockResolvedValue(audioTrack),
    };
    const outputInstance = {
      target: {
        buffer: new Uint8Array([9, 8, 7, 6]),
      },
    };

    mediabunnyMocks.Input.mockImplementation(function (this: unknown) {
      return inputInstance;
    });
    mediabunnyMocks.Output.mockImplementation(function (this: unknown) {
      return outputInstance;
    });
    mediabunnyMocks.conversionInit.mockResolvedValue({
      isValid: true,
      execute: vi.fn().mockResolvedValue(undefined),
    });

    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], "voice.mp3", {
      type: "audio/mpeg",
    });

    const result = await convertAudioFileToWebm(file);

    expect(mediabunnyMocks.BlobSource).toHaveBeenCalledWith(file);
    expect(mediabunnyMocks.WebMOutputFormat).toHaveBeenCalledTimes(1);
    expect(mediabunnyMocks.BufferTarget).toHaveBeenCalledTimes(1);
    expect(mediabunnyMocks.conversionInit).toHaveBeenCalledWith({
      input: inputInstance,
      output: outputInstance,
      audio: {
        codec: AUDIO_WEBM_CODEC,
        bitrate: AUDIO_WEBM_BITRATE,
      },
    });
    expect(result.outputFileName).toBe("voice.webm");
    expect(result.mime).toBe('audio/webm;codecs="opus"');
    expect(result.buffer.byteLength).toBe(4);
    expect(result.summary).toEqual({
      inputFileName: "voice.mp3",
      inputFormat: "MP3",
      inputCodec: "mp3",
      outputCodec: "opus",
      durationSeconds: 3.25,
      sampleRate: 44_100,
      channels: 2,
      bitrate: AUDIO_WEBM_BITRATE,
      inputBytes: 5,
      outputBytes: 4,
    });
  });

  it("surfaces conversion validation failures", async () => {
    mediabunnyMocks.canEncodeAudio.mockResolvedValue(true);

    mediabunnyMocks.Input.mockImplementation(function (this: unknown) {
      return {
        computeDuration: vi.fn(),
        getPrimaryAudioTrack: vi.fn().mockResolvedValue({
          codec: "wav",
          numberOfChannels: 1,
          sampleRate: 48_000,
        }),
      };
    });
    mediabunnyMocks.Output.mockImplementation(function (this: unknown) {
      return {
        target: {
          buffer: null,
        },
      };
    });
    mediabunnyMocks.conversionInit.mockResolvedValue({
      isValid: false,
      discardedTracks: [{ reason: "Opus-Encoder fehlt" }],
    });

    const file = new File([new Uint8Array([1, 2])], "sample.wav", {
      type: "audio/wav",
    });

    await expect(convertAudioFileToWebm(file)).rejects.toThrow(
      "Opus-Encoder fehlt",
    );
  });
});
