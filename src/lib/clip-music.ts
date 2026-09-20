import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { clips, jobs, mediaAssets } from "@/db/schema";
import { AppError } from "./errors";
import { mixPostRenderMusic, probeVideo } from "./ffmpeg";
import { deleteObject, downloadObjectToFile, headObject, uploadFileToR2 } from "./object-storage";
import { downloadB2ObjectToFile, headB2Object } from "./b2";
import { getMusicTrack, listSelectionCandidates } from "./music-library";
import { selectMusicForClip, type ClipMusicContext, type MusicSelection } from "./music-selection";

const ROOT = "/tmp/clipforge";

async function readyClip(id: string) {
  const [clip] = await getDb().select().from(clips).where(eq(clips.id, id)).limit(1);
  if (!clip) throw new AppError("not_found", "Clip not found.", { status: 404 });
  if (clip.status !== "ready" || !clip.objectKey) throw new AppError("bad_request", "Only ready, persisted clips can receive music.", { status: 409 });
  if (clip.musicStatus === "applying" || clip.musicStatus === "uploading") throw new AppError("bad_request", "Music is already being applied to this clip.", { status: 409 });
  return clip;
}

export type MusicSourceKind = "r2_asset" | "b2_track";

type MusicSource = {
  kind: MusicSourceKind;
  id: string;
  objectKey: string;
  fileName: string;
  displayName: string;
};

async function resolveMusicSource(clipId: string, options: {
  assetId?: string | null;
  trackId?: string | null;
  auto?: boolean;
}): Promise<{ source: MusicSource; selection: MusicSelection | null; note: string | null }> {
  if (options.trackId) {
    const track = await getMusicTrack(options.trackId);
    if (!track) throw new AppError("not_found", "That Music Library track no longer exists.", { status: 404 });
    if (track.status !== "ready") {
      throw new AppError("bad_request", "That track is still uploading. Wait until it is ready.", { status: 409 });
    }
    return {
      source: { kind: "b2_track", id: track.id, objectKey: track.b2ObjectKey, fileName: track.fileName, displayName: track.displayName },
      selection: null,
      note: null,
    };
  }

  if (options.assetId) {
    const [asset] = await getDb()
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, options.assetId), eq(mediaAssets.category, "music")))
      .limit(1);
    if (!asset) throw new AppError("not_found", "Music asset not found in the Media Library.", { status: 404 });
    return {
      source: { kind: "r2_asset", id: asset.id, objectKey: asset.objectKey, fileName: asset.fileName, displayName: asset.name },
      selection: null,
      note: null,
    };
  }

  if (!options.auto) {
    throw new AppError("bad_request", "Choose a music track or enable automatic selection.", { status: 400 });
  }

  // Automatic selection: metadata only, AI first, deterministic fallback.
  const [clip] = await getDb().select().from(clips).where(eq(clips.id, clipId)).limit(1);
  const [job] = clip ? await getDb().select({ sourceName: jobs.sourceName }).from(jobs).where(eq(jobs.id, clip.jobId)).limit(1) : [];
  const context: ClipMusicContext = {
    clipId,
    title: clip?.title ?? "",
    hook: clip?.hook ?? null,
    reason: clip?.reason ?? null,
    score: clip?.score ?? null,
    durationSec: clip?.durationSec ?? (clip ? clip.endSec - clip.startSec : null),
    sourceName: job?.sourceName ?? null,
  };
  const candidates = await listSelectionCandidates();
  const { selection, note } = await selectMusicForClip({ candidates, context });
  if (!selection) {
    // Nothing suitable: leave the already-rendered clip exactly as it is.
    throw new AppError(
      "not_found",
      note ?? "No suitable music was found for this clip, so it was left without music.",
      { detail: `clipId=${clipId}`, status: 404 },
    );
  }
  const track = await getMusicTrack(selection.trackId);
  if (!track) throw new AppError("not_found", "The selected Music Library track no longer exists.", { status: 404 });
  return {
    source: { kind: "b2_track", id: track.id, objectKey: track.b2ObjectKey, fileName: track.fileName, displayName: track.displayName },
    selection,
    note,
  };
}

export type ApplyClipMusicOptions = {
  assetId?: string | null;
  trackId?: string | null;
  auto?: boolean;
  volume?: number;
};

/**
 * Add background music to an already-rendered clip.
 *
 * This NEVER reruns transcription, analysis, clip selection or source
 * processing: it downloads the retained rendered clip plus one music file,
 * mixes them, uploads a NEW clip object to R2, and only then repoints the
 * database at it. If anything fails the original clip stays live.
 */
export async function applyClipMusic(clipId: string, options: ApplyClipMusicOptions) {
  const clip = await readyClip(clipId);
  const { source, selection, note } = await resolveMusicSource(clipId, options);
  const originalKey = clip.originalObjectKey || clip.objectKey!;
  const volume = Math.max(0.01, Math.min(0.5, options.volume ?? 0.12));
  const attempt = randomUUID();
  const workDir = path.join(ROOT, `clip-music-${clip.id}-${attempt}`);
  const clipPath = path.join(workDir, "clip.mp4");
  const musicPath = path.join(workDir, `music${path.extname(source.fileName) || ".audio"}`);
  const outputPath = path.join(workDir, "mixed.mp4");
  const outputKey = `clips/${clip.jobId}/${clip.id}/music/${Date.now()}-${attempt}.mp4`;
  let uploaded = false;
  const claimed = await getDb().update(clips).set({ musicStatus: "applying", musicError: null })
    .where(and(eq(clips.id, clip.id), ne(clips.musicStatus, "applying"), ne(clips.musicStatus, "uploading")))
    .returning({ id: clips.id });
  if (!claimed.length) throw new AppError("bad_request", "Music is already being applied to this clip.", { status: 409 });
  try {
    const [clipHead, musicHead] = source.kind === "b2_track"
      ? [await headObject(originalKey), await headB2Object(source.objectKey)]
      : [await headObject(originalKey), await headObject(source.objectKey)];
    if (!clipHead.exists) throw new AppError("source_object_missing", "The exact retained no-music clip is missing from R2.", { detail: `clipId=${clip.id}; key=${originalKey}; stage=post_music_download`, status: 410 });
    if (!musicHead.exists) {
      throw new AppError(
        "source_object_missing",
        source.kind === "b2_track"
          ? "The exact selected Music Library track is missing from Backblaze B2."
          : "The exact selected Media Library music object is missing from R2.",
        { detail: `clipId=${clip.id}; musicId=${source.id}; key=${source.objectKey}; stage=post_music_download`, status: 410 },
      );
    }
    await fsp.mkdir(workDir, { recursive: true });
    await Promise.all([
      downloadObjectToFile(originalKey, clipPath, { kind: "clip", label: `retained no-music clip ${clip.id}`, stage: "post_music_download" }),
      source.kind === "b2_track"
        ? downloadB2ObjectToFile(source.objectKey, musicPath)
        : downloadObjectToFile(source.objectKey, musicPath, { kind: "media", label: `Media Library music asset ${source.id}`, stage: "post_music_download" }),
    ]);
    const [clipProbe, musicProbe] = await Promise.all([probeVideo(clipPath), probeVideo(musicPath)]);
    if (!clipProbe.hasVideo || clipProbe.durationSec <= 0) throw new AppError("unsupported_media", "The persisted clip is not a valid video.", { status: 422 });
    if (!musicProbe.hasAudio || musicProbe.durationSec <= 0) throw new AppError("unsupported_media", "The selected music does not contain valid audio.", { status: 422 });
    await mixPostRenderMusic({ clipInput: clipPath, musicInput: musicPath, output: outputPath, durationSec: clipProbe.durationSec, clipHasAudio: clipProbe.hasAudio, volume });
    const outputProbe = await probeVideo(outputPath);
    if (!outputProbe.hasVideo || !outputProbe.hasAudio) throw new AppError("ffmpeg_error", "The mixed clip failed output validation.");
    await getDb().update(clips).set({ musicStatus: "uploading" }).where(eq(clips.id, clip.id));
    await uploadFileToR2(outputPath, outputKey, "video/mp4");
    uploaded = true;
    const outputHead = await headObject(outputKey);
    if (!outputHead.exists || !outputHead.sizeBytes) throw new AppError("internal", "The uploaded mixed clip could not be verified in R2.", { status: 502 });
    const switched = await getDb().update(clips).set({
      originalObjectKey: originalKey, objectKey: outputKey,
      musicAssetId: source.kind === "r2_asset" ? source.id : null,
      musicTrackId: source.kind === "b2_track" ? source.id : null,
      // R2 column stays empty for B2 tracks so R2 cleanup/reference scans
      // never see (or try to delete) a Backblaze object.
      musicObjectKey: source.kind === "r2_asset" ? source.objectKey : null,
      musicVolume: volume, musicEnabled: 1, musicStatus: "complete", musicError: null,
      fileSizeBytes: outputHead.sizeBytes,
    }).where(and(eq(clips.id, clip.id), eq(clips.musicStatus, "uploading"))).returning({ id: clips.id });
    if (!switched.length) throw new AppError("internal", "The mixed clip uploaded, but its database reference could not be switched safely.");
    // Only now is the previous mixed version safe to remove.
    if (clip.musicEnabled && clip.objectKey !== originalKey && clip.objectKey !== outputKey) {
      await deleteObject(clip.objectKey!, "superseded-post-render-music").catch((error) => console.warn("Could not delete superseded mixed clip", error));
    }
    return {
      clipId: clip.id,
      status: "complete",
      objectKey: outputKey,
      music: {
        source: source.kind,
        id: source.id,
        displayName: source.displayName,
        volume,
        selection: selection ? { source: selection.source, reason: selection.reason } : null,
        note,
      },
    };
  } catch (error) {
    if (uploaded) await deleteObject(outputKey, "post-music-db-rollback").catch(() => undefined);
    await getDb().update(clips).set({ musicStatus: "failed", musicError: error instanceof Error ? error.message : String(error) }).where(eq(clips.id, clip.id));
    throw error;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function removeClipMusic(clipId: string) {
  const clip = await readyClip(clipId);
  if (!clip.originalObjectKey || !clip.musicEnabled) return { clipId, status: "none" };
  const claimed = await getDb().update(clips).set({ musicStatus: "applying", musicError: null })
    .where(and(eq(clips.id, clip.id), ne(clips.musicStatus, "applying"), ne(clips.musicStatus, "uploading")))
    .returning({ id: clips.id });
  if (!claimed.length) throw new AppError("bad_request", "Music is already being changed on this clip.", { status: 409 });
  try {
    const originalHead = await headObject(clip.originalObjectKey);
    if (!originalHead.exists) throw new AppError("source_object_missing", "The retained no-music clip is missing from R2; the current working clip was not changed.", { detail: `clipId=${clip.id}; key=${clip.originalObjectKey}; stage=post_music_remove`, status: 410 });
    const oldMixedKey = clip.objectKey!;
    const restored = await getDb().update(clips).set({
      objectKey: clip.originalObjectKey, musicAssetId: null, musicTrackId: null, musicObjectKey: null, musicEnabled: 0,
      musicStatus: "none", musicError: null, musicVolume: null, fileSizeBytes: originalHead.sizeBytes,
    }).where(and(eq(clips.id, clip.id), eq(clips.musicStatus, "applying"))).returning({ id: clips.id });
    if (!restored.length) throw new AppError("internal", "The retained original was verified, but its database reference could not be restored safely.");
    if (oldMixedKey !== clip.originalObjectKey) await deleteObject(oldMixedKey, "removed-post-render-music").catch((error) => console.warn("Could not delete removed mixed clip", error));
    return { clipId, status: "none" };
  } catch (error) {
    await getDb().update(clips).set({ musicStatus: "failed", musicError: error instanceof Error ? error.message : String(error) }).where(eq(clips.id, clip.id));
    throw error;
  }
}
