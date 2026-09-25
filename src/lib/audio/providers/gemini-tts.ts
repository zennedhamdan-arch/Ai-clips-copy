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
 */
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
    await fsp.writeFile(options.outPath, buffer);
    return {
      providerId: this.id,
      filePath: options.outPath,
      bytes: buffer.length,
      contentType: inline.mimeType || "audio/L16;rate=24000",
      voice,
    };
  }
}
