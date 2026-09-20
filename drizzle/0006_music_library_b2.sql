-- Permanent Music Library backed by Backblaze B2 (R2 keeps videos/clips/jobs only).
CREATE TABLE IF NOT EXISTS "music_tracks" (
  "id" text PRIMARY KEY NOT NULL,
  "file_name" text NOT NULL,
  "display_name" text NOT NULL,
  "b2_object_key" text NOT NULL UNIQUE,
  "content_type" text DEFAULT 'audio/mpeg' NOT NULL,
  "file_size_bytes" integer DEFAULT 0 NOT NULL,
  "duration_sec" real,
  "mood" text,
  "energy" text,
  "genre" text,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'uploading' NOT NULL,
  "audio_metadata" jsonb,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "music_tracks_status_idx" ON "music_tracks" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "music_tracks_created_at_idx" ON "music_tracks" USING btree ("created_at");
--> statement-breakpoint
-- Post-render music may come from the B2 Music Library instead of an R2 asset.
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "music_track_id" text;
