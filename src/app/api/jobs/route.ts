import { NextResponse } from "next/server";
import { AppError, toErrorPayload } from "@/lib/errors";
import { createJob, ensureRuntime, listJobs } from "@/lib/jobs";
import { classifyVideoSourceUrl } from "@/lib/video-source";
import { normalizeWhisperLanguage } from "@/lib/transcribe";
import { validatePublicVideoUrl } from "@/lib/url-safety";
import { normalizeOutputFormat } from "@/lib/output-format";
import { validateMusicReference } from "@/lib/music";
import { deleteObject } from "@/lib/object-storage";
import { assertTopic } from "@/lib/documentary-ai";
import { normalizeJobMode } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  await ensureRuntime();
  const jobs = await listJobs(12);
  return NextResponse.json({ jobs });
}

/**
 * Create a job:
 *   - mode "documentary"      → from an idea/topic (no video source)
 *   - mode "movie_explainer"  → from a direct media URL
 *   - mode "clips" (default)  → the original Video -> Shorts URL flow
 */
export async function POST(request: Request) {
  let pendingMusicKey: string | null = null;
  try {
    await ensureRuntime();
    const body = (await request.json().catch(() => ({}))) as {
      url?: string;
      topic?: string;
      topicText?: string;
      requestedClips?: number;
      maxClipSec?: number;
      subtitlesEnabled?: boolean;
      language?: string;
      outputFormat?: string;
      musicObjectKey?: string;
      musicFileName?: string;
      mediaMode?: "none" | "manual" | "auto";
      musicAssetIds?: string[];
      soundEffectAssetIds?: string[];
      mode?: string;
      targetSec?: number;
    };

    const mode = normalizeJobMode(body.mode);

    if (mode === "documentary") {
      const topic = assertTopic(body.topic);
      const topicText = typeof body.topicText === "string" ? body.topicText.slice(0, 30_000) : null;
      const jobId = await createJob({
        sourceType: "idea",
        sourceName: topic,
        mode,
        topic,
        topicText,
        targetSec: body.targetSec,
        subtitlesEnabled: body.subtitlesEnabled,
        outputFormat: normalizeOutputFormat(body.outputFormat),
        mediaMode: body.mediaMode,
      });
      return NextResponse.json({ jobId }, { status: 202 });
    }

    const url = (body.url ?? "").trim();
    if (!url) throw new AppError("bad_request", "Paste a video URL first.", { status: 400 });
    if (url.length > 2048) throw new AppError("bad_request", "That URL is too long.", { status: 400 });

    const sourceType = classifyVideoSourceUrl(url);
    const validatedUrl = await validatePublicVideoUrl(url);
    const music = validateMusicReference(body.musicObjectKey, body.musicFileName);
    pendingMusicKey = music.objectKey;

    const fileName = decodeURIComponent(validatedUrl.pathname.split("/").pop() || "video.mp4");
    const jobId = await createJob({
      sourceType,
      sourceName: fileName,
      sourceUrl: validatedUrl.href,
      requestedClips: body.requestedClips,
      maxClipSec: body.maxClipSec,
      subtitlesEnabled: body.subtitlesEnabled,
      language: normalizeWhisperLanguage(body.language) ?? null,
      outputFormat: normalizeOutputFormat(body.outputFormat),
      musicObjectKey: music.objectKey,
      musicFileName: music.fileName,
      mediaMode: body.mediaMode,
      musicAssetIds: body.musicAssetIds,
      soundEffectAssetIds: body.soundEffectAssetIds,
      mode,
      targetSec: body.targetSec,
    });
    pendingMusicKey = null;

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (pendingMusicKey) await deleteObject(pendingMusicKey).catch(() => undefined);
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
