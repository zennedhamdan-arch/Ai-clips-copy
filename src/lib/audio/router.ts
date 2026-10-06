import fsp from "node:fs/promises";
import { config } from "../config";
import { AppError } from "../errors";
import { B2MusicProvider } from "./providers/b2-music";
import { FishTtsProvider } from "./providers/fish-tts";
import { FreetoUseMusicProvider } from "./providers/freetouse";
import { GeminiTtsProvider } from "./providers/gemini-tts";
import { MockMusicProvider, MockTtsProvider } from "./providers/mock";
import { OpenAiTtsProvider } from "./providers/openai-tts";
import type { MusicProvider, MusicQuery, MusicResult, NarrationResult, TtsProvider } from "./types";
import { estimateNarrationDurationSec, verifyAudioFile } from "./verify";

/**
 * Provider-agnostic AudioProvider router.
 *
 * Narration: AUDIO_TTS_PROVIDERS order (default "gemini,openai"; "mock" only
 * with AUDIO_MOCK=1). Music: AUDIO_MUSIC_PROVIDERS (default "b2,freetouse").
 *
 * Reliability contract shared by both capabilities:
 *   - each provider gets up to 2 attempts with bounded exponential backoff
 *     for transient failures (429 / 5xx / network / malformed output)
 *   - non-transient failures (bad key, bad model, 4xx) skip to the next provider
 *   - every generated file is ffprobe-verified before it is returned
 *   - music is optional: if no provider can supply a track the caller gets
 *     null and renders without music instead of failing the job
 */

type NormalizedFailure = {
  providerId: string;
  message: string;
  transient: boolean;
};

function normalizeFailure(providerId: string, error: unknown): NormalizedFailure {
  if (error instanceof AppError) {
    const transient =
      error.retryable ||
      error.kind === "rate_limited" ||
      error.kind === "audio_error" ||
      (error.providerStatus !== undefined && (error.providerStatus === 429 || error.providerStatus >= 500));
    return { providerId, message: error.message, transient };
  }
  const name = (error as Error)?.name ?? "";
  const message = (error as Error)?.message ?? String(error);
  const networkTransient = name === "TimeoutError" || name === "AbortError" || /fetch failed|network|socket|ECONN|ETIMEDOUT|UND_ERR/i.test(message);
  return { providerId, message, transient: networkTransient };
}

function buildTtsProviders(): TtsProvider[] {
  const registry: Record<string, TtsProvider> = {
    gemini: new GeminiTtsProvider(),
    fish: new FishTtsProvider(),
    openai: new OpenAiTtsProvider(),
    mock: new MockTtsProvider(),
  };
  return config.audioTtsProviders
    .map((id) => (id === "mock" && !config.audioMockEnabled ? null : registry[id]))
    .filter((provider): provider is TtsProvider => Boolean(provider && provider.ready));
}

function buildMusicProviders(): MusicProvider[] {
  const registry: Record<string, MusicProvider> = {
    b2: new B2MusicProvider(),
    freetouse: new FreetoUseMusicProvider(),
    mock: new MockMusicProvider(),
  };
  return config.audioMusicProviders
    .map((id) => (id === "mock" && !config.audioMockEnabled ? null : registry[id]))
    .filter((provider): provider is MusicProvider => Boolean(provider && provider.ready));
}

export type NarrationOptions = {
  text: string;
  /** Unique temporary path (per job/scene) for the generated file. */
  outPath: string;
  voice?: string | null;
  jobId?: string;
  /** Test hook: overrides provider resolution. */
  providersOverride?: TtsProvider[];
  /** Test hook: overrides file verification. */
  verifyOverride?: (filePath: string, expectedSec?: number) => Promise<{ durationSec: number; bytes: number }>;
};

/**
 * Generate narration through the configured TTS provider order.
 * Throws AppError("audio_error") only when EVERY provider failed.
 */
export async function generateNarration(options: NarrationOptions): Promise<NarrationResult> {
  const text = options.text.trim();
  if (!text) throw new AppError("audio_error", "Narration text is empty.");
  const expectedSec = estimateNarrationDurationSec(text);
  const providers = (options.providersOverride ?? buildTtsProviders()).filter((provider) => provider.ready);
  if (!providers.length) {
    throw new AppError(
      "missing_api_key",
      "No TTS narration provider is configured.",
      {
        status: 503,
        detail:
          "Set GEMINI_API_KEY (Gemini TTS), FISH_API_KEY (Fish Audio TTS), and/or OPENAI_API_KEY (OpenAI-compatible /audio/speech). " +
          "For local testing only, set AUDIO_MOCK=1 and include mock in AUDIO_TTS_PROVIDERS.",
      },
    );
  }
  const failures: string[] = [];
  for (const provider of providers) {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        console.info(`[audio] job=${options.jobId ?? "unknown"} capability=tts provider=${provider.id} attempt=${attempt} expected_sec=${expectedSec.toFixed(1)}`);
        const result = await provider.generateNarration({
          text,
          outPath: options.outPath,
          voice: options.voice,
          expectedSec,
        });
        const verified = await (options.verifyOverride ?? verifyAudioFile)(result.filePath, expectedSec);
        console.info(`[audio] job=${options.jobId ?? "unknown"} capability=tts provider=${provider.id} verified duration=${verified.durationSec.toFixed(1)}s bytes=${verified.bytes}`);
        return { ...result, durationSec: verified.durationSec, bytes: verified.bytes };
      } catch (error) {
        const failure = normalizeFailure(provider.id, error);
        failures.push(`${provider.id}: ${failure.message}`);
        console.warn(`[audio] job=${options.jobId ?? "unknown"} capability=tts provider=${provider.id} attempt=${attempt} failed transient=${failure.transient} detail=${failure.message.slice(0, 300)}`);
        await fsp.rm(options.outPath, { force: true }).catch(() => undefined);
        if (!failure.transient) break; // bad key/model → next provider immediately
        if (attempt < maxAttempts) {
          const delay = 1_500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }
  throw new AppError(
    "audio_error",
    `Narration generation failed on all TTS providers: ${failures.join(" | ").slice(0, 600)}`,
    { status: 502, retryable: true, resumeStage: "narration" },
  );
}

/**
 * Pick + download one background track through the configured music provider
 * order. Returns null (never throws) when music cannot be provided — music is
 * an enhancement, and the job must still produce its video.
 */
export async function selectMusic(options: MusicQuery & { jobId?: string }): Promise<MusicResult | null> {
  const providers = buildMusicProviders();
  if (!providers.length) {
    console.info(`[audio] job=${options.jobId ?? "unknown"} capability=music providers=none action=skip`);
    return null;
  }
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      console.info(`[audio] job=${options.jobId ?? "unknown"} capability=music provider=${provider.id} topic=${(options.topic ?? "").slice(0, 60) || "n/a"}`);
      const result = await provider.selectMusic(options);
      const verified = await verifyAudioFile(result.filePath);
      console.info(`[audio] job=${options.jobId ?? "unknown"} capability=music provider=${provider.id} verified track="${result.title}" duration=${verified.durationSec.toFixed(1)}s`);
      return { ...result, durationSec: verified.durationSec, bytes: verified.bytes };
    } catch (error) {
      const failure = normalizeFailure(provider.id, error);
      failures.push(`${provider.id}: ${failure.message}`);
      console.warn(`[audio] job=${options.jobId ?? "unknown"} capability=music provider=${provider.id} failed detail=${failure.message.slice(0, 300)}`);
      await fsp.rm(options.outPath, { force: true }).catch(() => undefined);
      if (!options.outPath.endsWith(".mp3")) await fsp.rm(`${options.outPath}.mp3`, { force: true }).catch(() => undefined);
    }
  }
  console.warn(`[audio] job=${options.jobId ?? "unknown"} capability=music all-providers-failed action=render-without-music failures=${failures.join(" | ").slice(0, 400)}`);
  return null;
}

/** Readiness report for /api/config and /api/health (no network calls). */
export function audioProviderStatus(): {
  tts: Array<{ id: string; label: string; ready: boolean }>;
  music: Array<{ id: string; label: string; ready: boolean }>;
} {
  const ttsAll: TtsProvider[] = [new GeminiTtsProvider(), new FishTtsProvider(), new OpenAiTtsProvider(), new MockTtsProvider()];
  const musicAll: MusicProvider[] = [new B2MusicProvider(), new FreetoUseMusicProvider(), new MockMusicProvider()];
  return {
    tts: ttsAll
      .filter((provider) => provider.id !== "mock" || config.audioMockEnabled)
      .map((provider) => ({ id: provider.id, label: provider.label, ready: provider.ready })),
    music: musicAll
      .filter((provider) => provider.id !== "mock" || config.audioMockEnabled)
      .map((provider) => ({ id: provider.id, label: provider.label, ready: provider.ready })),
  };
}

/** Convenience: the first ready TTS provider id (null when none). */
export function firstReadyTtsProviderId(): string | null {
  const providers = buildTtsProviders();
  return providers.length ? providers[0].id : null;
}

export { estimateNarrationDurationSec };
export type { MusicQuery, MusicResult, NarrationResult, TtsProvider, MusicProvider } from "./types";
export { verifyAudioFile };
