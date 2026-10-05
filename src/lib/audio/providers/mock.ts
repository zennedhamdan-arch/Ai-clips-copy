import fsp from "node:fs/promises";
import { runFfmpegArgs } from "../../ffmpeg";
import type { MusicProvider, MusicQuery, MusicResult, NarrationResult, TtsProvider } from "../types";

/**
 * Offline testing provider. Enabled ONLY when AUDIO_MOCK=1.
 *
 * It renders deterministic low-level sine tones (no network, no keys) so the
 * Movie Explainer and Documentary pipelines can be exercised end-to-end on a
 * dev box or in tests. The duration mirrors the narration estimate so caption
 * pacing and checkpoints behave exactly like production audio.
 */
export class MockTtsProvider implements TtsProvider {
  readonly id = "mock";
  readonly label = "Mock TTS (offline testing only)";
  readonly ready = true;

  async generateNarration(options: {
    text: string;
    outPath: string;
    voice?: string | null;
    expectedSec?: number;
  }): Promise<NarrationResult> {
    const words = options.text.trim().split(/\s+/).filter(Boolean).length;
    const durationSec = options.expectedSec && options.expectedSec > 0
      ? options.expectedSec
      : Math.max(1.5, words / 2.4 + 0.8);
    await runFfmpegArgs([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi",
      "-i", `sine=frequency=174:sample_rate=44100:duration=${durationSec.toFixed(3)}`,
      "-af", "volume=0.06",
      "-ar", "44100", "-ac", "2",
      options.outPath,
    ]);
    const stat = await fsp.stat(options.outPath);
    return {
      providerId: this.id,
      filePath: options.outPath,
      bytes: stat.size,
      contentType: "audio/mpeg",
      voice: null,
    };
  }
}

export class MockMusicProvider implements MusicProvider {
  readonly id = "mock";
  readonly label = "Mock music (offline testing only)";
  readonly ready = true;

  async selectMusic(options: MusicQuery): Promise<MusicResult> {
    const durationSec = Math.min(240, Math.max(30, Math.round(options.durationSec ?? 60)));
    await runFfmpegArgs([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi",
      "-i", `sine=frequency=98:sample_rate=44100:duration=${durationSec}`,
      "-af", "volume=0.05",
      "-ar", "44100", "-ac", "2",
      options.outPath,
    ]);
    const stat = await import("node:fs/promises").then((m) => m.stat(options.outPath));
    return {
      providerId: this.id,
      filePath: options.outPath,
      durationSec,
      bytes: stat.size,
      title: "Mock background track",
      artist: "ClipForge test fixtures",
      licenseUrl: null,
      contentType: "audio/mpeg",
    };
  }
}
