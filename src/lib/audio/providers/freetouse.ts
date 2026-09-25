import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../../config";
import { AppError, describeHttpStatus } from "../../errors";
import type { MusicProvider, MusicQuery, MusicResult } from "../types";

/**
 * Free To Use (https://freetouse.com) — public, royalty-free music library.
 * Endpoints below are taken from the official OpenAPI spec
 * (https://api.freetouse.com/v3/openapi.json); no API key is required.
 *
 *   GET /music/tracks/search?query=&limit=&order=&sort=
 *
 * Track shape (subset used here):
 *   { id, title, artists: [[seq, {id,name}]], genre, is_premium,
 *     duration, downloads, plays, tags: [[seq, string]],
 *     categories: [[seq, {id,name} | string]], files: { mp3: <url> } }
 */
export type FreetoUseTrack = {
  id: string;
  title: string;
  artists: Array<[number, { id: string; name: string }]>;
  genre: string | null;
  is_premium: boolean;
  duration: number;
  downloads: number;
  plays: number;
  tags: Array<[number, string]>;
  categories: Array<[number, { id: string; name: string } | string]>;
  tags_categories?: Array<[number, { id?: string; name?: string } | string]>;
  files?: { mp3?: string };
};

type ParsedTrack = {
  title: string;
  artists: string[];
  tags: string[];
  genre: string | null;
  isPremium: boolean;
  duration: number;
  downloads: number;
  mp3Url: string | null;
};

/** Normalise the messy [[seq, value]] arrays from the spec into flat lists. */
export function parseFreetoUseTrack(raw: Record<string, unknown>): ParsedTrack | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id || raw.status !== 1) return null;
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : null;
  if (!title) return null;
  const artists = Array.isArray(raw.artists)
    ? raw.artists
        .map((pair) => (Array.isArray(pair) && pair[1] && typeof pair[1] === "object" && typeof (pair[1] as { name?: unknown }).name === "string"
          ? (pair[1] as { name: string }).name
          : null))
        .filter((name): name is string => Boolean(name))
    : [];
  const flatTags = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((pair) => {
            if (!Array.isArray(pair)) return null;
            const leaf = pair[pair.length - 1];
            return typeof leaf === "string" ? leaf.trim().toLowerCase() : null;
          })
          .filter((tag): tag is string => Boolean(tag))
      : [];
  const genre = typeof raw.genre === "string" && raw.genre.trim() ? raw.genre.trim().toLowerCase() : null;
  const duration = Number(raw.duration);
  const mp3Url = raw.files && typeof raw.files === "object" && typeof (raw.files as { mp3?: unknown }).mp3 === "string"
    ? (raw.files as { mp3: string }).mp3
    : null;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return {
    title,
    artists,
    tags: [...new Set([...flatTags(raw.tags), ...flatTags(raw.categories), ...flatTags(raw.tags_categories)])],
    genre,
    isPremium: raw.is_premium === true,
    duration,
    downloads: Number(raw.downloads) || 0,
    mp3Url,
  };
}

/**
 * Deterministic ranking of candidate tracks for a narration-friendly bed:
 * topic/mood keyword matches dominate; healthy duration next; popularity is
 * only a tie-breaker.
 */
export function scoreFreetoUseTrack(track: ParsedTrack, query: { topic?: string | null; mood?: string | null; durationSec?: number }): number {
  const terms = [query.topic, query.mood, query.mood === "calm" ? "chill" : null]
    .flatMap((value) => (value ?? "").toLowerCase().split(/[^a-z0-9]+/))
    .filter((term) => term.length >= 3)
    .slice(0, 8);
  let score = 0;
  const haystack = `${track.title} ${track.tags.join(" ")} ${track.genre ?? ""}`.toLowerCase();
  for (const term of terms) {
    if (haystack.includes(term)) score += 3;
  }
  if (query.durationSec && track.duration >= Math.min(60, query.durationSec) && track.duration <= 600) score += 2;
  if (track.duration >= 45 && track.duration <= 420) score += 1;
  return score + Math.min(1, track.downloads / 100_000);
}

/** Bounded streaming download with a hard size cap. */
async function downloadBounded(url: string, outPath: string, maxBytes: number): Promise<number> {
  const response = await fetch(url, { signal: AbortSignal.timeout(config.audioRequestTimeoutSec * 1000) });
  if (!response.ok) {
    throw describeHttpStatus(response.status, "Free To Use download", "(binary stream)");
  }
  if (!response.body) throw new AppError("audio_error", "Free To Use returned an empty body.", { retryable: true });
  const { Readable, Transform } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        callback(new AppError("too_large", `Music download exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB cap.`));
        return;
      }
      callback(null, chunk);
    },
  });
  const webStream = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
  await pipeline(Readable.fromWeb(webStream), limiter, createWriteStream(outPath));
  if (!bytes) {
    await fsp.rm(outPath, { force: true });
    throw new AppError("audio_error", "Free To Use music download was empty.", { retryable: true });
  }
  return bytes;
}

export class FreetoUseMusicProvider implements MusicProvider {
  readonly id = "freetouse";
  readonly label = "Free To Use (public music library)";
  readonly ready = true;

  async selectMusic(query: MusicQuery): Promise<MusicResult> {
    const searchTerm = [query.mood, query.topic]
      .flatMap((value) => (value ?? "").toLowerCase().split(/[^a-z0-9]+/))
      .filter(Boolean)
      .slice(0, 4)
      .join(" ")
      .slice(0, 60) || "cinematic ambient";
    const params = new URLSearchParams({ query: searchTerm, limit: "12", order: "plays", sort: "desc" });
    const url = `${config.freetouseBaseUrl}/music/tracks/search?${params.toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(config.audioRequestTimeoutSec * 1000) });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw describeHttpStatus(response.status, "Free To Use", text);
    }
    const payload = (await response.json()) as { ok: boolean; data?: Array<Record<string, unknown>>; error?: string };
    if (!payload.ok || !Array.isArray(payload.data)) {
      throw new AppError("audio_error", "Free To Use returned an unexpected response.", {
        detail: String(payload.error ?? "malformed payload").slice(0, 300),
        retryable: true,
      });
    }
    const candidates = payload.data
      .map((raw) => parseFreetoUseTrack(raw))
      .filter((track): track is ParsedTrack => Boolean(track?.mp3Url))
      .filter((track) => !track.isPremium && track.duration >= 45 && track.duration <= 480);
    if (!candidates.length) {
      throw new AppError("audio_error", "Free To Use has no matching non-premium track for this query.");
    }
    candidates.sort((a, b) => scoreFreetoUseTrack(b, query) - scoreFreetoUseTrack(a, query));
    const track = candidates[0];

    const extension = path.extname(new URL(track.mp3Url!).pathname).toLowerCase() === ".mp3" ? ".mp3" : ".mp3";
    const target = query.outPath.endsWith(extension) ? query.outPath : `${query.outPath}${extension}`;
    const bytes = await downloadBounded(track.mp3Url!, target, config.audioMaxMusicBytes);
    return {
      providerId: this.id,
      filePath: target,
      durationSec: track.duration,
      bytes,
      title: track.title,
      artist: track.artists.join(", ") || null,
      licenseUrl: "https://freetouse.com/license",
      contentType: "audio/mpeg",
    };
  }
}
