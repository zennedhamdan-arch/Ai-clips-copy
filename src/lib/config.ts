import os from "node:os";
import path from "node:path";

/**
 * All runtime tuning lives here. Everything is env-overridable so the same
 * build runs on a tiny cheap cloud box or a bigger one without code changes.
 */
function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export const config = {
  /** Storage -------------------------------------------------------------- */
  storageDir:
    process.env.STORAGE_DIR && process.env.STORAGE_DIR.trim()
      ? process.env.STORAGE_DIR.trim()
      : path.join(os.tmpdir(), "clipforge"),
  /** Database records and R2 objects are deleted after this many hours. */
  retentionHours: num("RETENTION_HOURS", 24),

  /** Cloudflare R2 (all values remain server-only). */
  r2AccountId: process.env.R2_ACCOUNT_ID?.trim() || "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() || "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() || "",
  r2BucketName: process.env.R2_BUCKET_NAME?.trim() || "",
  r2Endpoint: process.env.R2_ENDPOINT?.trim().replace(/\/$/, "") || "",
  frontendUrl: process.env.FRONTEND_URL?.trim().replace(/\/$/, "") || "",

  /**
   * Backblaze B2 — separate permanent Music Library.
   * R2 keeps owning videos/sources/clips/posters/jobs; B2 only stores music.
   * These values are server-only and must never use NEXT_PUBLIC_ names.
   */
  b2Endpoint: process.env.B2_ENDPOINT?.trim().replace(/\/+$/, "") || "",
  b2Region: process.env.B2_REGION?.trim() || "",
  b2KeyId: process.env.B2_KEY_ID?.trim() || "",
  b2ApplicationKey: process.env.B2_APPLICATION_KEY?.trim() || "",
  b2MusicBucket: process.env.B2_MUSIC_BUCKET?.trim() || "clipforge-music",
  /** Parallel music uploads allowed at once (keeps a 512 MB host safe). */
  musicUploadConcurrency: num("MUSIC_UPLOAD_CONCURRENCY", 2),
  /** Upper bound on files accepted by a single bulk upload request. */
  musicMaxFilesPerBatch: num("MUSIC_MAX_FILES_PER_BATCH", 25),
  /** Rows per page for the Music Library and the B2 storage listing. */
  musicPageSize: num("MUSIC_PAGE_SIZE", 24),

  /** Optional admin-only storage explorer credential (server-only). */
  adminPassword: process.env.ADMIN_PASSWORD || "",
  minFreeDiskMb: num("MIN_FREE_DISK_MB", 1500),
  cleanupIntervalMinutes: num("CLEANUP_INTERVAL_MINUTES", 15),

  /** Ingest --------------------------------------------------------------- */
  maxUploadMb: num("MAX_UPLOAD_MB", 400),
  maxMusicUploadMb: num("MAX_MUSIC_UPLOAD_MB", 50),
  maxMusicDurationMinutes: num("MAX_MUSIC_DURATION_MINUTES", 30),
  maxDurationMinutes: num("MAX_DURATION_MINUTES", 120),
  urlDownloadTimeoutSec: num("URL_DOWNLOAD_TIMEOUT_SEC", 600),
  maxUrlSizeMb: num("MAX_URL_SIZE_MB", 800),
  maxUrlRedirects: num("MAX_URL_REDIRECTS", 5),
  /** Direct URL sources are scratch-only unless explicitly retained in R2. */
  persistUrlSources: bool("PERSIST_URL_SOURCES", false),

  /** Transcription -------------------------------------------------------- */
  groqApiKey: process.env.GROQ_API_KEY?.trim() || "",
  groqTranscribeModel: str("GROQ_TRANSCRIBE_MODEL", "whisper-large-v3-turbo"),
  groqBaseUrl: str("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
  /** Groq free tier rejects uploads over 25MB, so audio is chunked. */
  audioChunkSec: num("AUDIO_CHUNK_SEC", 600),
  audioChunkOverlapSec: num("AUDIO_CHUNK_OVERLAP_SEC", 1.5),
  transcribeTimeoutSec: num("TRANSCRIBE_TIMEOUT_SEC", 600),

  /** Clip analysis -------------------------------------------------------- */
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() || "",
  geminiBaseUrl: str("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"),
  // Gemini model availability varies by API account. Require an explicit model
  // instead of silently sending requests to a stale hardcoded default.
  geminiTextModel: process.env.GEMINI_TEXT_MODEL?.trim() || "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || "",
  openrouterBaseUrl: str("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
  // Keep model IDs environment-configurable: account/model access can differ.
  groqTextModel: str("GROQ_TEXT_MODEL", "openai/gpt-oss-20b"),
  openrouterTextModel: str("OPENROUTER_TEXT_MODEL", "google/gemini-2.5-flash"),
  /**
   * NVIDIA NIM is an ADDITIONAL OpenAI-compatible provider (not the
   * foundation). It is only used when ANALYSIS_PROVIDERS lists "nvidia" and
   * both NVIDIA_API_KEY and NVIDIA_TEXT_MODEL are set.
   */
  nvidiaApiKey: process.env.NVIDIA_API_KEY?.trim() || "",
  nvidiaBaseUrl: str("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
  nvidiaTextModel: str("NVIDIA_TEXT_MODEL", "meta/llama-3.3-70b-instruct"),
  /** Direct Gemini first, then OpenRouter, Groq, then NVIDIA. */
  analysisProviders: parseAnalysisProviderList(str("ANALYSIS_PROVIDERS", "gemini,openrouter,groq,nvidia")),
  analysisTimeoutSec: num("ANALYSIS_TIMEOUT_SEC", 180),
  /** One controlled retry for transient or repairable provider failures. */
  analysisMaxRetries: num("ANALYSIS_MAX_RETRIES", 1),
  analysisCandidateMultiplier: num("ANALYSIS_CANDIDATE_MULTIPLIER", 3),
  /** Conservative request budgets. Token estimates intentionally err high. */
  analysisMaxInputTokens: num("ANALYSIS_MAX_INPUT_TOKENS", 4_500),
  analysisPromptReserveTokens: num("ANALYSIS_PROMPT_RESERVE_TOKENS", 1_000),
  analysisDiscoveryOutputTokens: num("ANALYSIS_DISCOVERY_OUTPUT_TOKENS", 1_200),
  analysisSelectionOutputTokens: num("ANALYSIS_SELECTION_OUTPUT_TOKENS", 700),
  analysisGroqTotalTokens: num("ANALYSIS_GROQ_TOTAL_TOKENS", 6_500),
  analysisGroqTokensPerMinute: num("ANALYSIS_GROQ_TOKENS_PER_MINUTE", 8_000),
  /** Legacy character bound remains a secondary guard for existing deployments. */
  analysisTranscriptMaxChars: num("ANALYSIS_TRANSCRIPT_MAX_CHARS", 12_000),
  analysisChunkOverlapSec: num("ANALYSIS_CHUNK_OVERLAP_SEC", 30),
  analysisChunkMaxSec: num("ANALYSIS_CHUNK_MAX_SECONDS", 600),
  analysisGroqSafeChars: num("ANALYSIS_GROQ_SAFE_CHARS", 14_000),
  /**
   * Bounded provider-chain passes for one structured-JSON request (1-3).
   * Pass 1 walks every configured provider once; a second pass runs only
   * when pass 1's failures are deterministic schema problems or transient
   * overload. A single story part can never consume more than
   * maxPasses × providers provider calls.
   */
  analysisChainPasses: Math.max(1, Math.min(3, num("ANALYSIS_CHAIN_PASSES", 2))),
  /**
   * Output budget for story-part analysis. Reasoning models (gpt-oss,
   * gemini-2.5-flash) draw their hidden reasoning tokens from the same
   * max_tokens budget as the JSON answer, so this must leave headroom for
   * both, or Groq fails with json_validate_failed and empty responses.
   */
  analysisStoryOutputTokens: num("ANALYSIS_STORY_OUTPUT_TOKENS", 2_048),
  /**
   * Output budget for the Movie Explainer script (five sections with
   * narration). 1800 truncated real scripts in production; 3200 leaves
   * headroom for reasoning models that share the budget with thinking.
   */
  analysisScriptOutputTokens: num("ANALYSIS_SCRIPT_OUTPUT_TOKENS", 3_200),
  /** Groq gpt-oss models: reasoning budget (minimal|low|medium|high). */
  groqReasoningEffort: str("GROQ_REASONING_EFFORT", "low"),

  /** Shared audio layer (TTS narration + music/SFX) ------------------------ */
  /** Provider order for narration. mock is only honored when AUDIO_MOCK=1. */
  audioTtsProviders: parseAudioProviderList(str("AUDIO_TTS_PROVIDERS", "gemini,openai"), ["gemini", "openai", "mock"]),
  /** Provider order for generated background music. B2 Music Library first. */
  audioMusicProviders: parseAudioProviderList(str("AUDIO_MUSIC_PROVIDERS", "b2,freetouse"), ["b2", "freetouse", "mock"]),
  /** Testing-only offline provider; never enabled in production by default. */
  audioMockEnabled: bool("AUDIO_MOCK", false),
  audioRequestTimeoutSec: num("AUDIO_REQUEST_TIMEOUT_SEC", 180),
  /** Hard cap for music downloads (30 MB). */
  audioMaxMusicBytes: 30 * 1024 * 1024,
  /** Gemini TTS reuses the existing GEMINI_API_KEY integration. */
  ttsGeminiModel: str("TTS_GEMINI_MODEL", "gemini-2.5-flash-preview-tts"),
  ttsGeminiVoice: str("TTS_GEMINI_VOICE", "Puck"),
  /** OpenAI-compatible TTS (real, documented /audio/speech endpoint). */
  openaiApiKey: process.env.OPENAI_API_KEY?.trim() || "",
  openaiTtsBaseUrl: str("OPENAI_TTS_BASE_URL", "https://api.openai.com/v1"),
  openaiTtsModel: str("OPENAI_TTS_MODEL", "tts-1"),
  openaiTtsVoice: str("OPENAI_TTS_VOICE", "alloy"),
  /** Free To Use public music library (no API key required). */
  freetouseBaseUrl: str("FREETOUSE_BASE_URL", "https://api.freetouse.com/v3"),

  /** New mode tuning ------------------------------------------------------- */
  /** Target narration length defaults (UI can override per job). */
  movieTargetSec: num("MOVIE_TARGET_SEC", 90),
  docTargetSec: num("DOC_TARGET_SEC", 120),
  /** Documentary scene bounds. */
  docMinSceneSec: num("DOC_MIN_SCENE_SEC", 6),
  docMaxSceneSec: num("DOC_MAX_SCENE_SEC", 45),
  docMinScenes: num("DOC_MIN_SCENES", 3),
  docMaxScenes: num("DOC_MAX_SCENES", 8),
  /** Narration word-rate used to estimate TTS duration (~145 wpm). */
  narrationWordsPerSec: num("NARRATION_WORDS_PER_SEC", 2.4),

  /** Output --------------------------------------------------------------- */
  targetWidth: num("TARGET_WIDTH", 1080),
  targetHeight: num("TARGET_HEIGHT", 1920),
  squareSize: num("OUTPUT_SQUARE_SIZE", 1080),
  landscapeWidth: num("OUTPUT_LANDSCAPE_WIDTH", 1920),
  landscapeHeight: num("OUTPUT_LANDSCAPE_HEIGHT", 1080),
  targetFps: num("TARGET_FPS", 30),
  videoCrf: num("VIDEO_CRF", 23),
  videoPreset: str("VIDEO_PRESET", "veryfast"),
  audioBitrateK: num("AUDIO_BITRATE_K", 128),

  /** Clip selection ------------------------------------------------------- */
  maxConcurrentJobs: num("MAX_CONCURRENT_JOBS", 1),
  defaultClipCount: num("DEFAULT_CLIP_COUNT", 3),
  maxClipCount: num("MAX_CLIP_COUNT", 8),
  minClipSec: num("MIN_CLIP_SEC", 12),
  maxClipSec: num("MAX_CLIP_SEC", 90),
} as const;

export type AnalysisProvider = "gemini" | "openrouter" | "groq" | "nvidia";

/**
 * Parse ANALYSIS_PROVIDERS. Unknown names are dropped so a typo can never
 * break startup; the canonical order (gemini → openrouter → groq → nvidia)
 * is enforced by providersConfigured, not by the list order.
 */
export function parseAnalysisProviderList(raw: string): AnalysisProvider[] {
  // ANALYSIS_PROVIDERS controls the fallback ORDER: the list is honored
  // exactly as written (trimmed, lowercased, deduped); unknown entries are
  // dropped. Providers that are not configured are still skipped at request
  // time by providersConfigured().
  const valid = new Set<AnalysisProvider>(["gemini", "openrouter", "groq", "nvidia"]);
  const order: AnalysisProvider[] = [];
  const seen = new Set<AnalysisProvider>();
  for (const entry of raw.split(",").map((p) => p.trim().toLowerCase())) {
    if (!entry || !valid.has(entry as AnalysisProvider) || seen.has(entry as AnalysisProvider)) continue;
    seen.add(entry as AnalysisProvider);
    order.push(entry as AnalysisProvider);
  }
  return order;
}

export type AudioTtsProviderId = "gemini" | "openai" | "mock";
export type AudioMusicProviderId = "b2" | "freetouse" | "mock";

export function parseAudioProviderList<T extends string>(raw: string, valid: readonly T[]): T[] {
  return raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is T => (valid as unknown as string[]).includes(p));
}

export function transcriptionConfigured(): boolean {
  return config.groqApiKey.length > 0;
}

export function providersConfigured(): {
  gemini: boolean;
  groq: boolean;
  openrouter: boolean;
  nvidia: boolean;
  order: AnalysisProvider[];
} {
  const configured = {
    gemini: config.geminiApiKey.length > 0 && config.geminiTextModel.length > 0,
    groq: transcriptionConfigured() && config.groqTextModel.length > 0,
    openrouter: config.openrouterApiKey.length > 0 && config.openrouterTextModel.length > 0,
    nvidia: config.nvidiaApiKey.length > 0 && config.nvidiaTextModel.length > 0,
  };
  // ANALYSIS_PROVIDERS sets the exact fallback order. Only providers that are
  // BOTH listed and configured are used; everything else is skipped (and
  // temporary unavailability is handled at request time by the router).
  const order = config.analysisProviders.filter((provider) => configured[provider]);
  return { ...configured, order };
}
