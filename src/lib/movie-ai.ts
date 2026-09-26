import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors";
import { extractJson, requestStructuredJson, splitTranscriptForAnalysis, type CallProviderOverride, type StructuredJsonAttemptInfo } from "./analyze";
import { estimateNarrationDurationSec } from "./audio/router";
import type {
  ExplainerScript,
  ExplainerSection,
  ScriptHeading,
  StoryAnalysisCheckpoint,
  StoryCharacter,
  StoryEvent,
  Transcript,
} from "./types";

/**
 * Movie Explainer AI stages:
 *   1. analyzeStory        → characters / events / cause-effect / arc,
 *                            checkpointed per transcript part
 *   2. writeExplainerScript → ORIGINAL Hook → Setup → What Happened →
 *                            Why It Matters → Payoff commentary script
 * Both run through the existing AI provider router (Gemini → OpenRouter →
 * Groq → NVIDIA) with bounded retries and malformed-JSON fallbacks.
 */

const STORY_SYSTEM = "You are a meticulous film analyst. You understand characters, events, relationships, cause and effect, and plot progression. Return strict JSON only — no markdown, no commentary outside JSON.";

const StoryCharacterSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(40).optional(),
  description: z.string().trim().max(240).optional(),
  firstSeenSec: z.coerce.number().nonnegative().nullable().optional(),
});

const StoryEventSchema = z.object({
  startSegment: z.coerce.number().int().nonnegative(),
  endSegment: z.coerce.number().int().nonnegative(),
  summary: z.string().trim().min(4).max(300),
  characters: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
  cause: z.string().trim().max(200).nullable().optional(),
  effect: z.string().trim().max(200).nullable().optional(),
  importance: z.coerce.number().min(1).max(10).optional(),
});

function storyChunkSchema() {
  return z.object({
    characters: z.array(StoryCharacterSchema).max(20).optional(),
    events: z.array(StoryEventSchema).min(1).max(12).optional(),
    arc: z.string().trim().max(400).optional(),
  });
}

type StoryChunkParsed = z.infer<ReturnType<typeof storyChunkSchema>>;

function storySignature(transcript: Transcript): string {
  return [
    "story-v1",
    transcript.segments.length,
    transcript.text.length,
    createHash("sha256").update(transcript.text).digest("hex").slice(0, 20),
    transcript.durationSec.toFixed(3),
  ].join(":");
}

function isCheckpointUsable(checkpoint: StoryAnalysisCheckpoint | null | undefined, signature: string, chunkCount: number): checkpoint is StoryAnalysisCheckpoint {
  return Boolean(
    checkpoint
    && checkpoint.version === 1
    && checkpoint.variant === "movie"
    && checkpoint.signature === signature
    && Array.isArray(checkpoint.chunks)
    && checkpoint.chunks.length === chunkCount,
  );
}

function storyChunkPrompt(chunk: { index: number; block: string; startSec: number; endSec: number }, totalChunks: number): string {
  return [
    `This is transcript part ${chunk.index + 1} of ${totalChunks} (roughly ${chunk.startSec.toFixed(0)}s-${chunk.endSec.toFixed(0)}s) of one continuous movie/video.`,
    "Extract the story understanding for THIS part only, using the [S####] segment indexes shown.",
    "Rules:",
    "- characters: who appears or is discussed (name, role: protagonist/antagonist/supporting/narrator, one short description, firstSeenSec in seconds if known).",
    "- events: 1-8 distinct things that HAPPEN (startSegment/endSegment = inclusive S indexes from this part, summary max 240 chars, characters involved, cause and effect when present, importance 1-10 for the whole story).",
    "- arc: one or two sentences describing how this part moves the story forward.",
    "Describe only what is actually spoken or implied — never invent plot. JSON only: {\"characters\":[...],\"events\":[...],\"arc\":\"...\"}",
    "TRANSCRIPT",
    chunk.block,
  ].join("\n");
}

function mergeCharacters(parts: StoryCharacter[]): StoryCharacter[] {
  const byName = new Map<string, StoryCharacter>();
  for (const character of parts) {
    const key = character.name.trim().toLowerCase();
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, {
        name: character.name.trim(),
        role: (character.role ?? "unknown").trim().toLowerCase() || "unknown",
        description: (character.description ?? "").trim().slice(0, 240),
        firstSeenSec: Number.isFinite(character.firstSeenSec ?? NaN) ? character.firstSeenSec ?? null : null,
      });
    } else {
      if (existing.description.length < 10 && character.description) existing.description = character.description.slice(0, 240);
      if (existing.firstSeenSec === null && character.firstSeenSec !== null) existing.firstSeenSec = character.firstSeenSec;
    }
  }
  return [...byName.values()].slice(0, 40);
}

function eventsOverlap(a: StoryEvent, b: StoryEvent): boolean {
  const overlap = Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
  const shortest = Math.max(1, Math.min(a.endSec - a.startSec, b.endSec - b.startSec));
  return overlap / shortest >= 0.65;
}

export function mergeStoryEvents(parts: StoryEvent[]): StoryEvent[] {
  const merged = [...parts].sort((a, b) => a.startSec - b.startSec);
  const kept: StoryEvent[] = [];
  for (const event of merged) {
    const duplicate = kept.find((other) => eventsOverlap(other, event));
    if (!duplicate) kept.push(event);
    else if (event.importance > duplicate.importance) Object.assign(duplicate, event);
  }
  return kept.slice(0, 80).map((event, index) => ({
    id: `e${index}`,
    startSec: Number(event.startSec.toFixed(2)),
    endSec: Number(event.endSec.toFixed(2)),
    summary: event.summary,
    characters: event.characters,
    cause: event.cause ?? null,
    effect: event.effect ?? null,
    importance: event.importance,
  }));
}

/**
 * Chunked story understanding with per-part checkpoints. Successful parts are
 * persisted as they complete; a restart reuses them and only retries the
 * failed/incomplete parts.
 */
export async function analyzeStory(options: {
  jobId?: string;
  transcript: Transcript;
  durationSec: number;
  checkpoint?: StoryAnalysisCheckpoint | null;
  onCheckpoint?: (checkpoint: StoryAnalysisCheckpoint) => void | Promise<void>;
  onProgress?: (completed: number, total: number, message: string) => void | Promise<void>;
  /** Test hook: replaces the AI provider call (never set in production). */
  callOverride?: CallProviderOverride;
}): Promise<{ characters: StoryCharacter[]; events: StoryEvent[]; arc: string; provider: string; model: string }> {
  const { transcript } = options;
  const signature = storySignature(transcript);
  const chunks = splitTranscriptForAnalysis(transcript);
  if (!chunks.length) {
    throw new AppError("invalid_ai_output", "Transcript is empty, so story analysis is impossible.");
  }
  const checkpoint: StoryAnalysisCheckpoint = isCheckpointUsable(options.checkpoint, signature, chunks.length)
    ? { ...options.checkpoint!, chunks: options.checkpoint!.chunks.map((chunk) => ({ ...chunk })) }
    : {
        version: 1,
        variant: "movie",
        signature,
        chunks: chunks.map((chunk, index) => ({
          index,
          startSegment: chunk.startSegment,
          endSegment: chunk.endSegment,
          status: "pending" as const,
          characters: [],
          events: [],
          arc: "",
        })),
        characters: [],
        events: [],
        arc: "",
        complete: false,
        updatedAt: new Date().toISOString(),
      };

  let failedParts = 0;
  let lastProvider = "unknown";
  let lastModel = "unknown";
  for (const chunk of chunks) {
    const saved = checkpoint.chunks[chunk.index];
    if (saved.status === "succeeded" && saved.events.length > 0) {
      console.info(`[story] job=${options.jobId ?? "unknown"} part=${chunk.index + 1}/${chunks.length} checkpoint=reused events=${saved.events.length}`);
      await options.onProgress?.(chunk.index + 1, chunks.length, `Reused story analysis for part ${chunk.index + 1} of ${chunks.length}`);
      continue;
    }
    await options.onProgress?.(chunk.index, chunks.length, `Understanding the story — part ${chunk.index + 1} of ${chunks.length}…`);
    const prompt = storyChunkPrompt(chunk, chunks.length);
    const schema = {
      type: "object",
      properties: {
        characters: { type: "array", items: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, description: { type: "string" }, firstSeenSec: { type: "number" } } } },
        events: { type: "array", items: { type: "object", properties: { startSegment: { type: "integer" }, endSegment: { type: "integer" }, summary: { type: "string" }, characters: { type: "array", items: { type: "string" } }, cause: { type: "string" }, effect: { type: "string" }, importance: { type: "integer" } } } },
        arc: { type: "string" },
      },
      required: ["events"],
    };
    const suppliedIndexes = [...prompt.matchAll(/\[S(\d+)/g)].map((match) => Number(match[1]));
    const suppliedStart = suppliedIndexes.length ? Math.min(...suppliedIndexes) : chunk.startSegment;
    const suppliedEnd = suppliedIndexes.length ? Math.max(...suppliedIndexes) : chunk.endSegment;

    // S indexes in the prompt are absolute segment indexes; clamp anything
    // out of range into the supplied window so a sloppy model cannot reach
    // another chunk.
    const segmentAt = (index: number) => transcript.segments[Math.max(suppliedStart, Math.min(suppliedEnd, Math.round(index)))];
    const mapStoryEvents = (parsed: StoryChunkParsed): StoryEvent[] =>
      (parsed.events ?? [])
        .map((raw) => {
          const start = segmentAt(raw.startSegment);
          const end = segmentAt(raw.endSegment);
          if (!start || !end || end.end <= start.start) return null;
          return {
            id: "",
            startSec: start.start,
            endSec: end.end,
            summary: raw.summary,
            characters: (raw.characters ?? []).slice(0, 12),
            cause: raw.cause ?? null,
            effect: raw.effect ?? null,
            importance: raw.importance ?? 5,
          } satisfies StoryEvent;
        })
        .filter((event): event is StoryEvent => Boolean(event))
        .filter((event) => event.startSec >= chunk.startSec - 1 && event.endSec <= chunk.endSec + 1);

    // Final acceptance gate for this part: the provider response must pass
    // the story schema AND yield at least one event with usable segment
    // indexes. Anything else (HTTP 200 with a top-level array, NaN segments,
    // unparseable JSON, …) fails the attempt and the router continues with
    // the next provider — a provider is never "successful" just because its
    // response parsed as JSON.
    const validateStoryPart = (value: unknown): unknown => {
      const parsed = storyChunkSchema().parse(value);
      if (!mapStoryEvents(parsed).length) {
        // The schema accepted the payload but no event maps to a valid,
        // forward-going segment range — semantically invalid, not success.
        throw new AppError("invalid_ai_output", "Story part produced no usable events (invalid or missing segment indexes).", {
          reason: "invalid_segment",
          retryable: true,
        });
      }
      return value;
    };

    // Per-attempt attribution: exactly which provider/model produced each
    // pass/fail for this part.
    let partAttempt = 0;
    const onAttempt = ({ provider, model, outcome, reason }: StructuredJsonAttemptInfo) => {
      partAttempt += 1;
      const prefix = `[story] job=${options.jobId ?? "unknown"} part=${chunk.index + 1}/${chunks.length} provider=${provider} model=${model} attempt=${partAttempt}`;
      if (outcome === "passed") console.info(`${prefix} validation=passed`);
      else console.warn(`${prefix} validation=failed reason=${reason ?? "unknown"}`);
    };

    let partProvider = "";
    let partModel = "";
    let partEvents: StoryEvent[] = [];
    let partCharacters: StoryCharacter[] = [];
    let partArc = "";
    try {
      // Provider fallback on FINAL schema validation (strict json_schema on
      // the first pass where supported), plus one bounded repair round for
      // malformed JSON. Providers are tried sequentially.
      const { value: parsedValue, provider, model } = await requestStructuredJsonWithRepair({
        system: STORY_SYSTEM,
        user: prompt,
        schema,
        outputTokenLimit: 1_400,
        jobId: options.jobId,
        label: `story part ${chunk.index + 1}`,
        validate: validateStoryPart,
        onAttempt,
        strictFirstAttempt: true,
        callOverride: options.callOverride,
      });
      // The value already passed validateStoryPart; map it to events.
      const parsed = storyChunkSchema().parse(parsedValue);
      partEvents = mapStoryEvents(parsed);
      partCharacters = (parsed.characters ?? []).map((character) => ({
        name: character.name,
        role: (character.role ?? "unknown").toLowerCase(),
        description: character.description ?? "",
        firstSeenSec: character.firstSeenSec ?? null,
      }));
      partArc = (parsed.arc ?? "").trim();
      partProvider = provider;
      partModel = model;
    } catch (error) {
      const message = (error as Error).message;
      saved.status = "failed";
      saved.error = message.slice(0, 400);
      checkpoint.updatedAt = new Date().toISOString();
      await options.onCheckpoint?.(checkpoint);
      failedParts += 1;
      console.warn(`[story] job=${options.jobId ?? "unknown"} part=${chunk.index + 1}/${chunks.length} failed detail=${message.slice(0, 300)}`);
      continue;
    }
    saved.status = "succeeded";
    saved.events = partEvents;
    saved.characters = partCharacters;
    saved.arc = partArc;
    saved.error = undefined;
    checkpoint.updatedAt = new Date().toISOString();
    checkpoint.provider = partProvider;
    checkpoint.model = partModel;
    lastProvider = partProvider;
    lastModel = partModel;
    await options.onCheckpoint?.(checkpoint);
    console.info(`[story] job=${options.jobId ?? "unknown"} part=${chunk.index + 1}/${chunks.length} saved events=${partEvents.length} characters=${partCharacters.length}`);
    await options.onProgress?.(chunk.index + 1, chunks.length, `Understood part ${chunk.index + 1} of ${chunks.length}`);
  }

  if (failedParts) {
    throw new AppError(
      "rate_limited",
      `Story analysis paused with ${failedParts} transcript part(s) incomplete.`,
      {
        detail: "Completed parts are saved. Retry this job to finish only the failed part(s).",
        status: 503,
        retryable: true,
        resumeStage: "story_analysis",
      },
    );
  }

  const allCharacters = checkpoint.chunks.flatMap((chunk) => chunk.characters);
  const allEvents = checkpoint.chunks.flatMap((chunk) => chunk.events);
  const characters = mergeCharacters(allCharacters);
  const events = mergeStoryEvents(allEvents);
  const arc = checkpoint.chunks
    .map((chunk) => chunk.arc.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" ")
    .slice(0, 600);
  checkpoint.characters = characters;
  checkpoint.events = events;
  checkpoint.arc = arc;
  checkpoint.complete = true;
  checkpoint.provider = lastProvider;
  checkpoint.model = lastModel;
  checkpoint.updatedAt = new Date().toISOString();
  await options.onCheckpoint?.(checkpoint);
  console.info(`[story] job=${options.jobId ?? "unknown"} complete characters=${characters.length} events=${events.length}`);
  return { characters, events, arc, provider: lastProvider, model: lastModel };
}

export type StructuredJsonRepairResult = {
  value: unknown;
  provider: string;
  model: string;
};

/**
 * requestStructuredJson plus one bounded repair round. Provider fallback is
 * driven by FINAL validation: with `validate`, a provider is accepted only
 * when its extracted JSON passes the application schema — HTTP 200, parseable
 * JSON or a top-level array are not success. Each pass tries the configured
 * providers sequentially; pass 1 uses strict json_schema where the provider
 * supports it (when `strictFirstAttempt`), the repair pass uses json_object.
 */
export async function requestStructuredJsonWithRepair(options: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  outputTokenLimit?: number;
  jobId?: string;
  label?: string;
  /** Final acceptance gate applied to every provider response. */
  validate?: (value: unknown) => unknown;
  /** Per-attempt attribution hook (provider/model/outcome/reason). */
  onAttempt?: (info: StructuredJsonAttemptInfo) => void;
  /** Use strict json_schema on pass 1 (providers without support fall back
   *  to json_object automatically). Default false preserves prior callers. */
  strictFirstAttempt?: boolean;
  /** Test hook: replaces the real provider call (never set in production). */
  callOverride?: CallProviderOverride;
}): Promise<StructuredJsonRepairResult> {
  const run = async (user: string, pass: number): Promise<StructuredJsonRepairResult> => {
    const result = await requestStructuredJson({
      system: options.system,
      user,
      schema: options.schema,
      outputTokenLimit: options.outputTokenLimit,
      mode: options.strictFirstAttempt && pass === 1 ? "json_schema" : "json_object",
      validate: options.validate,
      onAttempt: options.onAttempt,
      callOverride: options.callOverride,
    });
    return { value: extractJson(result.content), provider: result.provider, model: result.model };
  };
  try {
    return await run(options.user, 1);
  } catch (firstError) {
    console.warn(`[ai-json] job=${options.jobId ?? "unknown"} ${options.label ?? "request"} first attempt failed: ${(firstError as Error).message.slice(0, 200)}; retrying with repair instruction`);
    return run(`${options.user}\n\nCORRECTION: Your previous response was not usable. Return ONLY one complete valid JSON object that exactly matches the requested shape — no markdown, no trailing commas, no text outside the JSON.`, 2);
  }
}

/* ------------------------------------------------------------------ */
/* Original explainer script                                           */
/* ------------------------------------------------------------------ */

const SCRIPT_SYSTEM = "You are a veteran short-form documentary narrator. You write ORIGINAL commentary — interpretation, context, and storytelling. You never quote dialogue from the source, never summarize line-by-line, and you return strict JSON only.";

const HEADING_SET: ScriptHeading[] = ["hook", "setup", "what_happened", "why_it_matters", "payoff"];

const SectionSchema = z.object({
  heading: z.enum(["hook", "setup", "what_happened", "why_it_matters", "payoff"]),
  title: z.string().trim().min(1).max(80),
  narration: z.string().trim().min(20).max(700),
  targetSec: z.coerce.number().min(5).max(80).optional(),
  sceneStartSec: z.coerce.number().nonnegative().nullable().optional(),
  sceneEndSec: z.coerce.number().nonnegative().nullable().optional(),
  sceneTitle: z.string().trim().max(80).nullable().optional(),
});

const ScriptSchema = z.object({
  title: z.string().trim().min(3).max(90),
  logline: z.string().trim().min(8).max(200),
  sections: z.array(SectionSchema).min(3).max(7),
});

export function explainerScriptPrompt(options: {
  durationSec: number;
  targetSec: number;
  characters: StoryCharacter[];
  events: StoryEvent[];
  arc: string;
  sourceName: string;
}): string {
  const characterLines = options.characters.slice(0, 14).map((character) => `- ${character.name} (${character.role}): ${character.description}`).join("\n") || "- none identified";
  const eventLines = options.events.slice(0, 30).map((event) =>
    `- [${event.startSec.toFixed(0)}s-${event.endSec.toFixed(0)}s] ${event.summary}${event.cause ? ` (because: ${event.cause})` : ""}${event.effect ? ` → ${event.effect}` : ""} [importance ${event.importance}]`,
  ).join("\n") || "- no discrete events identified";
  return [
    `Source video: "${options.sourceName}", ${options.durationSec.toFixed(0)} seconds long.`,
    `Target: a single 9:16 explainer short whose TOTAL narration is roughly ${options.targetSec} seconds.`,
    "",
    "STORY UNDERSTANDING (from the transcript):",
    `Arc: ${options.arc || "not identified"}`,
    "Characters:",
    characterLines,
    "Key events (source-time stamps):",
    eventLines,
    "",
    "WRITE AN ORIGINAL EXPLAINER SCRIPT — commentary and interpretation, not a clip compiler. Structure EXACTLY these five sections, in this order:",
    '1. "hook" — 1-2 sentences that open cold on the most intriguing, surprising, or dangerous moment. Target ~12s.',
    '2. "setup" — who the characters are, where/when, and what the situation is before things go wrong. Target ~18s.',
    '3. "what_happened" — the plot progression with clear cause and effect; keep the causality the viewer can follow. Target ~45s.',
    '4. "why_it_matters" — what this reveals (theme, human behavior, stakes). Interpretation, not summary. Target ~18s.',
    '5. "payoff" — how it ends, plus one final thought-provoker. Target ~12s.',
    "",
    "Rules:",
    "- narration must be original spoken commentary (2nd/3rd person), plain and direct, no quotes from the transcript, no stage directions.",
    "- For each section set sceneStartSec/sceneEndSec to a source range (numeric seconds) that best illustrates it, taken from the event timestamps above; use null when nothing fits.",
    "- sceneTitle: a short label (max 60 chars) for the chosen footage, or null.",
    "JSON only: {\"title\":\"…(max 80)\",\"logline\":\"…(max 160)\",\"sections\":[{\"heading\":\"hook\",\"title\":\"…\",\"narration\":\"…\",\"sceneStartSec\":null,\"sceneEndSec\":null,\"sceneTitle\":null}, …]}",
  ].join("\n");
}

export async function writeExplainerScript(options: {
  jobId?: string;
  transcript: Transcript;
  characters: StoryCharacter[];
  events: StoryEvent[];
  arc: string;
  durationSec: number;
  targetSec: number;
  sourceName: string;
  onCheckpoint?: (script: ExplainerScript) => void | Promise<void>;
}): Promise<ExplainerScript> {
  const prompt = explainerScriptPrompt({
    durationSec: options.durationSec,
    targetSec: options.targetSec,
    characters: options.characters,
    events: options.events,
    arc: options.arc,
    sourceName: options.sourceName,
  });
  const { value, provider, model } = await requestStructuredJsonWithRepair({
    system: SCRIPT_SYSTEM,
    user: prompt,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        logline: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              title: { type: "string" },
              narration: { type: "string" },
              sceneStartSec: { type: "number" },
              sceneEndSec: { type: "number" },
              sceneTitle: { type: "string" },
            },
            required: ["heading", "title", "narration"],
          },
        },
      },
      required: ["title", "logline", "sections"],
    },
    outputTokenLimit: 1_800,
    jobId: options.jobId,
    label: "explainer script",
  });
  const parsed = ScriptSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("invalid_ai_output", "The AI script failed validation after a repair retry.", {
      detail: z.prettifyError(parsed.error).slice(0, 600),
      retryable: true,
      resumeStage: "writing",
    });
  }
  const data = parsed.data;
  // Enforce the canonical five-heading order when the model returned a subset.
  const ordered: ExplainerSection[] = HEADING_SET.map((heading) => {
    const found = data.sections.find((section) => section.heading === heading);
    if (found) {
      return {
        heading: found.heading,
        title: found.title.slice(0, 80),
        narration: found.narration.trim(),
        targetSec: found.targetSec ?? Math.round(estimateNarrationDurationSec(found.narration)),
        visualPrompt: found.sceneTitle ?? found.title,
        sceneStartSec: found.sceneStartSec ?? null,
        sceneEndSec: found.sceneEndSec ?? null,
        sceneTitle: found.sceneTitle ?? null,
        narrationProvider: null,
        narrationKey: null,
        narrationSec: null,
        audioStatus: "pending",
        error: null,
      };
    }
    // Fallback section text so the pipeline always has a complete structure.
    const fallback: Record<ScriptHeading, { title: string; narration: string }> = {
      hook: { title: "The moment everything turns", narration: `Here is the part of "${data.title}" you did not see coming.` },
      setup: { title: "Setting the stage", narration: "To understand why this happened, we first need to understand where it started." },
      what_happened: { title: "What actually happened", narration: "This is where the story takes its decisive turn." },
      why_it_matters: { title: "Why it matters", narration: "Beneath the events, this story is really about choices under pressure." },
      payoff: { title: "How it ends", narration: "And in the end, that is what makes this story worth telling." },
      chapter: { title: "The next chapter", narration: "There is more to this story than what the surface shows." },
    };
    const fallbackSection = fallback[heading];
    return {
      heading,
      title: fallbackSection.title,
      narration: fallbackSection.narration,
      targetSec: Math.round(estimateNarrationDurationSec(fallbackSection.narration)),
      visualPrompt: fallbackSection.title,
      sceneStartSec: null,
      sceneEndSec: null,
      sceneTitle: null,
      narrationProvider: null,
      narrationKey: null,
      narrationSec: null,
      audioStatus: "pending",
      error: null,
    };
  });
  const script: ExplainerScript = {
    version: 1,
    title: data.title,
    logline: data.logline,
    sections: ordered,
    provider,
    model,
    updatedAt: new Date().toISOString(),
  };
  await options.onCheckpoint?.(script);
  console.info(`[script] job=${options.jobId ?? "unknown"} written title="${script.title}" sections=${script.sections.length}`);
  return script;
}

export function isScriptComplete(script: ExplainerScript | null | undefined): boolean {
  return Boolean(
    script
    && script.version === 1
    && script.sections.length >= 5
    && script.sections.every((section) => typeof section.narration === "string" && section.narration.trim().length >= 10),
  );
}
