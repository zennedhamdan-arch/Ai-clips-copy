-- New job modes (Movie Explainer + Documentary) and their resumable checkpoints.
-- The existing Video -> Shorts ("clips") mode is the default and is untouched.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'clips';
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "topic" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "topic_text" text;
--> statement-breakpoint
-- Desired narration length for movie/documentary jobs (seconds, nullable).
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "target_sec" integer;
--> statement-breakpoint
-- Stage-analysis checkpoint: movie plot understanding, or documentary
-- research + outline. One JSONB document per job, written incrementally.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "story_analysis" jsonb;
--> statement-breakpoint
-- Final original script (movie explainer script or documentary script),
-- including per-section narration checkpoints (R2 keys + durations).
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "script" jsonb;
--> statement-breakpoint
-- Documentary scene plan: per-scene narration, duration, visual prompt,
-- required assets, captions, audio and generation status.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "scenes" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_mode_idx" ON "jobs" USING btree ("mode");
