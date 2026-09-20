import path from "node:path";
import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { AppError, toErrorPayload } from "@/lib/errors";
import { validateAudioUploadMetadata } from "@/lib/audio-upload-validation";
import { sanitizeFileName } from "@/lib/ingest";
import { ensureRuntime } from "@/lib/jobs";
import { b2Configured, deleteB2Object, downloadB2ObjectToFile, headB2Object, musicObjectKey, uploadRequestToB2 } from "@/lib/b2";
import {
  createMusicTrack,
  finalizeMusicTrack,
  getMusicTrack,
  isMusicTrackStatus,
  listMusicTracksPage,
  musicLibraryStats,
  musicTrackApi,
  newMusicId,
  normalizeEnergy,
  normalizeGenre,
  normalizeMood,
  normalizeMusicTags,
  normalizeOptionalText,
  probeMusicFile,
  withMusicUploadSlot,
} from "@/lib/music-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Paginated Music Library listing. Never loads the whole table. */
export async function GET(request: Request) {
  try {
    await ensureRuntime();
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const page = await listMusicTracksPage({
      query: url.searchParams.get("q"),
      mood: url.searchParams.get("mood"),
      energy: url.searchParams.get("energy"),
      genre: url.searchParams.get("genre"),
      tag: url.searchParams.get("tag"),
      status: isMusicTrackStatus(status) ? status : null,
      page: Number(url.searchParams.get("page")) || 1,
      pageSize: Number(url.searchParams.get("pageSize")) || config.musicPageSize,
    });
    const stats = await musicLibraryStats();
    return NextResponse.json({
      ...page,
      stats,
      storage: { provider: "backblaze-b2", bucket: config.b2MusicBucket, configured: b2Configured() },
      limits: {
        maxMusicUploadMb: config.maxMusicUploadMb,
        maxFilesPerBatch: config.musicMaxFilesPerBatch,
        uploadConcurrency: config.musicUploadConcurrency,
      },
    });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}

/**
 * Upload ONE music file to B2.
 *
 * Bulk uploads send one request per file with bounded concurrency on both the
 * client and this server (`withMusicUploadSlot`), so several files are never
 * buffered in memory at the same time on a small instance.
 */
export async function POST(request: Request) {
  let objectKey: string | null = null;
  let trackId: string | null = null;
  let tempPath: string | null = null;
  try {
    await ensureRuntime();
    if (!b2Configured()) {
      throw new AppError("internal", "Backblaze B2 music storage is not configured.", {
        detail: "Set B2_ENDPOINT, B2_REGION, B2_KEY_ID, B2_APPLICATION_KEY and B2_MUSIC_BUCKET.",
        status: 503,
      });
    }

    const url = new URL(request.url);
    const rawName = request.headers.get("x-file-name") || "";
    let decodedName = rawName;
    try {
      decodedName = decodeURIComponent(rawName);
    } catch {
      // Some clients send a plain filename with a stray percent sign.
    }
    const fileName = sanitizeFileName(decodedName || "music.mp3");
    const contentType = request.headers.get("content-type") || "";
    const validation = validateAudioUploadMetadata(fileName, contentType);
    if (!validation.accepted) {
      throw new AppError("unsupported_media", "Music Library files must be MP3, WAV, M4A, AAC, or OGG.", {
        detail: `Received ${validation.mimeType || "no MIME type"} with extension ${validation.extension || "missing"}.`,
        status: 415,
      });
    }

    const id = newMusicId();
    trackId = id;
    objectKey = musicObjectKey(id, fileName);
    const displayName =
      normalizeOptionalText(url.searchParams.get("name"), 120) ?? path.basename(fileName, validation.extension);

    const track = await createMusicTrack({
      id,
      fileName,
      displayName,
      b2ObjectKey: objectKey,
      contentType: contentType || "application/octet-stream",
      sizeBytes: 0,
      mood: normalizeMood(url.searchParams.get("mood")),
      energy: normalizeEnergy(url.searchParams.get("energy")),
      genre: normalizeGenre(url.searchParams.get("genre")),
      tags: normalizeMusicTags(url.searchParams.get("tags")),
    });
    trackId = track.id;

    const maxBytes = config.maxMusicUploadMb * 1024 * 1024;
    const uploadedBytes = await withMusicUploadSlot(() =>
      uploadRequestToB2({
        body: request.body,
        key: objectKey as string,
        maxBytes,
        contentType: contentType || "application/octet-stream",
      }),
    );

    // Authoritative size comes from B2, not from the request.
    const head = await headB2Object(objectKey);
    const sizeBytes = head.sizeBytes ?? uploadedBytes;

    // FFprobe metadata after upload: duration + format, best effort.
    let durationSec: number | null = null;
    let audioMetadata: Awaited<ReturnType<typeof probeMusicFile>> | null = null;
    try {
      tempPath = path.join(config.storageDir, "music-probe", `${id}${validation.extension || ".mp3"}`);
      await downloadB2ObjectToFile(objectKey, tempPath);
      audioMetadata = await probeMusicFile(tempPath);
      durationSec = audioMetadata.durationSec;
    } catch (error) {
      // A track that uploads cleanly stays usable; only its metadata is missing.
      console.warn(`[music-upload] metadata probe failed for ${id}: ${(error as Error).message}`);
    }

    await finalizeMusicTrack(id, {
      sizeBytes,
      durationSec,
      audioMetadata,
      status: "ready",
      error: audioMetadata ? null : "Duration/format metadata could not be detected.",
    });

    const saved = await getMusicTrack(id);
    if (!saved) throw new AppError("not_found", "The uploaded music track could not be reloaded.", { status: 500 });
    return NextResponse.json({ track: musicTrackApi(saved) }, { status: 201 });
  } catch (error) {
    if (trackId) {
      await finalizeMusicTrack(trackId, {
        status: "failed",
        error: (error as Error).message.slice(0, 500),
      }).catch(() => undefined);
    }
    if (objectKey) await deleteB2Object(objectKey, "failed-music-upload").catch(() => undefined);
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  } finally {
    if (tempPath) await fsp.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
