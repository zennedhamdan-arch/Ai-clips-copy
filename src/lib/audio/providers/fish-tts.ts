import fsp from "node:fs/promises";
import { config } from "../../config";
import { AppError, describeHttpStatus } from "../../errors";
import { pcm16ToWav } from "./gemini-tts";
import type { NarrationResult, TtsProvider } from "../types";

/**
 * Fish Audio TTS — the documented public endpoint:
 *   POST {FISH_TTS_BASE_URL}/v1/tts
 *   headers: Authorization: Bearer <FISH_API_KEY>,
 *            Content-Type: application/json,
 *            model: <FISH_TTS_MODEL>            (model is a HEADER on this API)
 *   body:    { text, format: "mp3", reference_id? }
 *
 * The response body is the RAW AUDIO BYTES (no JSON envelope); the
 * content-type reflects the requested format. We request MP3 (the pipeline
 * already treats provider output as opaque audio and transcodes to MP3, and
 * ffprobe/ffmpeg read the container by content, never by filename).
 *
 * The API key is sent only in the Authorization header and is never logged.
 */

/** Fish's documented default sample rate (44.1 kHz, 16-bit, mono) for PCM. */
const FISH_PCM_SAMPLE_RATE = 44_100;

/** Magic-byte sniffers for common audio containers (content, not filename). */
function hasAudioContainerMagic(bytes: Buffer): boolean {
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return true;
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3") return true; // MP3 with ID3 tag
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true; // MP3 frame sync
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "OggS") return true; // Ogg/Opus
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "fLaC") return true; // FLAC
  return false;
}

export class FishTtsProvider implements TtsProvider {
  readonly id = "fish";
  readonly label = "Fish Audio TTS";
  /** Only ready when a key is configured; the router skips it otherwise. */
  readonly ready = config.fishApiKey.length > 0;

  async generateNarration(options: {
    text: string;
    outPath: string;
    voice?: string | null;
    expectedSec?: number;
  }): Promise<NarrationResult> {
    if (!this.ready) {
      throw new AppError("missing_api_key", "Fish Audio TTS is not configured.", {
        detail: "Set FISH_API_KEY (and optionally FISH_TTS_MODEL, default s2.1-pro-free, and FISH_TTS_VOICE).",
        status: 503,
      });
    }

    // Fish voices are referenced by a voice-model id (reference_id). Prefer the
    // Fish-specific config; fall back to an explicitly-passed voice (the
    // pipelines do not pass one, so Fish uses its default voice by default).
    const referenceId = config.fishTtsVoice.trim() || options.voice?.trim() || "";

    const body: Record<string, unknown> = { text: options.text, format: "mp3" };
    if (referenceId) body.reference_id = referenceId;

    const response = await fetch(`${config.fishTtsBaseUrl}/v1/tts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.fishApiKey}`,
        "Content-Type": "application/json",
        model: config.fishTtsModel,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.audioRequestTimeoutSec * 1000),
    });

    if (!response.ok) {
      // Never include the API key in the captured body. describeHttpStatus
      // maps 429/5xx → retryable (router retries then falls back) and 4xx →
      // non-transient (router moves to the next provider immediately).
      const text = await response.text().catch(() => "");
      throw describeHttpStatus(response.status, "Fish TTS", text);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new AppError("audio_error", "Fish TTS returned an empty audio payload.", { retryable: true });
    }

    // Determine the container from the response (content-type + magic bytes),
    // never from the output filename. Preserve valid audio byte-for-byte;
    // wrap only a raw PCM payload (no container) in a valid WAV header so the
    // existing ffprobe verification can read it.
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const mimeLooksAudio = contentType.startsWith("audio/");
    if (!hasAudioContainerMagic(buffer)) {
      if (mimeLooksAudio && /pcm|l16|s16/i.test(contentType)) {
        const wav = pcm16ToWav(buffer, FISH_PCM_SAMPLE_RATE, 1);
        await fsp.writeFile(options.outPath, wav);
        return { providerId: this.id, filePath: options.outPath, bytes: wav.length, contentType: "audio/wav", voice: referenceId || null };
      }
      throw new AppError("audio_error", "Fish TTS returned a non-audio payload.", {
        detail: contentType ? `content-type=${contentType.slice(0, 120)}` : "no audio content-type and no recognized container",
        retryable: true,
      });
    }

    await fsp.writeFile(options.outPath, buffer);
    return {
      providerId: this.id,
      filePath: options.outPath,
      bytes: buffer.length,
      contentType: mimeLooksAudio ? contentType : "audio/mpeg",
      voice: referenceId || null,
    };
  }
}
