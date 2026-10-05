import fsp from "node:fs/promises";
import { b2Configured, downloadB2ObjectToFile } from "../../b2";
import { getMusicTrack, listSelectionCandidates } from "../../music-library";
import { mediaDurationSeconds } from "../../ffmpeg";
import { AppError } from "../../errors";
import type { MusicProvider, MusicQuery, MusicResult } from "../types";

/**
 * Reuses the EXISTING Backblaze B2 Music Library (music_tracks table +
 * B2 objects under music/). No new storage: selection is metadata-only,
 * then the winning track is streamed to the job's unique temp path.
 */
export class B2MusicProvider implements MusicProvider {
  readonly id = "b2";
  readonly label = "B2 Music Library";
  readonly ready = b2Configured();

  async selectMusic(query: MusicQuery): Promise<MusicResult> {
    const candidates = await listSelectionCandidates(60);
    if (!candidates.length) {
      throw new AppError("audio_error", "The B2 Music Library has no ready tracks.");
    }
    const scored = candidates
      .map((candidate) => ({ candidate, score: scoreB2Candidate(candidate, query) }))
      .sort((a, b) => b.score - a.score);
    const pick = scored[0].candidate;
    const row = await getMusicTrack(pick.id);
    if (!row) {
      throw new AppError("audio_error", "Selected B2 Music Library track disappeared before download.");
    }
    await downloadB2ObjectToFile(row.b2ObjectKey, query.outPath);
    const stat = await fsp.stat(query.outPath);
    if (stat.size < 1024) {
      throw new AppError("audio_error", "B2 Music Library track downloaded empty.", { retryable: true });
    }
    const durationSec = row.durationSec && row.durationSec > 0 ? row.durationSec : await mediaDurationSeconds(query.outPath);
    return {
      providerId: this.id,
      filePath: query.outPath,
      durationSec: Number(durationSec.toFixed(2)),
      bytes: stat.size,
      title: row.displayName,
      artist: null,
      licenseUrl: null,
      contentType: row.contentType,
    };
  }
}

/** Mood/energy/tags scoring over library metadata (deterministic, offline). */
export function scoreB2Candidate(
  candidate: { displayName: string; mood: string | null; energy: string | null; genre: string | null; tags: string[]; durationSec: number | null },
  query: MusicQuery,
): number {
  let score = 0;
  if (query.mood) {
    const mood = query.mood.toLowerCase();
    if (candidate.mood?.toLowerCase() === mood) score += 3;
    else if ((candidate.tags.join(" ") + " " + (candidate.displayName ?? "")).toLowerCase().includes(mood)) score += 2;
  }
  if (query.energy && candidate.energy === query.energy) score += 2;
  const terms = (query.topic ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3).slice(0, 6);
  const haystack = `${candidate.displayName} ${candidate.genre ?? ""} ${candidate.tags.join(" ")}`.toLowerCase();
  for (const term of terms) if (haystack.includes(term)) score += 1;
  const duration = candidate.durationSec;
  if (duration && duration >= 60 && duration <= 300) score += 1;
  return score;
}
