import fsp from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clips, jobs } from "@/db/schema";
import { config } from "./config";
import { AppError } from "./errors";
import { concatVideos, composeFinalShort, composeScene, extractPoster, generateSceneCard, mediaDurationSeconds, probeVideo, transcodeAudio } from "./ffmpeg";
import { clipObjectKey, downloadObjectToFile, headObject, uploadFileToR2 } from "./object-storage";
import { estimateNarrationDurationSec, generateNarration, selectMusic, verifyAudioFile } from "./audio/router";
import {
  buildOutline,
  buildScenePlan,
  documentarySignature,
  paletteForScene,
  researchTopic,
  writeDocumentaryScript,
  type OutlineDocument,
  type ResearchDocument,
} from "./documentary-ai";
import { isScriptComplete } from "./movie-ai";
import { targetSecForMode } from "./movie-scenes";
import { logEvent, patchJob, persistFailure, setStage, withJobLifecycle } from "./pipeline-core";
import type { DocumentaryScene, ExplainerScript, StoryAnalysisCheckpoint } from "./types";

/**
 * SCRIPT/IDEA → DOCUMENTARY
 *
 * idea/topic → research → outline → original script → scene plan →
 * visual prompts/assets → shared-audio-layer narration → optional music →
 * FFmpeg → finished 9:16 documentary.
 *
 * Every scene tracks: narration, duration, visual prompt, required assets,
 * captions, audio and generation status — persisted in jobs.scenes and
 * checkpointed per scene, so retries only redo failed scenes.
 *
 * Checkpoints: research → outline → script → scenes → assets → audio →
 * render → done.
 *
 * Scene visuals are generated with the built-in procedural FFmpeg asset
 * generator (animated gradient + title card from the scene's visual prompt).
 * The visualPrompt is persisted on every scene, so a real image-generation
 * provider can replace the generator later without touching the pipeline.
 */
export async function runDocumentaryPipeline(jobId: string): Promise<void> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new AppError("not_found", `Job ${jobId} disappeared from the database.`);
  if (!job.topic?.trim()) {
    throw new AppError("bad_request", "Documentary job has no topic.", { status: 400 });
  }
  const topic = job.topic.trim().replace(/\s+/g, " ");
  const targetSec = targetSecForMode("documentary", job.targetSec);

  await withJobLifecycle(
    jobId,
    async (ctx) => {
      /* 1. Research checkpoint ------------------------------------------- */
      const signature = documentarySignature(topic, job.topicText);
      const saved = job.storyAnalysis as StoryAnalysisCheckpoint | null;
      const savedResearch = saved?.variant === "documentary" && saved.signature === signature && saved.research ? saved : null;
      let research: ResearchDocument;
      if (savedResearch) {
        research = savedResearch.research!;
        console.info(`[job ${jobId}] stage=researching checkpoint=reused keyPoints=${research.keyPoints.length}`);
        await setStage(ctx, "researching", "Reusing saved research", 14);
      } else {
        await setStage(ctx, "researching", `Researching "${topic}"…`, 8);
        const result = await researchTopic({ jobId, topic, material: job.topicText });
        research = result.research;
        const checkpoint: StoryAnalysisCheckpoint = {
          version: 1,
          variant: "documentary",
          signature,
          chunks: [],
          characters: [],
          events: [],
          arc: research.summary,
          complete: false,
          research,
          provider: result.provider,
          model: result.model,
          updatedAt: new Date().toISOString(),
        };
        await patchJob(ctx, { storyAnalysis: checkpoint });
        await logEvent(ctx, "info", "researching", `Research complete via ${result.provider}: ${research.keyPoints.length} key point(s). ${research.summary.slice(0, 160)}`);
      }

      /* 2. Outline checkpoint (stored inside the research document) ------ */
      let outline: OutlineDocument;
      if (savedResearch?.research?.outline) {
        outline = savedResearch.research.outline;
        console.info(`[job ${jobId}] stage=outlining checkpoint=reused sections=${outline.sections.length}`);
        await setStage(ctx, "outlining", "Reusing saved outline", 24);
      } else {
        await setStage(ctx, "outlining", `Building a ${config.docMinScenes}-${config.docMaxScenes} scene outline…`, 20);
        const result = await buildOutline({ jobId, topic, research, targetSec });
        outline = result.outline;
        const checkpoint: StoryAnalysisCheckpoint = {
          version: 1,
          variant: "documentary",
          signature,
          chunks: [],
          characters: [],
          events: [],
          arc: research.summary,
          complete: false,
          research: { ...research, outline },
          provider: result.provider,
          model: result.model,
          updatedAt: new Date().toISOString(),
        };
        await patchJob(ctx, { storyAnalysis: checkpoint });
        await logEvent(ctx, "info", "outlining", `Outline ready via ${result.provider}: ${outline.sections.map((section) => section.heading).join(" → ")}`);
      }

      /* 3. Original script checkpoint ------------------------------------- */
      let script: ExplainerScript | null = isScriptComplete(job.script) ? job.script : null;
      if (script) {
        console.info(`[job ${jobId}] stage=writing checkpoint=reused title="${script.title}"`);
        await setStage(ctx, "writing", `Reusing saved script: ${script.title}`, 76);
      } else {
        await setStage(ctx, "writing", "Writing the original documentary narration…", 44);
        script = await writeDocumentaryScript({
          jobId,
          topic,
          research,
          outline,
          targetSec,
          onCheckpoint: async (checkpoint) => {
            await patchJob(ctx, { script: checkpoint });
          },
        });
      }

      /* 4. Scene plan checkpoint ------------------------------------------ */
      const savedScenes = Array.isArray(job.scenes) ? job.scenes : null;
      let scenes: DocumentaryScene[] | null = savedScenes
        && savedScenes.length === script.sections.length
        && savedScenes.every((scene, index) => scene.index === index && typeof scene.narration === "string")
          ? savedScenes
          : null;
      if (scenes) {
        const readyAssets = scenes.filter((scene) => scene.assetStatus === "ready").length;
        const readyAudio = scenes.filter((scene) => scene.audio.status === "ready").length;
        console.info(`[job ${jobId}] stage=scene_plan checkpoint=reused scenes=${scenes.length} assetsReady=${readyAssets} audioReady=${readyAudio}`);
        await setStage(ctx, "scene_plan", "Reusing saved scene plan", 48);
      } else {
        await setStage(ctx, "scene_plan", `Planning ${script.sections.length} scenes…`, 40);
        scenes = buildScenePlan(script);
        await patchJob(ctx, { scenes });
        await logEvent(ctx, "info", "scene_plan", `Scene plan: ${scenes.map((scene) => `${scene.heading} (${scene.targetSec}s, ${scene.audio.status}/${scene.assetStatus})`).join(" | ")}`);
      }

      /* 5. Assets checkpoint (procedural FFmpeg scene cards) -------------- */
      const cardPaths: Array<string | null> = new Array<string | null>(scenes.length).fill(null);
      const cardDurations: Array<number | null> = new Array<number | null>(scenes.length).fill(null);
      for (let index = 0; index < scenes.length; index += 1) {
        const scene = scenes[index];
        const cardPath = path.join(ctx.workDir, `scene-${index}.mp4`);
        if (scene.assetStatus === "ready" && scene.assetKey && (await headObject(scene.assetKey)).exists) {
          await downloadObjectToFile(scene.assetKey, cardPath, { kind: "media", jobId, stage: "assets" });
          cardPaths[index] = cardPath;
          cardDurations[index] = await mediaDurationSeconds(cardPath).catch(() => 0);
          console.info(`[job ${jobId}] stage=assets scene=${index + 1}/${scenes.length} checkpoint=reused key=${scene.assetKey}`);
          continue;
        }
        scene.assetStatus = "pending";
        scene.assetError = null;
        scenes[index] = scene;
        await setStage(ctx, "assets", `Generating scene visual ${index + 1}/${scenes.length}: ${scene.heading}`, Math.round(58 + (index / scenes.length) * 5));
        await generateSceneCard({
          output: cardPath,
          durationSec: scene.targetSec,
          title: scene.heading,
          subtitle: topic.length > 64 ? `${topic.slice(0, 61)}…` : topic,
          width: config.targetWidth,
          height: config.targetHeight,
          fps: config.targetFps,
          palette: paletteForScene(scene),
        });
        const cardProbe = await probeVideo(cardPath);
        if (!cardProbe.hasVideo || cardProbe.durationSec < 1) {
          throw new AppError("ffmpeg_error", `Scene ${index + 1} visual failed verification.`, { retryable: true, resumeStage: "assets" });
        }
        const objectKey = `jobs/${jobId}/assets/scene-${index}.mp4`;
        await uploadFileToR2(cardPath, objectKey, "video/mp4");
        const stored = await headObject(objectKey);
        if (!stored.exists) {
          throw new AppError("internal", "Scene visual could not be verified in Cloudflare R2.", {
            detail: `job=${jobId} scene=${index + 1} key=${objectKey}`,
            retryable: true,
            resumeStage: "assets",
          });
        }
        scene.assetKey = objectKey;
        scene.assetStatus = "ready";
        cardPaths[index] = cardPath;
        cardDurations[index] = cardProbe.durationSec;
        await patchJob(ctx, { scenes: [...scenes] });
        await logEvent(ctx, "info", "assets", `Scene ${index + 1}/${scenes.length} visual ready (${cardProbe.durationSec.toFixed(1)}s, ${objectKey})`);
      }

      /* 6. Narration checkpoint (shared audio layer, per scene) ----------- */
      const narrationPaths: Array<string | null> = new Array<string | null>(scenes.length).fill(null);
      for (let index = 0; index < scenes.length; index += 1) {
        const scene = scenes[index];
        const narrationPath = path.join(ctx.workDir, `narration-${index}.mp3`);
        if (scene.audio.status === "ready" && scene.audio.key && (await headObject(scene.audio.key)).exists) {
          await downloadObjectToFile(scene.audio.key, narrationPath, { kind: "media", jobId, stage: "narration" });
          narrationPaths[index] = narrationPath;
          console.info(`[job ${jobId}] stage=narration scene=${index + 1}/${scenes.length} checkpoint=reused key=${scene.audio.key}`);
          continue;
        }
        scene.audio = { status: "pending", provider: null, key: null, durationSec: null, error: null };
        scenes[index] = scene;
        await setStage(ctx, "narration", `Generating narration ${index + 1}/${scenes.length} (${scene.heading})…`, Math.round(88 + (index / scenes.length) * 7));
        const generated = await generateNarration({
          text: scene.narration,
          outPath: path.join(ctx.workDir, `narration-raw-${index}.wav`),
          jobId,
        });
        const mp3Path = narrationPath;
        await transcodeAudio({ input: generated.filePath, output: mp3Path });
        const verified = await verifyAudioFile(mp3Path, estimateNarrationDurationSec(scene.narration));
        const objectKey = `jobs/${jobId}/audio/scene-${index}.mp3`;
        await uploadFileToR2(mp3Path, objectKey, "audio/mpeg");
        const stored = await headObject(objectKey);
        if (!stored.exists || (stored.sizeBytes !== null && stored.sizeBytes !== verified.bytes)) {
          throw new AppError("internal", "Generated narration could not be verified in Cloudflare R2.", {
            detail: `job=${jobId} scene=${index + 1} key=${objectKey}`,
            retryable: true,
            resumeStage: "narration",
          });
        }
        scene.audio = { status: "ready", provider: generated.providerId, key: objectKey, durationSec: verified.durationSec, error: null };
        narrationPaths[index] = mp3Path;
        await patchJob(ctx, { scenes: [...scenes] });
        await logEvent(ctx, "info", "narration", `Narration ${index + 1}/${scenes.length} ready via ${generated.providerId} (${verified.durationSec.toFixed(1)}s).`);
      }

      /* 7. Render: scene composites → concat → optional music mix --------- */
      await setStage(ctx, "rendering", `Compositing ${scenes.length} scenes…`, 96);
      const renderedPaths: string[] = [];
      for (let index = 0; index < scenes.length; index += 1) {
        const scene = scenes[index];
        const cardPath = cardPaths[index] as string;
        const narrationPath = narrationPaths[index] as string;
        const finalDurationSec = Math.max(4, (scene.audio.durationSec ?? scene.targetSec) + 1.2);
        const sceneOutput = path.join(ctx.workDir, `scenerender-${index}.mp4`);
        await setStage(ctx, "rendering", `Compositing scene ${index + 1}/${scenes.length}: ${scene.heading}`, Math.round(96 + (index / scenes.length) * 1.5));
        await composeScene({
          card: cardPath,
          cardDurationSec: cardDurations[index] ?? scene.targetSec,
          narration: narrationPath,
          output: sceneOutput,
          finalDurationSec,
          crf: config.videoCrf,
          preset: config.videoPreset,
        });
        const renderedProbe = await probeVideo(sceneOutput);
        if (!renderedProbe.hasVideo || !renderedProbe.hasAudio) {
          throw new AppError("ffmpeg_error", `Scene ${index + 1} composite failed verification.`, { retryable: true, resumeStage: "rendering" });
        }
        renderedPaths.push(sceneOutput);
      }

      const bodyPath = path.join(ctx.workDir, "body.mp4");
      await concatVideos({ inputs: renderedPaths, output: bodyPath, listFile: path.join(ctx.workDir, "scenes.txt") });
      const bodyProbe = await probeVideo(bodyPath);

      let music: Awaited<ReturnType<typeof selectMusic>> = null;
      if (job.mediaMode === "auto") {
        music = await selectMusic({
          topic,
          mood: research.themes[0] ?? "documentary",
          energy: "low",
          durationSec: bodyProbe.durationSec,
          outPath: path.join(ctx.workDir, "music.mp3"),
          jobId,
        });
        if (music) await logEvent(ctx, "info", "rendering", `Background music: "${music.title}" (${music.providerId}${music.artist ? ` — ${music.artist}` : ""}).`);
      }

      await setStage(ctx, "rendering", "Mixing the final documentary…", 99);
      const finalPath = path.join(ctx.workDir, "final.mp4");
      await composeFinalShort({
        body: bodyPath,
        output: finalPath,
        durationSec: bodyProbe.durationSec,
        narrationParts: [],
        music: music ? { input: music.filePath, volume: 0.15 } : null,
      });
      const finalProbe = await probeVideo(finalPath);
      const finalStat = await fsp.stat(finalPath);
      if (!finalProbe.hasVideo || finalProbe.durationSec < bodyProbe.durationSec - 2 || finalProbe.durationSec > bodyProbe.durationSec + 2) {
        throw new AppError("ffmpeg_error", "Final documentary failed verification.", {
          detail: `expected≈${bodyProbe.durationSec.toFixed(1)}s got=${finalProbe.durationSec.toFixed(1)}s hasVideo=${finalProbe.hasVideo}`,
          retryable: true,
        });
      }

      const fileName = "documentary.mp4";
      const objectKey = clipObjectKey(jobId, fileName);
      const posterKey = objectKey.replace(/\.mp4$/, ".jpg");
      await setStage(ctx, "finalizing", "Uploading the finished documentary to Cloudflare R2…", 99);
      await uploadFileToR2(finalPath, objectKey, "video/mp4");
      const storedFinal = await headObject(objectKey);
      console.info(`[R2 output check] job=${jobId} key=${objectKey} exists=${storedFinal.exists} size=${storedFinal.sizeBytes ?? "unknown"}`);
      if (!storedFinal.exists || (storedFinal.sizeBytes !== null && storedFinal.sizeBytes !== finalStat.size)) {
        throw new AppError("internal", "Finished documentary upload could not be verified in Cloudflare R2.", {
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

      const clipId = `${jobId}-c1`;
      const existing = await db.select().from(clips).where(eq(clips.id, clipId)).limit(1);
      const clipValues = {
        status: "ready" as const,
        title: script.title.slice(0, 200),
        hook: script.logline.slice(0, 200),
        reason: "Original AI documentary: research → outline → script → generated scenes.",
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

      await setStage(ctx, "done", `Documentary ready (${finalProbe.durationSec.toFixed(0)}s)`, 100);
      await patchJob(ctx, {
        status: "completed",
        stage: "done",
        stageDetail: `${finalProbe.durationSec.toFixed(0)}s documentary ready: ${script.title}`,
        progress: 100,
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + config.retentionHours * 3600 * 1000),
      });
      console.info(`[job complete] job=${jobId} mode=documentary output=${objectKey} duration=${finalProbe.durationSec.toFixed(1)}s`);
      await logEvent(ctx, "info", "done", `Documentary finished: ${script.title} (${finalProbe.durationSec.toFixed(0)}s, ${scenes.length} scenes).`);
    },
    async (error, ctx) => {
      await persistFailure(ctx, error, ["researching", "outlining", "writing", "scene_plan", "assets", "narration"]);
    },
  );
}
