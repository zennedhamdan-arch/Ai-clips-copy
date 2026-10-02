import fsp from "node:fs/promises";
import { config } from "../../config";
import { AppError, describeHttpStatus } from "../../errors";
import type { NarrationResult, TtsProvider } from "../types";

/**
 * OpenAI-compatible TTS (documented endpoint):
 *   POST {OPENAI_TTS_BASE_URL}/audio/speech
 *   body: { model, voice, input, response_format: "mp3" }
 * Any OpenAI-compatible /audio/speech implementation can be pointed here by
 * changing OPENAI_TTS_BASE_URL — the pipeline never knows which one is used.
 */
export class OpenAiTtsProvider implements TtsProvider {
  readonly id = "openai";
  readonly label = "OpenAI-compatible TTS";
  readonly ready = config.openaiApiKey.length > 0;

  async generateNarration(options: {
    text: string;
    outPath: string;
    voice?: string | null;
    expectedSec?: number;
  }): Promise<NarrationResult> {
    if (!this.ready) {
      throw new AppError("missing_api_key", "OpenAI-compatible TTS is not configured.", {
        detail: "Set OPENAI_API_KEY (and optionally OPENAI_TTS_BASE_URL / OPENAI_TTS_MODEL / OPENAI_TTS_VOICE).",
        status: 503,
      });
    }
    const response = await fetch(`${config.openaiTtsBaseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.openaiTtsModel,
        voice: options.voice?.trim() || config.openaiTtsVoice,
        input: options.text,
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(config.audioRequestTimeoutSec * 1000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw describeHttpStatus(response.status, "OpenAI TTS", text);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024) {
      throw new AppError("audio_error", "OpenAI TTS returned an empty audio file.", { retryable: true });
    }
    await fsp.writeFile(options.outPath, buffer);
    return {
      providerId: this.id,
      filePath: options.outPath,
      bytes: buffer.length,
      contentType: "audio/mpeg",
      voice: options.voice?.trim() || config.openaiTtsVoice,
    };
  }
}
