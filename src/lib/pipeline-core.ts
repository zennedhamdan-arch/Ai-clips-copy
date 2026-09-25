import fsp from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobEvents, jobs, type JobRow } from "@/db/schema";
import { AppError } from "./errors";
import { toErrorPayload } from "./errors";
import type { ProbeResult } from "./ffmpeg";
import { validateSource } from "./ingest";
import { createJobDir, removePath } from "./storage";
import { extractAndTranscribe } from "./transcribe";
import { acquireVideoSource, type AcquiredVideo } from "./video-source";
import type { Stage, Transcript } from "./types";
import { STAGE_WEIGHTS } from "./types";

/**
 * Shared plumbing for all pipeline modes (clips / movie_explainer /
 * documentary). Kept behaviour-identical to the original inline helpers in
 * pipeline.ts so the Video -> Shorts pipeline is unaffected.
 */

export type PipelineCtx = {
  jobId: string;
  workDir: string;
};

export async function logEvent(ctx: PipelineCtx, level: "info" | "warn" | "error", stage: string, message: string) {
  await db.insert(jobEvents).values({ jobId: ctx.jobId, level, stage, message: message.slice(0, 2000) });
  if (level === "error") console.error(`[job ${ctx.jobId}] ${stage}: ${message}`);
  else if (level === "warn") console.warn(`[job ${ctx.jobId}] ${stage}: ${message}`);
  else console.log(`[job ${ctx.jobId}] ${stage}: ${message}`);
}

export async function setStage(ctx: PipelineCtx, stage: Stage, detail?: string, progressOverride?: number) {
  const progress =
    progressOverride ??
    (stage in STAGE_WEIGHTS ? STAGE_WEIGHTS[stage as keyof typeof STAGE_WEIGHTS] : undefined);
  await db
    .update(jobs)
    .set({
      stage,
      stageDetail: detail?.slice(0, 500) ?? null,
      progress: progress !== undefined ? Math.max(0, Math.min(99, Math.round(progress))) : undefined,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, ctx.jobId));
}

export async function patchJob(ctx: PipelineCtx, patch: Partial<typeof jobs.$inferInsert>) {
  await db
    .update(jobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(jobs.id, ctx.jobId));
}

export function isPersistedTranscript(value: unknown): value is Transcript {
  if (!value || typeof value !== "object") return false;
  const transcript = value as Partial<Transcript>;
  return typeof transcript.text === "string"
    && Number.isFinite(transcript.durationSec)
    && Array.isArray(transcript.segments)
    && transcript.segments.length > 0
    && Array.isArray(transcript.words);
}

/**
 * Run a pipeline body with the shared lifecycle: create the job work dir,
 * mark processing, clean up local scratch + file references in finally.
 * Failure persistence is delegated to `onFail` (each mode parks the job at
 * its own resumable stage).
 */
export async function withJobLifecycle(
  jobId: string,
  run: (ctx: PipelineCtx) => Promise<void>,
  onFail?: (error: unknown, ctx: PipelineCtx) => Promise<void>,
): Promise<void> {
  const ctx: PipelineCtx = { jobId, workDir: "" };
  try {
    ctx.workDir = await createJobDir(jobId);
    await patchJob(ctx, {
      workDir: ctx.workDir,
      status: "processing",
      error: null,
      startedAt: new Date(),
    });
    await run(ctx);
  } catch (error) {
    if (onFail) await onFail(error, ctx).catch(() => undefined);
    throw error;
  } finally {
    // Local disk is scratch space only. Durable sources and outputs are in R2.
    const [latest] = await db
      .select({ filePath: jobs.filePath })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)
      .catch(() => []);
    if (latest?.filePath) await fsp.rm(latest.filePath, { force: true }).catch(() => undefined);
    if (ctx.workDir) await removePath(ctx.workDir).catch(() => undefined);
    await db
      .update(jobs)
      .set({ filePath: null, workDir: null, updatedAt: new Date() })
      .where(eq(jobs.id, jobId))
      .catch(() => undefined);
  }
}

/** Persist the shared "job failed / paused" terminal state for any mode. */
export async function persistFailure(ctx: PipelineCtx, error: unknown, pausedStages: readonly string[]) {
  const payload = toErrorPayload(error);
  const appError = error instanceof AppError ? error : null;
  const paused = appError && (pausedStages.includes(appError.resumeStage ?? "") ||
    appError.kind === "rate_limited" || appError.kind === "invalid_ai_output" || appError.kind === "audio_error");
  const resumeStage = appError?.resumeStage ?? (paused ? "failed" : "failed");
  await patchJob(ctx, {
    status: "failed",
    stage: (pausedStages.includes(resumeStage) ? resumeStage : "failed") as Stage,
    stageDetail: paused ? `Paused: ${payload.message}` : payload.message,
    error: { message: payload.message, stage: "pipeline", detail: payload.detail, kind: payload.kind },
    finishedAt: new Date(),
    expiresAt: null,
  });
  await logEvent(ctx, "error", "failed", `${payload.message}${payload.detail ? ` — ${payload.detail.slice(0, 800)}` : ""}`);
}

/* ------------------------------------------------------------------ */
/* Lazy source acquisition + probe + transcript checkpoints            */
/* ------------------------------------------------------------------ */

export type SourceAccess = {
  /** Restore the source video to the job work dir exactly once. */
  getLocalSource(): Promise<string>;
  /** The authoritative durable R2 key (job key or persisted URL key). */
  authoritativeSourceObjectKey(): string | null;
};

export function createSourceAccess(job: JobRow, ctx: PipelineCtx): SourceAccess {
  let sourcePath: string | null = null;
  let authoritativeSourceObjectKey = job.sourceObjectKey;
  let inFlight: Promise<string> | null = null;
  const ensureLocalSource = async (): Promise<string> => {
    if (sourcePath) return sourcePath;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const isRemote = job.sourceType !== "upload";
      await setStage(
        ctx,
        "acquiring",
        isRemote ? `Restoring ${job.sourceType.replace("_", " ")} source…` : "Restoring uploaded video from its saved Cloudflare R2 key…",
        4,
      );
      let lastAcquisitionUpdate = 0;
      const acquired: AcquiredVideo = await acquireVideoSource(job, ctx.workDir, (bytes, total) => {
        const now = Date.now();
        if (now - lastAcquisitionUpdate < 1000 && (!total || bytes < total)) return;
        lastAcquisitionUpdate = now;
        const ratio = total ? Math.min(1, bytes / total) : 0;
        void setStage(
          ctx,
          "acquiring",
          `Downloading source… ${(bytes / 1024 / 1024).toFixed(1)}MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)}MB` : ""}`,
          Math.round(4 + ratio * 6),
        ).catch(() => undefined);
      });
      if (job.sourceObjectKey && acquired.durableObjectKey !== job.sourceObjectKey) {
        throw new AppError("internal", "Source storage key changed during acquisition.", {
          detail: `job=${job.id} persisted=${job.sourceObjectKey} acquired=${acquired.durableObjectKey ?? "none"}`,
        });
      }
      authoritativeSourceObjectKey = job.sourceObjectKey ?? acquired.durableObjectKey;
      sourcePath = acquired.localPath;
      await patchJob(ctx, {
        filePath: sourcePath,
        sourceObjectKey: authoritativeSourceObjectKey,
        fileSizeBytes: acquired.sizeBytes,
        sourceName: acquired.fileName,
      });
      await logEvent(
        ctx,
        "info",
        "acquiring",
        `${acquired.provider} source restored (${(acquired.sizeBytes / 1024 / 1024).toFixed(1)}MB), sourceObjectKey=${authoritativeSourceObjectKey ?? "none"}`,
      );
      return sourcePath;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
  return {
    getLocalSource: ensureLocalSource,
    authoritativeSourceObjectKey: () => authoritativeSourceObjectKey,
  };
}

/** Probe checkpoint: reuse DB metadata when present, else ffprobe the source. */
export async function ensureProbe(job: JobRow, ctx: PipelineCtx, source: SourceAccess): Promise<ProbeResult> {
  if (job.durationSec && job.durationSec > 0 && job.hasAudio !== null) {
    const probe: ProbeResult = {
      durationSec: job.durationSec,
      width: job.width,
      height: job.height,
      fps: null,
      hasVideo: true,
      hasAudio: job.hasAudio === 1,
      videoCodec: null,
      audioCodec: null,
      sizeBytes: job.fileSizeBytes ?? 0,
      bitrate: null,
      formatName: null,
      sampleRate: null,
      channels: null,
    };
    console.info(`[job ${job.id}] stage=probing checkpoint=reused duration=${probe.durationSec} sourceObjectKey=${source.authoritativeSourceObjectKey() ?? "none"}`);
    return probe;
  }
  const probeSource = await source.getLocalSource();
  await setStage(ctx, "probing", "Reading video metadata…");
  const probe = await validateSource(probeSource, job.sourceName);
  await patchJob(ctx, {
    durationSec: probe.durationSec,
    width: probe.width,
    height: probe.height,
    hasAudio: probe.hasAudio ? 1 : 0,
    fileSizeBytes: probe.sizeBytes,
  });
  await logEvent(
    ctx,
    "info",
    "probing",
    `${probe.width ?? "?"}x${probe.height ?? "?"} ${probe.videoCodec ?? "?"}/${probe.audioCodec ?? "?"}, ${probe.durationSec.toFixed(1)}s`,
  );
  return probe;
}

/** Transcript checkpoint: reuse the persisted transcript or extract+transcribe. */
export async function ensureTranscript(
  job: JobRow,
  ctx: PipelineCtx,
  source: SourceAccess,
  probeDurationSec: number,
): Promise<Transcript> {
  if (isPersistedTranscript(job.transcript)) {
    console.info(`[job ${job.id}] stage=transcribing checkpoint=reused words=${job.transcript.words.length} segments=${job.transcript.segments.length}`);
    await setStage(ctx, "preparing_transcript", "Reusing saved transcript; continuing from checkpoints…", 55);
    return job.transcript;
  }
  const transcriptionSource = await source.getLocalSource();
  await setStage(ctx, "extracting_audio", "Extracting 16kHz mono audio…");
  const transcribed = await extractAndTranscribe({
    videoPath: transcriptionSource,
    workDir: ctx.workDir,
    durationSec: probeDurationSec,
    language: job.language,
    onProgress: (ratio, message) => {
      const base = STAGE_WEIGHTS.extracting_audio;
      const span = STAGE_WEIGHTS.transcribing - base;
      void setStage(
        ctx,
        ratio < 0.02 ? "extracting_audio" : "transcribing",
        message,
        Math.round(base + Math.min(1, ratio) * span),
      ).catch(() => undefined);
    },
  });
  const transcript = transcribed.transcript;
  // A fresh transcript invalidates any previously persisted clip analysis.
  await patchJob(ctx, {
    transcript,
    transcriptText: transcript.text.slice(0, 200_000),
    language: transcript.language,
    analysisCheckpoint: null,
  });
  await logEvent(
    ctx,
    "info",
    "transcribing",
    `${transcript.words.length} words, ${transcript.segments.length} segments, ${transcript.chunkCount} transcription chunk(s), lang=${transcript.language ?? "?"}`,
  );
  return transcript;
}
