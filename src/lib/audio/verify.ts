import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { AppError } from "../errors";
import { mediaDurationSeconds } from "../ffmpeg";

/** Rough spoken-English duration estimate (~145 wpm + a short lead-in). */
export function estimateNarrationDurationSec(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  const rate = Math.max(0.5, config.narrationWordsPerSec);
  return Math.max(1.5, words / rate + 0.8);
}

export type VerifiedAudio = {
  durationSec: number;
  bytes: number;
};

/**
 * Verify a generated audio file before any checkpoint marks the work ready:
 * it must exist, be non-trivial, decode with ffprobe, and — when an expected
 * duration is known — be within a sane ratio of it (guards against truncated
 * downloads and silent/empty TTS responses).
 */
export async function verifyAudioFile(filePath: string, expectedSec?: number): Promise<VerifiedAudio> {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || stat.size < 512) {
    throw new AppError(
      "audio_error",
      `Generated audio is missing or empty: ${path.basename(filePath)}`,
      { retryable: true },
    );
  }
  let durationSec = 0;
  try {
    durationSec = await mediaDurationSeconds(filePath);
  } catch (error) {
    throw new AppError("audio_error", `Generated audio could not be probed: ${(error as Error).message}`, {
      retryable: true,
    });
  }
  if (!Number.isFinite(durationSec) || durationSec < 0.2) {
    throw new AppError("audio_error", "Generated audio has no playable duration.", { retryable: true });
  }
  if (expectedSec && expectedSec > 0) {
    const ratio = durationSec / expectedSec;
    if (ratio < 0.25 || ratio > 4) {
      throw new AppError(
        "audio_error",
        `Generated audio duration (${durationSec.toFixed(1)}s) is implausible for the narration (expected ~${expectedSec.toFixed(1)}s).`,
        { retryable: true },
      );
    }
  }
  return { durationSec: Number(durationSec.toFixed(3)), bytes: stat.size };
}
