/**
 * Provider-agnostic audio layer.
 *
 * The Movie Explainer and Documentary pipelines NEVER talk to a concrete TTS
 * or music provider directly — they call the AudioRouter (see router.ts),
 * which resolves the configured provider order, retries transient failures,
 * falls back to the next provider, and verifies every generated file. Swapping
 * providers is an env change only (AUDIO_TTS_PROVIDERS / AUDIO_MUSIC_PROVIDERS).
 */

export interface TtsProvider {
  readonly id: string;
  readonly label: string;
  /** False when the provider cannot be configured (missing key) or is disabled. */
  readonly ready: boolean;
  generateNarration(options: {
    text: string;
    /** Unique temporary output path (per job/scene). */
    outPath: string;
    /** Voice preference, when the provider supports one. */
    voice?: string | null;
    /** Expected duration in seconds, used for post-generation verification. */
    expectedSec?: number;
  }): Promise<NarrationResult>;
}

export interface MusicProvider {
  readonly id: string;
  readonly label: string;
  readonly ready: boolean;
  selectMusic(options: MusicQuery): Promise<MusicResult>;
}

export type NarrationResult = {
  providerId: string;
  filePath: string;
  /** Filled in by the router after ffprobe verification (0 before). */
  durationSec?: number;
  bytes: number;
  contentType: string;
  voice?: string | null;
};

export type MusicQuery = {
  /** Free-text topic used to search (documentary subject / movie title). */
  topic?: string | null;
  mood?: string | null;
  energy?: "low" | "medium" | "high" | null;
  /** Desired final video duration; used to sanity-check the picked track. */
  durationSec?: number;
  /** Unique temporary output path (per job). */
  outPath: string;
};

export type MusicResult = {
  providerId: string;
  filePath: string;
  durationSec: number;
  bytes: number;
  title: string | null;
  artist: string | null;
  licenseUrl: string | null;
  contentType: string;
};
