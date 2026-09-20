import type { AnalysisCheckpoint } from "@/lib/types";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Jobs are the single source of truth for the pipeline.
 * Everything is persisted so that:
 *  - the browser can poll progress across server restarts
 *  - interrupted jobs can be detected and reported honestly
 *  - failures keep enough context to be debugged later
 */
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull().default("queued"), // queued | processing | completed | failed | partial | cleanup_pending
    stage: text("stage").notNull().default("queued"),
    stageDetail: text("stage_detail"),
    progress: integer("progress").notNull().default(0),

    sourceType: text("source_type").notNull(), // upload | direct_url | dropbox | google_drive (`url` is legacy)
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url"),
    /** Local path exists only while a worker is actively processing. */
    filePath: text("file_path"),
    /** Durable source location in Cloudflare R2. */
    sourceObjectKey: text("source_object_key"),
    fileSizeBytes: integer("file_size_bytes"),

    durationSec: real("duration_sec"),
    width: integer("width"),
    height: integer("height"),
    hasAudio: integer("has_audio"),

    language: text("language"),
    transcript: jsonb("transcript"),
    transcriptText: text("transcript_text"),
    /** Resumable per-transcript-part AI analysis and final selection state. */
    analysisCheckpoint: jsonb("analysis_checkpoint").$type<AnalysisCheckpoint>(),

    requestedClips: integer("requested_clips").notNull().default(3),
    maxClipSec: integer("max_clip_sec").notNull().default(45),
    subtitlesEnabled: integer("subtitles_enabled").notNull().default(1),
    outputFormat: text("output_format").notNull().default("9:16"),

    musicObjectKey: text("music_object_key"),
    musicFileName: text("music_file_name"),
    musicAnalysis: jsonb("music_analysis").$type<{
      durationSec: number;
      averageDb: number | null;
      peakTimesSec: number[];
      estimatedBpm: number | null;
      vibe: string;
    }>(),
    /** none | manual | auto; library assets are linked in job_media_assets. */
    mediaMode: text("media_mode").notNull().default("none"),

    analysisProvider: text("analysis_provider"),
    analysisModel: text("analysis_model"),

    error: jsonb("error").$type<{
      message: string;
      stage: string;
      detail?: string;
      kind?: string;
    }>(),

    workDir: text("work_dir"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("jobs_created_at_idx").on(table.createdAt),
    index("jobs_status_idx").on(table.status),
  ],
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: text("id").primaryKey(),
    category: text("category").notNull(), // music | sound_effect
    name: text("name").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    objectKey: text("object_key").notNull().unique(),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    /** Uploads are saved immediately; duration may be enriched later. */
    durationSec: real("duration_sec"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    analysis: jsonb("analysis").$type<{
      durationSec: number;
      averageDb: number | null;
      peakTimesSec: number[];
      estimatedBpm: number | null;
      vibe: string;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("media_assets_category_idx").on(table.category),
    index("media_assets_created_at_idx").on(table.createdAt),
  ],
);

export const jobMediaAssets = pgTable(
  "job_media_assets",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "restrict" }),
    role: text("role").notNull(), // music | sound_effect
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.assetId] }),
    index("job_media_assets_job_idx").on(table.jobId),
    index("job_media_assets_asset_idx").on(table.assetId),
  ],
);

/**
 * Music statuses for a B2 Music Library track.
 * uploading → the object is being written to B2
 * ready     → stored in B2 and probe metadata is available
 * failed    → the upload or metadata probe failed (object is removed)
 */
export const MUSIC_TRACK_STATUSES = ["uploading", "ready", "failed"] as const;
export type MusicTrackStatus = (typeof MUSIC_TRACK_STATUSES)[number];

/**
 * Permanent Music Library. Audio files live ONLY in Backblaze B2 under
 * `music/{musicId}/{filename}`; this table is the metadata index used for
 * search, AI selection (metadata only) and storage accounting.
 */
export const musicTracks = pgTable(
  "music_tracks",
  {
    id: text("id").primaryKey(),
    fileName: text("file_name").notNull(),
    displayName: text("display_name").notNull(),
    /** Durable B2 object key; never an R2 key. */
    b2ObjectKey: text("b2_object_key").notNull().unique(),
    contentType: text("content_type").notNull().default("audio/mpeg"),
    fileSizeBytes: integer("file_size_bytes").notNull().default(0),
    durationSec: real("duration_sec"),
    mood: text("mood"),
    energy: text("energy"), // low | medium | high
    genre: text("genre"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("uploading"),
    /** FFprobe output captured after upload (duration, codec, format, bitrate). */
    audioMetadata: jsonb("audio_metadata").$type<{
      durationSec: number;
      formatName: string | null;
      audioCodec: string | null;
      sampleRate: number | null;
      channels: number | null;
      bitrate: number | null;
    }>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("music_tracks_status_idx").on(table.status),
    index("music_tracks_created_at_idx").on(table.createdAt),
  ],
);

export const clips = pgTable(
  "clips",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    clipIndex: integer("clip_index").notNull(),
    status: text("status").notNull().default("pending"), // pending | rendering | ready | failed
    title: text("title").notNull(),
    hook: text("hook"),
    reason: text("reason"),
    score: integer("score"),
    startSec: real("start_sec").notNull(),
    endSec: real("end_sec").notNull(),
    durationSec: real("duration_sec"),
    /** filePath is retained for backward-compatible migration only. */
    filePath: text("file_path"),
    objectKey: text("object_key"),
    posterObjectKey: text("poster_object_key"),
    /** Non-destructive post-render music state; originalObjectKey is never overwritten. */
    originalObjectKey: text("original_object_key"),
    musicAssetId: text("music_asset_id"),
    /** B2 Music Library track used for this version (R2 media assets use musicAssetId). */
    musicTrackId: text("music_track_id"),
    /**
     * R2 media-asset key only. B2 keys are never written here so R2 cleanup and
     * the storage explorer can never confuse (or delete) B2 music objects.
     */
    musicObjectKey: text("music_object_key"),
    musicVolume: real("music_volume"),
    musicEnabled: integer("music_enabled").notNull().default(0),
    musicStatus: text("music_status").notNull().default("none"), // none | applying | uploading | complete | failed
    musicError: text("music_error"),
    fileName: text("file_name"),
    fileSizeBytes: integer("file_size_bytes"),
    width: integer("width"),
    height: integer("height"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("clips_job_id_idx").on(table.jobId)],
);

/**
 * Human readable debug trail. Rendered in the UI so nothing fails silently.
 */
export const jobEvents = pgTable(
  "job_events",
  {
    id: serial("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    level: text("level").notNull().default("info"), // info | warn | error
    stage: text("stage").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("job_events_job_id_idx").on(table.jobId)],
);

export type JobRow = typeof jobs.$inferSelect;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;
export type ClipRow = typeof clips.$inferSelect;
export type JobEventRow = typeof jobEvents.$inferSelect;
export type MusicTrackRow = typeof musicTracks.$inferSelect;
