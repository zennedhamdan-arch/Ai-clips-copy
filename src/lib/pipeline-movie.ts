import fsp from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clips, jobs } from "@/db/schema";
import { config } from "./config";
import { AppError } from "./errors";
import { buildAssSubtitles, buildCaptionGroups, subtitleOptionsFor } from "./subtitles";
import { extractPoster, probeVideo, renderVerticalClip, transcodeAudio } from "./ffmpeg";
import { clipObjectKey, downloadObjectToFile, headObject, uploadFileToR2 } from "./object-storage";
import { generateNarration, selectMusic, verifyAudioFile, estimateNarrationDurationSec } from "./audio/router";
import { analyzeStory, isScriptComplete, writeExplainerScript } from "./movie-ai";
import { applySceneSelection, narrationWordTiming, targetSecForMode } from "./movie-scenes";
import {
  createSourceAccess,
  ensureProbe,
  ensureTranscript,
  isPersistedTranscript,
  logEvent,
  patchJob,
  persistFailure,
  setStage,
  withJobLifecycle,
} from "./pipeline-core";
import type { ExplainerScript, StoryAnalysisCheckpoint } from "./types";

/**
 * MOVIE EXPLAINER → 9:16 SHORT
 *
 * movie/video → probe + transcription → scene/plot understanding →
 * AI identifies the interesting story → ORIGINAL explainer script
 * (Hook → Setup → What Happened → Why It Matters → Payoff) →
 * relevant scene selection → shared-audio-layer narration →
 * captions/pacing → optional B2/FreetoUse music → FFmpeg → finished short.
 *
 * Checkpoints: ingest → transcript → analysis → script → selection → audio →
 * render → done. Every stage resumes from persisted state; failed scenes are
 * retried individually and never redo successful work.
 */
export async function runMoviePipeline(jobId: string): Promise<void> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new AppError("not_found", `Job ${jobId} disappeared from the database.`);

  await withJobLifecycle(
    jobId,
    async (ctx) => {
      const targetSec = targetSecForMode("movie_explainer", job.targetSec);
      const source = createSourceAccess(job, ctx);

      /* 1+2. Ingest: source + probe -------------------------------------- */
      const probe = await ensureProbe(job, ctx, source);

      /* 3. Transcript checkpoint ----------------------------------------- */
      const hadPersistedTranscript = isPersistedTranscript(job.transcript);
      const transcript = await ensureTranscript(job, ctx, source, probe.durationSec);
      // A fresh transcript invalidates the story analysis + script.
      if (!hadPersistedTranscript && (job.storyAnalysis || job.script)) {
        await patchJob(ctx, { storyAnalysis: null, script: null, scenes: null });
      }

      /* 4. Story understanding checkpoint -------------------------------- */
      type StoryResult = Awaited<ReturnType<typeof analyzeStory>>;
      let story: StoryResult | null = null;
      const savedAnalysis = job.storyAnalysis as StoryAnalysisCheckpoint | null;
      if (savedAnalysis?.variant === "movie" && savedAnalysis.complete && Array.isArray(savedAnalysis.events)) {
        story = {
          characters: savedAnalysis.characters,
          events: savedAnalysis.events,
          arc: savedAnalysis.arc,
          provider: savedAnalysis.provider ?? "checkpoint",
          model: savedAnalysis.model ?? "checkpoint",
        };
        console.info(`[job ${jobId}] stage=story_analysis checkpoint=reused characters=${story.characters.length} events=${story.events.length}`);
        await setStage(ctx, "story_analysis", `Reusing saved story understanding (${story.events.length} events)`, 64);
      } else {
        story = await analyzeStory({
          jobId,
          transcript,
          durationSec: probe.durationSec,
          checkpoint: savedAnalysis?.variant === "movie" ? savedAnalysis : null,
          onCheckpoint: async (checkpoint) => {
            await patchJob(ctx, { storyAnalysis: checkpoint });
          },
          onProgress: async (completed, total, message) => {
            const ratio = total ? completed / total : 0;
            await setStage(ctx, "story_analysis", message, Math.round(57 + ratio * 7));
          },
        });
        await logEvent(ctx, "info", "story_analysis", `Story understood: ${story.characters.length} character(s), ${story.events.length} event(s). ${story.arc.slice(0, 200)}`);
      }

      /* 5. Original explainer script checkpoint --------------------------- */
      let script: ExplainerScript | null = isScriptComplete(job.script) ? job.script : null;
      if (script) {
        console.info(`[job ${jobId}] stage=writing checkpoint=reused title="${script.title}"`);
        await setStage(ctx, "writing", `Reusing saved script: ${script.title}`, 76);
      } else {
        await setStage(ctx, "writing", "Writing the original Hook → Setup → What Happened → Why It Matters → Payoff script…", 74);
        script = await writeExplainerScript({
          jobId,
          transcript,
          characters: story!.characters,
          events: story!.events,
          arc: story!.arc,
          durationSec: probe.durationSec,
          targetSec,
          sourceName: job.sourceName,
          onCheckpoint: async (checkpoint) => {
            await patchJob(ctx, { script: checkpoint });
          },
        });
      }

      /* 6. Scene selection (deterministic, idempotent) -------------------- */
      script = applySceneSelection(script, story!.events, probe.durationSec);
      await patchJob(ctx, { script });
      await logEvent(
        ctx,
        "info",
        "scene_select",
        script.sections.map((section) => `[${section.heading}] ${section.sceneStartSec?.toFixed(1)}s-${section.sceneEndSec?.toFixed(1)}s ${section.sceneTitle ?? section.title}`).join(" | "),
      );

      /* 7. Narration (shared audio layer, per-section checkpoints) -------- */
      const sections = script.sections;
      const narrationFiles: Array<string | null> = new Array<string | null>(sections.length).fill(null);
      let narrationComplete = true;
      for (let index = 0; index < sections.length; index += 1) {
        const section = sections[index];
        const localPath = path.join(ctx.workDir, `narration-${index}.mp3`);
        if (section.narrationKey && (await headObject(section.narrationKey)).exists) {
          await downloadObjectToFile(section.narrationKey, localPath, { kind: "media", jobId, stage: "narration" });
          narrationFiles[index] = localPath;
          console.info(`[job ${jobId}] stage=narration section=${index + 1}/${sections.length} checkpoint=reused key=${section.narrationKey}`);
          continue;
        }
        narrationComplete = false;
        section.audioStatus = "pending";
        section.error = null;
        script!.sections[index] = section;
        await setStage(ctx, "narration", `Generating narration ${index + 1}/${sections.length} (${section.heading})…`, Math.round(88 + (index / sections.length) * 8));
        const generated = await generateNarration({
          text: section.narration,
          outPath: path.join(ctx.workDir, `narration-raw-${index}.wav`),
          jobId,
        });
        const mp3Path = localPath;
        await transcodeAudio({ input: generated.filePath, output: mp3Path });
        const verified = await verifyAudioFile(mp3Path, estimateNarrationDurationSec(section.narration));
        const objectKey = `jobs/${jobId}/audio/narration-${index}.mp3`;
        await uploadFileToR2(mp3Path, objectKey, "audio/mpeg");
        const stored = await headObject(objectKey);
        if (!stored.exists || (stored.sizeBytes !== null && stored.sizeBytes !== verified.bytes)) {
          throw new AppError("internal", "Generated narration could not be verified in Cloudflare R2.", {
            detail: `job=${jobId} section=${index + 1} key=${objectKey} local=${verified.bytes} stored=${stored.sizeBytes ?? "missing"}`,
            retryable: true,
            resumeStage: "narration",
          });
        }
        section.narrationKey = objectKey;
        section.narrationProvider = generated.providerId;
        section.narrationSec = verified.durationSec;
        section.audioStatus = "ready";
        narrationFiles[index] = mp3Path;
        // Per-section checkpoint: a restart retries only the failed section.
        await patchJob(ctx, { script: { ...script } });
        await logEvent(ctx, "info", "narration", `Narration ${index + 1}/${sections.length} ready via ${generated.providerId} (${verified.durationSec.toFixed(1)}s, ${objectKey})`);
      }
      if (narrationComplete) {
        await logEvent(ctx, "info", "narration", "All narration sections reused from R2 checkpoints.");
      }

      /* 8. Render: segments → concat → narration+music mix ---------------- */
      await setStage(ctx, "rendering", `Rendering ${sections.length} scene segments…`);
      const renderSource = await source.getLocalSource();
      const authoritativeSourceObjectKey = source.authoritativeSourceObjectKey();
      if (!authoritativeSourceObjectKey) {
        throw new AppError("source_object_missing", "This job has no durable sourceObjectKey for rendering.", { detail: `job=${jobId} stage=rendering`, status: 410 });
      }
      const renderSourceMetadata = await headObject(authoritativeSourceObjectKey);
      console.info(`[R2 source check] job=${jobId} stage=rendering bucket=${config.r2BucketName} key=${authoritativeSourceObjectKey} exists=${renderSourceMetadata.exists}`);
      if (!renderSourceMetadata.exists) {
        throw new AppError("source_object_missing", "The source video is missing from Cloudflare R2 before rendering.", {
        detail: `job=${jobId} stage=rendering sourceObjectKey=${authoritativeSourceObjectKey}`,
        status: 410,
        });
      }

      const subtitleOpts = subtitleOptionsFor(config.targetWidth, config.targetHeight);
      const segmentPaths: string[] = [];
      const segmentDurations: number[] = [];
      for (let index = 0; index < sections.length; index += 1) {
        const section = sections[index];
        const startSec = section.sceneStartSec ?? 0;
        const endSec = Math.max(startSec + 2, section.sceneEndSec ?? startSec + 20);
        const segmentPath = path.join(ctx.workDir, `seg-${index}.mp4`);
        let subtitlePath: string | undefined;
        try {
          if (job.subtitlesEnabled !== 0) {
            const narrationSec = section.narrationSec && section.narrationSec > 0 ? section.narrationSec : estimateNarrationDurationSec(section.narration);
            const words = narrationWordTiming(section.narration, Math.min(narrationSec, endSec - startSec));
            const groups = buildCaptionGroups(words);
            if (groups.length) {
              subtitlePath = path.join(ctx.workDir, `seg-${index}.ass`);
              await fsp.writeFile(subtitlePath, buildAssSubtitles(groups, subtitleOpts), "utf8");
            }
          }
          await setStage(ctx, "rendering", `Rendering segment ${index + 1}/${sections.length}: ${section.heading}`, Math.round(97 + (index / sections.length) * 2));
          await renderVerticalClip({
            input: renderSource,
            output: segmentPath,
            startSec,
            endSec,
            subtitlePath,
            subtitlesEnabled: Boolean(subtitlePath),
            targetWidth: config.targetWidth,
            targetHeight: config.targetHeight,
            targetFps: config.targetFps,
            crf: config.videoCrf,
            preset: config.videoPreset,
            audioBitrateK: config.audioBitrateK,
            hasAudio: probe.hasAudio,
            framingMode: "crop",
          });
          const stat = await fsp.stat(segmentPath).catch(() => null);
          if (!stat || stat.size < 10_000) throw new AppError("ffmpeg_error", `Segment ${index + 1} rendered missing or empty.`);
          const segmentProbe = await probeVideo(segmentPath);
          segmentPaths.push(segmentPath);
          segmentDurations.push(segmentProbe.durationSec);
        } finally {
          if (subtitlePath) await fsp.rm(subtitlePath, { force: true });
        }
      }

      const bodyPath = path.join(ctx.workDir, "body.mp4");
      const { concatVideos } = await import("./ffmpeg");
      await concatVideos({ inputs: segmentPaths, output: bodyPath, listFile: path.join(ctx.workDir, "segments.txt") });
      const bodyProbe = await probeVideo(bodyPath);
      const offsets: number[] = [];
      let cursor = 0;
      for (const duration of segmentDurations) {
        offsets.push(cursor);
        cursor += duration;
      }

      let music: Awaited<ReturnType<typeof selectMusic>> = null;
      if (job.mediaMode === "auto") {
        music = await selectMusic({
          topic: script.title,
          mood: "cinematic",
          energy: "medium",
          durationSec: bodyProbe.durationSec,
          outPath: path.join(ctx.workDir, "music.mp3"),
          jobId,
        });
        if (music) await logEvent(ctx, "info", "rendering", `Background music: "${music.title}" (${music.providerId}${music.artist ? ` — ${music.artist}` : ""}).`);
      }

      await setStage(ctx, "rendering", "Mixing narration + music into the final short…", 99);
      const finalPath = path.join(ctx.workDir, "final.mp4");
      const { composeFinalShort } = await import("./ffmpeg");
      await composeFinalShort({
        body: bodyPath,
        output: finalPath,
        durationSec: bodyProbe.durationSec,
        narrationParts: sections.map((section, index) => ({ input: narrationFiles[index] as string, startSec: offsets[index] })),
        music: music ? { input: music.filePath, volume: 0.16 } : null,
      });

      const finalProbe = await probeVideo(finalPath);
      const finalStat = await fsp.stat(finalPath);
      if (!finalProbe.hasAudio || finalProbe.durationSec < bodyProbe.durationSec - 2 || finalProbe.durationSec > bodyProbe.durationSec + 2) {
        throw new AppError("ffmpeg_error", "Final explainer failed verification (audio/duration mismatch).", {
          detail: `expected≈${bodyProbe.durationSec.toFixed(1)}s got=${finalProbe.durationSec.toFixed(1)}s hasAudio=${finalProbe.hasAudio}`,
          retryable: true,
        });
      }

      const fileName = "explainer.mp4";
      const objectKey = clipObjectKey(jobId, fileName);
      const posterKey = objectKey.replace(/\.mp4$/, ".jpg");
      await setStage(ctx, "finalizing", "Uploading the finished short to Cloudflare R2…", 99);
      await uploadFileToR2(finalPath, objectKey, "video/mp4");
      const storedFinal = await headObject(objectKey);
      console.info(`[R2 output check] job=${jobId} key=${objectKey} exists=${storedFinal.exists} size=${storedFinal.sizeBytes ?? "unknown"}`);
      if (!storedFinal.exists || (storedFinal.sizeBytes !== null && storedFinal.sizeBytes !== finalStat.size)) {
        throw new AppError("internal", "Finished explainer upload could not be verified in Cloudflare R2.", {
          detail: `job=${jobId} key=${objectKey} local=${finalStat.size} stored=${storedFinal.sizeBytes ?? "missing"}`,
          retryable: true,
        });
      }
      const posterPath = path.join(ctx.workDir, "final.jpg");
      const hasPoster = await extractPoster({ input: finalPath, output: posterPath, atSec: Math.min(3, finalProbe.durationSec / 2), width: 270 });
      let posterStored = false;
      if (hasPoster) {
        try {
          await uploadFileToR2(posterPath, posterKey, "image/jpeg");
          posterStored = true;
        } catch (error) {
          await logEvent(ctx, "warn", "finalizing", `Poster upload failed: ${(error as Error).message}`);
        }
      }

      /* The finished short is a `clips` row so the existing UI, download
         routes and R2 retention all work unchanged. */
      const clipId = `${jobId}-c1`;
      const existing = await db.select().from(clips).where(eq(clips.id, clipId)).limit(1);
      const clipValues = {
        status: "ready" as const,
        title: script.title.slice(0, 200),
        hook: script.logline.slice(0, 200),
        reason: "Original movie explainer — AI commentary over selected scenes.",
        startSec: 0,
        endSec: Number(finalProbe.durationSec.toFixed(2)),
        durationSec: finalProbe.durationSec,
        objectKey,
        posterObjectKey: posterStored ? posterKey : null,
        fileName,
        fileSizeBytes: finalStat.size,
        width: finalProbe.width,
        height: finalProbe.height,
        error: null,
        musicStatus: "complete" as const,
      };
      if (!existing.length) {
        await db.insert(clips).values({ ...clipValues, id: clipId, jobId, clipIndex: 0, score: null });
      } else {
        await db.update(clips).set(clipValues).where(eq(clips.id, clipId));
      }

      await setStage(ctx, "done", `Movie explainer ready (${finalProbe.durationSec.toFixed(0)}s)`, 100);
      await patchJob(ctx, {
        status: "completed",
        stage: "done",
        stageDetail: `${finalProbe.durationSec.toFixed(0)}s original explainer ready: ${script.title}`,
        progress: 100,
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + config.retentionHours * 3600 * 1000),
      });
      console.info(`[job complete] job=${jobId} mode=movie_explainer output=${objectKey} duration=${finalProbe.durationSec.toFixed(1)}s`);
      await logEvent(ctx, "info", "done", `Movie explainer finished: ${script.title} (${finalProbe.durationSec.toFixed(0)}s).`);
    },
    async (error, ctx) => {
      await persistFailure(ctx, error, ["story_analysis", "writing", "scene_select", "narration"]);
    },
  );
}
