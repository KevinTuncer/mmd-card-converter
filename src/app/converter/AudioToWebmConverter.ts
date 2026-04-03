import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  Conversion,
  Input,
  Output,
  WebMOutputFormat,
} from "mediabunny";
import { getErrorStrings } from "@/i18n/localization";

export const AUDIO_WEBM_CODEC = "opus";
export const AUDIO_WEBM_BITRATE = 160_000;
export const AUDIO_WEBM_MIME = `audio/webm;codecs="${AUDIO_WEBM_CODEC}"`;

const SUPPORTED_AUDIO_EXTS = new Set(["wav", "mp3"]);

export interface AudioToWebmSupport {
  supported: boolean;
  reason?: string;
}

export interface AudioConversionSummary {
  inputFileName: string;
  inputFormat: string;
  inputCodec: string;
  outputCodec: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  bitrate: number;
  inputBytes: number;
  outputBytes: number;
}

export interface AudioToWebmResult {
  buffer: ArrayBuffer;
  mime: string;
  outputFileName: string;
  summary: AudioConversionSummary;
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "audio";
}

function getFileExt(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

function normalizeBuffer(buffer: ArrayBuffer | Uint8Array | null): ArrayBuffer {
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }

  if (buffer instanceof Uint8Array) {
    return Uint8Array.from(buffer).buffer;
  }

  throw new Error(getErrorStrings().audioNoBuffer);
}

function formatDiscardedTracks(discardedTracks: unknown): string | null {
  if (!Array.isArray(discardedTracks) || discardedTracks.length === 0) {
    return null;
  }

  const messages = discardedTracks
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }

      if (!entry || typeof entry !== "object") {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const pieces = [
        record.reason,
        record.message,
        record.error,
        record.description,
      ].filter((value): value is string => typeof value === "string");

      return pieces[0] ?? null;
    })
    .filter((value): value is string => value !== null);

  if (messages.length === 0) {
    return null;
  }

  return messages.join("; ");
}

export async function getAudioToWebmSupport(): Promise<AudioToWebmSupport> {
  const errors = getErrorStrings();

  if (typeof AudioEncoder === "undefined") {
    return {
      supported: false,
      reason: errors.audioNoEncoder,
    };
  }

  try {
    const supported = await canEncodeAudio(AUDIO_WEBM_CODEC);
    return supported
      ? { supported: true }
      : {
          supported: false,
          reason: errors.audioOpusUnavailable,
        };
  } catch (error) {
    return {
      supported: false,
      reason:
        error instanceof Error ? error.message : errors.audioSupportCheckFailed,
    };
  }
}

export async function convertAudioFileToWebm(
  file: File,
): Promise<AudioToWebmResult> {
  const errors = getErrorStrings();
  const extension = getFileExt(file.name);
  if (!SUPPORTED_AUDIO_EXTS.has(extension)) {
    throw new Error(errors.audioUnsupportedInput);
  }

  const support = await getAudioToWebmSupport();
  if (!support.supported) {
    throw new Error(support.reason ?? errors.audioEncodingUnsupported);
  }

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });
  const output = new Output({
    format: new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  const audioTrack = await input.getPrimaryAudioTrack();
  if (!audioTrack) {
    throw new Error(errors.audioTrackMissing);
  }

  const conversion = await Conversion.init({
    input,
    output,
    audio: {
      codec: AUDIO_WEBM_CODEC,
      bitrate: AUDIO_WEBM_BITRATE,
    },
  });

  if (!conversion.isValid) {
    const discardReason = formatDiscardedTracks(conversion.discardedTracks);
    throw new Error(discardReason ?? errors.audioConversionFailed);
  }

  await conversion.execute();

  const buffer = normalizeBuffer(output.target.buffer);
  const durationSeconds = await input.computeDuration();

  return {
    buffer,
    mime: AUDIO_WEBM_MIME,
    outputFileName: `${stripExt(file.name)}.webm`,
    summary: {
      inputFileName: file.name,
      inputFormat: extension.toUpperCase(),
      inputCodec:
        typeof audioTrack.codec === "string"
          ? audioTrack.codec
          : extension.toUpperCase(),
      outputCodec: AUDIO_WEBM_CODEC,
      durationSeconds,
      sampleRate: audioTrack.sampleRate,
      channels: audioTrack.numberOfChannels,
      bitrate: AUDIO_WEBM_BITRATE,
      inputBytes: file.size,
      outputBytes: buffer.byteLength,
    },
  };
}
