import fsp from "node:fs/promises";
import { config } from "../../config";
import { AppError, describeHttpStatus } from "../../errors";
import type { NarrationResult, TtsProvider } from "../types";

/**
 * Gemini TTS — reuses the existing GEMINI_API_KEY / geminiBaseUrl integration
 * already used for clip analysis.
 *
 * Endpoint (documented Gemini API):
 *   POST {geminiBaseUrl}/models/{TTS_GEMINI_MODEL}:generateContent
 *   generationConfig: { responseModalities: ["AUDIO"], speechConfig: {...} }
 * Audio arrives base64-encoded in candidates[0].content.parts[].inlineData.
 *
 * Gemini's current raw output is typically `audio/L16;rate=24000` — bare
 * 16-bit PCM with no container. That is written through a proper RIFF/WAVE
 * wrapper (pcm16ToWav) before hitting disk so ffprobe can read it; payloads
 * that are already valid containers (wav/mp3/ogg/flac/...) are preserved
 * byte-for-byte.
 */

/** Gemini's documented default raw-PCM sample rate. */
const GEMINI_DEFAULT_RATE = 24000;
/** MIME subtypes that mean "bare PCM samples, no container". */
const RAW_PCM_SUBTYPES = new Set(["l16", "s16", "pcm", "x-pcm", "l16le", "s16le"]);

/**
 * Parse a Gemini inlineData mimeType like `audio/L16;rate=24000` into its
 * subtype (lowercased, without the `audio/` prefix) and sample rate. Missing
 * or malformed parameters fall back to the documented default.
 */
export function parseGeminiAudioMime(mime: string | undefined): { subtype: string; rate: number } {
  const raw = (mime ?? "").trim();
  const parts = raw.split(";");
  const typePart = (parts[0] ?? "").trim().toLowerCase();
  const subtype = typePart.includes("/") ? (typePart.split("/")[1] ?? "") : typePart;
  let rate = GEMINI_DEFAULT_RATE;
  for (const param of parts.slice(1)) {
    const eq = param.indexOf("=");
    if (eq <= 0) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    const value = Number(param.slice(eq + 1).trim());
    if ((key === "rate" || key === "samplerate" || key === "sample_rate") && Number.isFinite(value) && value > 0) {
      rate = Math.round(value);
    }
  }
  return { subtype, rate };
}

/** Known container magics — payloads starting with one are already playable. */
function looksLikeContainer(bytes: Buffer): boolean {
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return true;
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3") return true;
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "OggS") return true;
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "fLaC") return true;
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true; // EBML (webm)
  return false;
}

/**
 * True when the payload is bare PCM that needs a container: an explicit raw
 * PCM MIME subtype, or an unknown/missing MIME whose bytes carry no known
 * container magic (Gemini's documented raw output).
 */
export function isRawPcmPayload(subtype: string, bytes: Buffer): boolean {
  if (subtype) return RAW_PCM_SUBTYPES.has(subtype);
  return !looksLikeContainer(bytes);
}

/**
 * Wrap raw 16-bit little-endian PCM in a valid RIFF/WAVE container (44-byte
 * canonical header). This is NOT a rename: the header encodes format,
 * channels, sample rate, byte rate and exact data size.
 */
export function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // audio format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Write the Gemini audio payload to outPath in a container ffprobe can read:
 * raw PCM is wrapped as WAV (rate taken from the MIME), already-valid
 * containers are written unchanged. Returns the bytes written and the
 * resulting content type.
 */
export async function normalizeGeminiAudioPayload(
  mimeType: string | undefined,
  payload: Buffer,
  outPath: string,
): Promise<{ bytes: number; contentType: string }> {
  const { subtype, rate } = parseGeminiAudioMime(mimeType);
  if (!isRawPcmPayload(subtype, payload)) {
    await fsp.writeFile(outPath, payload);
    return { bytes: payload.length, contentType: mimeType || "audio/wav" };
  }
  const wav = pcm16ToWav(payload, rate, 1);
  await fsp.writeFile(outPath, wav);
  return { bytes: wav.length, contentType: "audio/wav" };
}

export class GeminiTtsProvider implements TtsProvider {
  readonly id = "gemini";
  readonly label = "Gemini TTS";
  readonly ready = config.geminiApiKey.length > 0 && config.ttsGeminiModel.length > 0;

  async generateNarration(options: {
    text: string;
    outPath: string;
    voice?: string | null;
    expectedSec?: number;
  }): Promise<NarrationResult> {
    if (!this.ready) {
      throw new AppError("missing_api_key", "Gemini TTS is not configured.", {
        detail: "Set GEMINI_API_KEY; optionally TTS_GEMINI_MODEL (default gemini-2.5-flash-preview-tts) and TTS_GEMINI_VOICE.",
        status: 503,
      });
    }
    const endpoint = `${config.geminiBaseUrl}/models/${encodeURIComponent(config.ttsGeminiModel)}:generateContent`;
    const voice = options.voice?.trim() || config.ttsGeminiVoice;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.geminiApiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: options.text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(config.audioRequestTimeoutSec * 1000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw describeHttpStatus(response.status, "Gemini TTS", text);
    }
    const parsed = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } | null }> } }>;
      promptFeedback?: unknown;
      error?: unknown;
    };
    let inline: { mimeType?: string; data?: string } | null = null;
    for (const candidate of parsed.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.inlineData?.data) {
          inline = part.inlineData;
          break;
        }
      }
      if (inline) break;
    }
    if (!inline?.data) {
      throw new AppError("audio_error", "Gemini TTS returned no audio payload.", {
        detail: JSON.stringify(parsed.promptFeedback ?? parsed.error ?? parsed).slice(0, 400),
        retryable: true,
      });
    }
    const buffer = Buffer.from(inline.data, "base64");
    if (!buffer.length) {
      throw new AppError("audio_error", "Gemini TTS returned an empty audio payload.", { retryable: true });
    }
    // Raw audio/L16 PCM is wrapped in a valid WAV container (sample rate from
    // the MIME); already-valid containers are preserved byte-for-byte. The
    // router's verifyAudioFile() still probes the result before it is used.
    const { bytes, contentType } = await normalizeGeminiAudioPayload(inline.mimeType, buffer, options.outPath);
    return {
      providerId: this.id,
      filePath: options.outPath,
      bytes,
      contentType,
      voice,
    };
  }
}
