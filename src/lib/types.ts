export type Word = { start: number; end: number; word: string };

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type Transcript = {
  language: string | null;
  durationSec: number;
  text: string;
  segments: TranscriptSegment[];
  words: Word[];
  chunkCount: number;
  model: string;
};

export type ClipCandidate = {
  startSec: number;
  endSec: number;
  /** Present when the AI selected indexed transcript boundaries. */
  startSegment?: number;
  endSegment?: number;
  title: string;
  hook: string;
  reason: string;
  score: number;
};

export type AnalysisCheckpointAttempt = {
  provider: "gemini" | "openrouter" | "groq" | "nvidia";
  model: string;
  attempt: number;
  outcome: "failed" | "succeeded";
  detail: string;
  phase?: "discovery" | "selection";
  chunk?: number;
};

export type AnalysisChunkCheckpoint = {
  index: number;
  startSegment: number;
  endSegment: number;
  startSec: number;
  endSec: number;
  characterCount: number;
  estimatedTokens: number;
  block: string;
  status: "pending" | "succeeded" | "failed";
  candidates: ClipCandidate[];
  attempts: AnalysisCheckpointAttempt[];
  error?: string;
};

/** One resumable JSONB document, keyed by job + deterministic chunk index. */
export type AnalysisCheckpoint = {
  version: 1;
  signature: string;
  chunks: AnalysisChunkCheckpoint[];
  finalClips?: ClipCandidate[];
  selectionComplete: boolean;
  provider?: "gemini" | "openrouter" | "groq" | "nvidia";
  model?: string;
  raw?: string;
  selectionAttempts?: AnalysisCheckpointAttempt[];
  updatedAt: string;
};

export type JobStatus = "queued" | "processing" | "completed" | "failed" | "partial" | "cleanup_pending";

/** Pipeline modes. "clips" is the original Video -> Shorts pipeline. */
export type JobMode = "clips" | "movie_explainer" | "documentary";

export const JOB_MODES: readonly JobMode[] = ["clips", "movie_explainer", "documentary"];

export function normalizeJobMode(value: unknown): JobMode {
  if (value === "clips" || value === "movie_explainer" || value === "documentary") return value;
  return "clips";
}

export type Stage =
  | "queued"
  | "acquiring"
  | "ingesting"
  | "probing"
  | "analyzing_music"
  | "extracting_audio"
  | "transcribing"
  | "preparing_transcript"
  | "analyzing"
  | "ranking"
  | "selecting"
  /* Movie Explainer + Documentary stages */
  | "story_analysis"
  | "researching"
  | "outlining"
  | "writing"
  | "scene_select"
  | "scene_plan"
  | "assets"
  | "narration"
  | "rendering"
  | "finalizing"
  | "done"
  | "failed";

export const STAGE_LABELS: Record<Stage, string> = {
  queued: "Queued",
  acquiring: "Acquiring source video",
  ingesting: "Getting the video",
  probing: "Checking the video",
  analyzing_music: "Analyzing background music",
  extracting_audio: "Extracting audio",
  transcribing: "Transcribing audio",
  preparing_transcript: "Preparing transcript",
  analyzing: "AI is analyzing transcript parts",
  ranking: "Ranking best moments",
  selecting: "Selecting final clips",
  story_analysis: "AI is understanding the story",
  researching: "Researching the topic",
  outlining: "Building the outline",
  writing: "Writing the original script",
  scene_select: "Selecting source scenes",
  scene_plan: "Planning documentary scenes",
  assets: "Generating scene visuals",
  narration: "Generating narration audio",
  rendering: "Cutting vertical clips",
  finalizing: "Finishing up",
  done: "Done",
  failed: "Failed",
};

export const STAGE_WEIGHTS: Record<Exclude<Stage, "done" | "failed">, number> = {
  queued: 1,
  acquiring: 4,
  ingesting: 10,
  probing: 13,
  analyzing_music: 2,
  extracting_audio: 20,
  transcribing: 52,
  preparing_transcript: 55,
  analyzing: 64,
  ranking: 67,
  selecting: 69,
  researching: 12,
  outlining: 22,
  story_analysis: 62,
  writing: 74,
  scene_select: 80,
  scene_plan: 40,
  assets: 58,
  narration: 88,
  rendering: 97,
  finalizing: 99,
};

/* ------------------------------------------------------------------ */
/* Movie Explainer + Documentary checkpoint documents                  */
/* ------------------------------------------------------------------ */

export type StoryCharacter = {
  name: string;
  /** protagonist | antagonist | supporting | narrator | unknown */
  role: string;
  description: string;
  firstSeenSec: number | null;
};

export type StoryEvent = {
  /** Stable id assigned at merge time (e0, e1, …). */
  id: string;
  startSec: number;
  endSec: number;
  summary: string;
  characters: string[];
  cause: string | null;
  effect: string | null;
  /** 1-10, relative to the whole story. */
  importance: number;
};

/**
 * Resumable per-transcript-part story understanding.
 * variant "movie"      → plot/character/cause-effect analysis.
 * variant "documentary"→ research document + outline.
 */
export type StoryAnalysisCheckpoint = {
  version: 1;
  variant: "movie" | "documentary";
  signature: string;
  chunks: Array<{
    index: number;
    startSegment: number;
    endSegment: number;
    status: "pending" | "succeeded" | "failed";
    characters: StoryCharacter[];
    events: StoryEvent[];
    arc: string;
    error?: string;
  }>;
  characters: StoryCharacter[];
  events: StoryEvent[];
  arc: string;
  complete: boolean;
  provider?: string;
  model?: string;
  /** Documentary research document (variant = documentary). */
  research?: {
    summary: string;
    keyPoints: Array<{ point: string; detail: string }>;
    notableNames: string[];
    themes: string[];
    outline?: {
      sections: Array<{ heading: string; keyPoints: string[]; targetSec: number }>;
    } | null;
  } | null;
  updatedAt: string;
};

export type ScriptHeading = "hook" | "setup" | "what_happened" | "why_it_matters" | "payoff" | "chapter";

export type NarrationState = "pending" | "ready" | "failed";

export type ExplainerSection = {
  heading: ScriptHeading;
  title: string;
  /** Original commentary narration (never quotes the source). */
  narration: string;
  /** Intended narration length in seconds. */
  targetSec: number;
  /** Documentary: visual description. Movie: what the scene should show. */
  visualPrompt: string;
  /** Selected source range (movie mode). */
  sceneStartSec: number | null;
  sceneEndSec: number | null;
  sceneTitle: string | null;
  /** Narration generation checkpoint (shared audio layer). */
  narrationProvider: string | null;
  narrationKey: string | null;
  narrationSec: number | null;
  audioStatus: NarrationState;
  error: string | null;
};

export type ExplainerScript = {
  version: 1;
  title: string;
  logline: string;
  sections: ExplainerSection[];
  provider?: string;
  model?: string;
  /** True once narration for every section is checkpointed (resume guard). */
  narrationComplete?: boolean;
  updatedAt: string;
};

/** One documentary scene; persisted incrementally in jobs.scenes. */
export type DocumentaryScene = {
  index: number;
  heading: string;
  narration: string;
  targetSec: number;
  visualPrompt: string;
  /** Prompts for the assets this scene needs (today: one generated visual). */
  requiredAssets: string[];
  /** Text burned into the scene (the narration). */
  captions: string;
  assetKey: string | null;
  assetStatus: NarrationState;
  assetError: string | null;
  audio: {
    status: NarrationState;
    provider: string | null;
    key: string | null;
    durationSec: number | null;
    error: string | null;
  };
};

export type ApiClip = {
  id: string;
  clipIndex: number;
  status: string;
  title: string;
  hook: string | null;
  reason: string | null;
  score: number | null;
  startSec: number;
  endSec: number;
  durationSec: number | null;
  fileSizeBytes: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
  musicAssetId: string | null;
  /** B2 Music Library track used for this version, when any. */
  musicTrackId: string | null;
  musicVolume: number | null;
  musicEnabled: boolean;
  musicStatus: string;
  musicError: string | null;
  playbackUrl: string | null;
  downloadUrl: string | null;
};

export type ApiJobEvent = {
  id: number;
  level: string;
  stage: string;
  message: string;
  createdAt: string;
};

export type ApiJob = {
  id: string;
  status: JobStatus;
  stage: Stage;
  stageLabel: string;
  stageDetail: string | null;
  progress: number;
  mode: JobMode;
  sourceType: string;
  sourceName: string;
  topic: string | null;
  targetSec: number | null;
  /** Movie explainer / documentary script summary for the UI. */
  script: {
    title: string;
    logline: string;
    sections: Array<{
      heading: string;
      title: string;
      narration: string;
      sceneStartSec: number | null;
      sceneEndSec: number | null;
      narrationSec: number | null;
      audioStatus: string;
    }>;
  } | null;
  /** Documentary scene plan summary for the UI. */
  scenes: Array<{
    index: number;
    heading: string;
    targetSec: number;
    visualPrompt: string;
    assetStatus: string;
    audioStatus: string;
  }> | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fileSizeBytes: number | null;
  language: string | null;
  requestedClips: number;
  maxClipSec: number;
  subtitlesEnabled: boolean;
  outputFormat: "9:16" | "1:1" | "16:9";
  musicFileName: string | null;
  mediaMode: "none" | "manual" | "auto";
  musicAssetIds: string[];
  soundEffectAssetIds: string[];
  analysisProvider: string | null;
  analysisModel: string | null;
  error: { message: string; stage: string; detail?: string; kind?: string } | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  clips: ApiClip[];
  events: ApiJobEvent[];
  transcriptPreview: string | null;
};
