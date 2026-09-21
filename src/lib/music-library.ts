import path from "node:path";
import { and, asc, count, desc, eq, ilike, inArray, or, sql, sum } from "drizzle-orm";
import { getDb } from "@/db";
import { clips, musicTracks, type MusicTrackRow, type MusicTrackStatus } from "@/db/schema";
import { b2Configured, headB2Object, listB2ObjectsPage, MUSIC_KEY_PREFIX } from "./b2";
import { config } from "./config";
import { AppError } from "./errors";
import { probeVideo } from "./ffmpeg";

/**
 * Metadata index for the permanent Music Library stored in Backblaze B2.
 * Every query here is paginated: the library is never loaded into memory.
 */

/** Energies are normalised; mood and genre stay free text with UI suggestions. */
export const MUSIC_ENERGIES = ["low", "medium", "high"] as const;
export type MusicEnergy = (typeof MUSIC_ENERGIES)[number];

export type MusicTrackApi = {
  id: string;
  fileName: string;
  displayName: string;
  contentType: string;
  sizeBytes: number;
  durationSec: number | null;
  mood: string | null;
  energy: string | null;
  genre: string | null;
  tags: string[];
  status: MusicTrackStatus;
  audioMetadata: MusicTrackRow["audioMetadata"] | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  playbackUrl: string;
};

export type MusicTrackFilters = {
  query?: string | null;
  mood?: string | null;
  energy?: string | null;
  genre?: string | null;
  tag?: string | null;
  status?: MusicTrackStatus | null;
};

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, max) : null;
}

export function normalizeMood(value: unknown): string | null {
  return clean(value, 40);
}

export function normalizeEnergy(value: unknown): string | null {
  const normalized = clean(value, 20)?.toLowerCase() ?? null;
  if (!normalized) return null;
  if ((MUSIC_ENERGIES as readonly string[]).includes(normalized)) return normalized;
  if (["low-energy", "chill", "soft"].includes(normalized)) return "low";
  if (["mid", "balanced", "normal"].includes(normalized)) return "medium";
  if (["upbeat", "hype", "intense"].includes(normalized)) return "high";
  return null;
}

export function normalizeGenre(value: unknown): string | null {
  return clean(value, 40);
}

export function normalizeMusicTags(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [
    ...new Set(
      values
        .map((item) => String(item).trim().replace(/\s+/g, " "))
        .filter(Boolean)
        .map((item) => item.slice(0, 40)),
    ),
  ].slice(0, 12);
}

export function normalizeOptionalText(value: unknown, max: number): string | undefined {
  const cleaned = clean(value, max);
  return cleaned === null ? undefined : cleaned;
}

export function isMusicTrackStatus(value: unknown): value is MusicTrackStatus {
  return value === "uploading" || value === "ready" || value === "failed";
}

function buildFilters(filters: MusicTrackFilters) {
  const conditions = [];
  const query = filters.query?.trim().toLowerCase();
  if (query) {
    const pattern = `%${query}%`;
    conditions.push(
      or(
        ilike(musicTracks.displayName, pattern),
        ilike(musicTracks.fileName, pattern),
        ilike(musicTracks.genre, pattern),
        ilike(musicTracks.mood, pattern),
      ),
    );
  }
  if (filters.mood) conditions.push(eq(musicTracks.mood, filters.mood));
  if (filters.energy) conditions.push(eq(musicTracks.energy, filters.energy));
  if (filters.genre) conditions.push(eq(musicTracks.genre, filters.genre));
  if (filters.status) conditions.push(eq(musicTracks.status, filters.status));
  if (filters.tag) {
    const tag = filters.tag.trim().toLowerCase();
    conditions.push(
      sql`exists (select 1 from jsonb_array_elements_text(coalesce(${musicTracks.tags}, '[]'::jsonb)) as music_tag where lower(music_tag) = ${tag})`,
    );
  }
  return conditions.length ? and(...conditions) : undefined;
}

export type MusicTrackPage = {
  tracks: MusicTrackApi[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
};

export async function listMusicTracksPage(
  filters: MusicTrackFilters & { page?: number; pageSize?: number },
): Promise<MusicTrackPage> {
  const database = getDb();
  const pageSize = Math.max(1, Math.min(100, Math.round(filters.pageSize ?? config.musicPageSize)));
  const page = Math.max(1, Math.round(filters.page ?? 1));
  const where = buildFilters(filters);
  const [rows, totals] = await Promise.all([
    database
      .select()
      .from(musicTracks)
      .where(where)
      .orderBy(desc(musicTracks.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    database.select({ total: count() }).from(musicTracks).where(where),
  ]);
  const total = Number(totals[0]?.total ?? 0);
  return {
    tracks: rows.map(musicTrackApi),
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getMusicTrack(id: string): Promise<MusicTrackRow | null> {
  const [row] = await getDb().select().from(musicTracks).where(eq(musicTracks.id, id)).limit(1);
  return row ?? null;
}

export type MusicLibraryStats = {
  trackCount: number;
  readyCount: number;
  totalSizeBytes: number;
};

export async function musicLibraryStats(): Promise<MusicLibraryStats> {
  const [row] = await getDb()
    .select({
      trackCount: count(),
      totalSizeBytes: sum(musicTracks.fileSizeBytes),
      readyCount: sql<number>`count(*) filter (where ${musicTracks.status} = 'ready')`,
    })
    .from(musicTracks);
  return {
    trackCount: Number(row?.trackCount ?? 0),
    readyCount: Number(row?.readyCount ?? 0),
    totalSizeBytes: Number(row?.totalSizeBytes ?? 0),
  };
}

export function musicTrackApi(row: MusicTrackRow): MusicTrackApi {
  return {
    id: row.id,
    fileName: row.fileName,
    displayName: row.displayName,
    contentType: row.contentType,
    sizeBytes: row.fileSizeBytes,
    durationSec: row.durationSec,
    mood: row.mood,
    energy: row.energy,
    genre: row.genre,
    tags: row.tags ?? [],
    status: (isMusicTrackStatus(row.status) ? row.status : "uploading") as MusicTrackStatus,
    audioMetadata: row.audioMetadata ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    playbackUrl: `/api/music/library/${row.id}/file`,
  };
}

export async function createMusicTrack(values: {
  id: string;
  fileName: string;
  displayName: string;
  /** Server-only B2 key; never returned by the public API shape. */
  b2ObjectKey: string;
  contentType: string;
  sizeBytes: number;
  mood?: string | null;
  energy?: string | null;
  genre?: string | null;
  tags?: string[];
}): Promise<MusicTrackRow> {
  const [row] = await getDb()
    .insert(musicTracks)
    .values({
      id: values.id,
      fileName: values.fileName,
      displayName: values.displayName,
      b2ObjectKey: values.b2ObjectKey,
      contentType: values.contentType,
      fileSizeBytes: values.sizeBytes,
      mood: values.mood ?? null,
      energy: values.energy ?? null,
      genre: values.genre ?? null,
      tags: values.tags ?? [],
      status: "uploading",
    })
    .returning();
  return row;
}

export async function finalizeMusicTrack(
  id: string,
  values: {
    sizeBytes?: number;
    durationSec?: number | null;
    audioMetadata?: MusicTrackRow["audioMetadata"];
    status: MusicTrackStatus;
    error?: string | null;
  },
): Promise<void> {
  await getDb()
    .update(musicTracks)
    .set({
      ...(values.sizeBytes !== undefined ? { fileSizeBytes: values.sizeBytes } : {}),
      ...(values.durationSec !== undefined ? { durationSec: values.durationSec } : {}),
      ...(values.audioMetadata !== undefined ? { audioMetadata: values.audioMetadata } : {}),
      status: values.status,
      error: values.error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(musicTracks.id, id));
}

export type MusicTrackPatch = {
  displayName?: string;
  mood?: string | null;
  energy?: string | null;
  genre?: string | null;
  tags?: string[];
};

export async function updateMusicTrack(id: string, patch: MusicTrackPatch): Promise<MusicTrackRow | null> {
  const values: Partial<typeof musicTracks.$inferInsert> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) values.displayName = patch.displayName;
  if (patch.mood !== undefined) values.mood = patch.mood;
  if (patch.energy !== undefined) values.energy = patch.energy;
  if (patch.genre !== undefined) values.genre = patch.genre;
  if (patch.tags !== undefined) values.tags = patch.tags;
  const [row] = await getDb().update(musicTracks).set(values).where(eq(musicTracks.id, id)).returning();
  return row ?? null;
}

/**
 * Delete a music record. Callers must delete the B2 object only after this
 * succeeds, so the database never points at an object that is already gone.
 */
export async function deleteMusicTrack(id: string): Promise<MusicTrackRow | null> {
  const [row] = await getDb().delete(musicTracks).where(eq(musicTracks.id, id)).returning();
  return row ?? null;
}

/** True when a clip is mid-music-change and its track must not be deleted. */
export async function musicTrackInUse(id: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: clips.id })
    .from(clips)
    .where(and(eq(clips.musicTrackId, id), sql`${clips.musicStatus} in ('applying', 'uploading')`))
    .limit(1);
  return rows.length > 0;
}

export type MusicSelectionCandidate = {
  id: string;
  displayName: string;
  mood: string | null;
  energy: string | null;
  genre: string | null;
  tags: string[];
  durationSec: number | null;
};

/** Metadata-only candidates for AI selection (no keys, no URLs, no audio). */
export async function listSelectionCandidates(limit = 60): Promise<MusicSelectionCandidate[]> {
  const rows = await getDb()
    .select({
      id: musicTracks.id,
      displayName: musicTracks.displayName,
      mood: musicTracks.mood,
      energy: musicTracks.energy,
      genre: musicTracks.genre,
      tags: musicTracks.tags,
      durationSec: musicTracks.durationSec,
    })
    .from(musicTracks)
    .where(eq(musicTracks.status, "ready"))
    .orderBy(asc(musicTracks.createdAt))
    .limit(Math.max(1, Math.min(200, limit)));
  return rows.map((row) => ({ ...row, tags: row.tags ?? [] }));
}

/**
 * FFprobe an uploaded music file. Metadata detection is best-effort: a valid
 * track can still be mixed with conservative defaults if probing fails.
 */
export async function probeMusicFile(localPath: string): Promise<{
  durationSec: number;
  formatName: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitrate: number | null;
  sizeBytes: number;
}> {
  try {
    const probe = await probeVideo(localPath);
    if (!probe.hasAudio) {
      throw new AppError("unsupported_media", "That music file has no decodable audio stream.", { status: 415 });
    }
    if (probe.durationSec > config.maxMusicDurationMinutes * 60) {
      throw new AppError(
        "too_large",
        `Music is longer than ${config.maxMusicDurationMinutes} minutes.`,
        { status: 413 },
      );
    }
    return {
      durationSec: probe.durationSec,
      formatName: probe.formatName,
      audioCodec: probe.audioCodec,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      bitrate: probe.bitrate,
      sizeBytes: probe.sizeBytes,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "unsupported_media",
      "Could not read that music file's audio metadata. It may be corrupt or not a real audio file.",
      { detail: (error as Error).message, status: 415 },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Bounded upload concurrency                                          */
/* ------------------------------------------------------------------ */

const uploadSlots = { active: 0, queue: [] as Array<() => void> };

/**
 * Limit how many music uploads stream to B2 at once. Extra uploads wait in a
 * queue (they are never rejected), which keeps a small Render instance safe
 * during a bulk upload without dropping files the user selected.
 */
export async function withMusicUploadSlot<T>(work: () => Promise<T>): Promise<T> {
  const limit = Math.max(1, Math.round(config.musicUploadConcurrency));
  if (uploadSlots.active >= limit) {
    await new Promise<void>((resolve) => uploadSlots.queue.push(resolve));
  }
  uploadSlots.active += 1;
  try {
    return await work();
  } finally {
    uploadSlots.active -= 1;
    uploadSlots.queue.shift()?.();
  }
}

export function newMusicId(): string {
  return `music_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ------------------------------------------------------------------ */
/* B2 library sync (index objects that are not in PostgreSQL yet)     */
/* ------------------------------------------------------------------ */

/** Safety valve so a manual sync can never walk an unbounded bucket. */
const MAX_SYNC_WALK_PAGES = 500;

export type MusicLibrarySyncResult = {
  imported: number;
  alreadyIndexed: number;
  skippedMalformed: number;
  failed: number;
  totalObjects: number;
  /** True when the walk stopped early at MAX_SYNC_WALK_PAGES. */
  truncated: boolean;
};

/**
 * Index B2 objects that are missing from the Music Library table.
 *
 * Read-only against B2 (List + Head only): no audio is downloaded into RAM,
 * nothing is re-uploaded, nothing is deleted, and existing B2 object keys
 * are preserved verbatim. Records already indexed by `b2_object_key` (a
 * unique column) are never duplicated. Imported tracks receive safe
 * defaults — status "ready" so the UI and Auto-match can use them
 * immediately — and can be edited (name, mood, energy, genre, tags) later.
 */
export async function syncMusicLibraryFromB2(): Promise<MusicLibrarySyncResult> {
  if (!b2Configured()) {
    throw new AppError("internal", "Backblaze B2 music storage is not configured.", {
      detail: "Set B2_ENDPOINT, B2_REGION, B2_KEY_ID, B2_APPLICATION_KEY and B2_MUSIC_BUCKET.",
      status: 503,
    });
  }
  const database = getDb();
  const existing = await database.select({ key: musicTracks.b2ObjectKey, id: musicTracks.id }).from(musicTracks);
  const indexedKeys = new Set(existing.map((row) => row.key));
  const takenIds = new Set(existing.map((row) => row.id));

  const result: MusicLibrarySyncResult = {
    imported: 0,
    alreadyIndexed: 0,
    skippedMalformed: 0,
    failed: 0,
    totalObjects: 0,
    truncated: false,
  };

  let token: string | null = null;
  let pagesWalked = 0;
  do {
    const page = await listB2ObjectsPage({ prefix: MUSIC_KEY_PREFIX, continuationToken: token, maxKeys: 1000 });
    pagesWalked += 1;
    for (const object of page.objects) {
      result.totalObjects += 1;
      if (indexedKeys.has(object.key)) {
        result.alreadyIndexed += 1;
        continue;
      }
      // Expected shape is music/{musicId}/{filename}; a bare music/{filename}
      // is still imported (with a generated id). Anything deeper or empty is
      // skipped and counted, never guessed at.
      const segments = object.key.slice(MUSIC_KEY_PREFIX.length).split("/").filter(Boolean);
      if (segments.length < 1 || segments.length > 2) {
        result.skippedMalformed += 1;
        continue;
      }
      const fileName = segments[segments.length - 1];
      const keySegment = segments.length === 2 ? segments[0] : null;
      const id =
        keySegment && /^[a-zA-Z0-9._-]{1,60}$/.test(keySegment) && !takenIds.has(keySegment)
          ? keySegment
          : newMusicId();
      const extension = path.extname(fileName).toLowerCase();
      const displayName = (path.basename(fileName, extension) || fileName).slice(0, 120);
      try {
        // HEAD only: authoritative size/content-type without downloading.
        const head = await headB2Object(object.key);
        if (!head.exists) {
          result.failed += 1;
          console.warn(`[music-sync] object missing between list and head key=${object.key}`);
          continue;
        }
        await database.insert(musicTracks).values({
          id,
          fileName,
          displayName,
          b2ObjectKey: object.key,
          contentType: head.contentType || "application/octet-stream",
          fileSizeBytes: head.sizeBytes ?? object.sizeBytes,
          durationSec: null,
          mood: null,
          energy: null,
          genre: null,
          tags: [],
          status: "ready",
          error: "Imported from B2 — duration and metadata not yet detected. Edit to add mood, energy, genre, or tags.",
        });
        indexedKeys.add(object.key);
        takenIds.add(id);
        result.imported += 1;
        console.info(`[music-sync] imported key=${object.key} id=${id} size=${head.sizeBytes ?? "unknown"}`);
      } catch (error) {
        result.failed += 1;
        console.warn(`[music-sync] import failed key=${object.key}: ${(error as Error).message}`);
      }
    }
    token = page.nextToken;
    if (token && pagesWalked >= MAX_SYNC_WALK_PAGES) {
      result.truncated = true;
      break;
    }
  } while (token);
  return result;
}
