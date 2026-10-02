import { z } from "zod";
import { AppError } from "./errors";
import { config } from "./config";
import { estimateNarrationDurationSec } from "./audio/router";
import { requestStructuredJsonWithRepair } from "./movie-ai";
import type { DocumentaryScene, ExplainerScript, ExplainerSection, StoryAnalysisCheckpoint } from "./types";

/**
 * Documentary AI stages (idea → research → outline → original script).
 *
 * Every stage has a deterministic fallback so the pipeline can still produce
 * a real video when no AI provider is available (research degrades to the
 * supplied material; the narration degrades to a structured template). The
 * primary path is AI-generated through the shared provider router
 * (Gemini → OpenRouter → Groq → NVIDIA).
 */

/* ------------------------------------------------------------------ */
/* Research                                                            */
/* ------------------------------------------------------------------ */

const RESEARCH_SYSTEM = "You are a factual documentary researcher. Ground everything in the provided material when it exists; otherwise use well-established, widely known knowledge. Never invent sources, statistics, or quotes. Return strict JSON only.";

const ResearchSchema = z.object({
  summary: z.string().trim().min(10).max(400),
  keyPoints: z.array(z.object({
    point: z.string().trim().min(3).max(100),
    detail: z.string().trim().min(8).max(300),
  })).min(3).max(12),
  notableNames: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
  themes: z.array(z.string().trim().min(2).max(60)).max(6).optional(),
});

export type ResearchDocument = {
  summary: string;
  keyPoints: Array<{ point: string; detail: string }>;
  notableNames: string[];
  themes: string[];
};

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20);
}

/** Deterministic research from the topic + pasted material (no AI). */
export function heuristicResearch(topic: string, material: string | null | undefined): ResearchDocument {
  const sentences = splitSentences(material ?? "").slice(0, 10);
  if (sentences.length >= 3) {
    return {
      summary: sentences[0].slice(0, 300),
      keyPoints: sentences.map((sentence) => ({
        point: sentence.slice(0, 90),
        detail: sentence.slice(0, 280),
      })).slice(0, 8),
      notableNames: [],
      themes: [topic].filter(Boolean).map((theme) => theme.slice(0, 60)),
    };
  }
  // No usable material: build a scaffold around the topic itself.
  const point = topic.trim() || "this subject";
  return {
    summary: `A short documentary exploring ${point}.`,
    keyPoints: [
      { point: `What ${point} is and why people care about it`, detail: `The film opens by framing ${point} and the question it raises.` },
      { point: `The key facts behind ${point}`, detail: `The strongest verifiable facts about ${point} are presented next, in plain language.` },
      { point: `How ${point} changed the people involved`, detail: `Concrete consequences and human impact are explored.` },
      { point: `What happens next`, detail: `The film closes on the current state and what to watch for.` },
    ],
    notableNames: [],
    themes: [topic].filter(Boolean).map((theme) => theme.slice(0, 60)),
  };
}

export async function researchTopic(options: {
  jobId?: string;
  topic: string;
  material?: string | null;
}): Promise<{ research: ResearchDocument; provider: string; model: string }> {
  const material = (options.material ?? "").trim().slice(0, 20_000);
  try {
    const { value, provider, model } = await requestStructuredJsonWithRepair({
      system: RESEARCH_SYSTEM,
      user: [
        `TOPIC: ${options.topic}`,
        material
          ? `SOURCE MATERIAL (use it as the primary ground truth):\n${material}`
          : "No source material was provided; use well-established knowledge and be conservative.",
        "Return JSON: {\"summary\":\"…(max 300 chars)\",\"keyPoints\":[{\"point\":\"…\",\"detail\":\"…\"} (5-10 items)],\"notableNames\":[\"…\"],\"themes\":[\"…\"]}",
      ].join("\n\n"),
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          keyPoints: { type: "array", items: { type: "object", properties: { point: { type: "string" }, detail: { type: "string" } }, required: ["point", "detail"] } },
          notableNames: { type: "array", items: { type: "string" } },
          themes: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "keyPoints"],
      },
      outputTokenLimit: 1_200,
      jobId: options.jobId,
      label: "documentary research",
    });
    const parsed = ResearchSchema.parse(value);
    return {
      research: {
        summary: parsed.summary,
        keyPoints: parsed.keyPoints,
        notableNames: (parsed.notableNames ?? []).slice(0, 12),
        themes: (parsed.themes ?? []).slice(0, 6),
      },
      provider,
      model,
    };
  } catch (error) {
    console.warn(`[doc-research] job=${options.jobId ?? "unknown"} AI research unavailable (${(error as Error).message.slice(0, 200)}); using deterministic fallback from the topic/material`);
    const fallback = heuristicResearch(options.topic, material);
    return { research: fallback, provider: "fallback-heuristic", model: "deterministic" };
  }
}

/* ------------------------------------------------------------------ */
/* Outline                                                             */
/* ------------------------------------------------------------------ */

const OUTLINE_SYSTEM = "You are a documentary director. Build a tight, cinematic outline that a short 9:16 video can follow. Return strict JSON only.";

const OutlineSectionSchema = z.object({
  heading: z.string().trim().min(2).max(80),
  keyPoints: z.array(z.string().trim().min(2).max(120)).min(1).max(6),
  targetSec: z.coerce.number().min(config.docMinSceneSec).max(config.docMaxSceneSec).optional(),
});
const OutlineSchema = z.object({
  sections: z.array(OutlineSectionSchema).min(config.docMinScenes).max(config.docMaxScenes),
});

export type OutlineDocument = {
  sections: Array<{ heading: string; keyPoints: string[]; targetSec: number }>;
};

export function heuristicOutline(research: ResearchDocument, targetSec: number): OutlineDocument {
  const points = research.keyPoints.length ? research.keyPoints : [{ point: research.summary, detail: research.summary }];
  const targetCount = Math.max(config.docMinScenes, Math.min(config.docMaxScenes, Math.ceil(targetSec / 24)));
  const perSection = Math.max(1, Math.ceil(points.length / targetCount));
  const sections: OutlineDocument["sections"] = [];
  for (let index = 0; index < points.length && sections.length < targetCount; index += perSection) {
    const group = points.slice(index, index + perSection);
    sections.push({
      heading: group[0].point.slice(0, 70),
      keyPoints: group.map((item) => item.point.slice(0, 110)),
      targetSec: Math.round(targetSec / targetCount),
    });
  }
  return { sections };
}

export async function buildOutline(options: {
  jobId?: string;
  topic: string;
  research: ResearchDocument;
  targetSec: number;
}): Promise<{ outline: OutlineDocument; provider: string; model: string }> {
  try {
    const { value, provider, model } = await requestStructuredJsonWithRepair({
      system: OUTLINE_SYSTEM,
      user: [
        `TOPIC: ${options.topic}`,
        `RESEARCH SUMMARY: ${options.research.summary}`,
        `KEY POINTS: ${options.research.keyPoints.map((item) => item.point).join(" | ")}`,
        `Themes: ${options.research.themes.join(", ") || "n/a"}`,
        `Build ${config.docMinScenes}-${config.docMaxScenes} sections totalling roughly ${options.targetSec}s of narration (each ${config.docMinSceneSec}-${config.docMaxSceneSec}s).`,
        'JSON only: {"sections":[{"heading":"…","keyPoints":["…"],"targetSec":24}, …]}',
      ].join("\n"),
      schema: {
        type: "object",
        properties: {
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                heading: { type: "string" },
                keyPoints: { type: "array", items: { type: "string" } },
                targetSec: { type: "number" },
              },
              required: ["heading", "keyPoints"],
            },
          },
        },
        required: ["sections"],
      },
      outputTokenLimit: 1_000,
      jobId: options.jobId,
      label: "documentary outline",
    });
    const parsed = OutlineSchema.parse(value);
    const fallbackTarget = Math.round(options.targetSec / parsed.sections.length);
    const outline: OutlineDocument = {
      sections: parsed.sections.map((section) => ({
        heading: section.heading,
        keyPoints: section.keyPoints.slice(0, 6),
        targetSec: section.targetSec ?? fallbackTarget,
      })),
    };
    return { outline, provider, model };
  } catch (error) {
    console.warn(`[doc-outline] job=${options.jobId ?? "unknown"} AI outline unavailable (${(error as Error).message.slice(0, 200)}); using deterministic fallback`);
    const fallback = heuristicOutline(options.research, options.targetSec);
    return { outline: fallback, provider: "fallback-heuristic", model: "deterministic" };
  }
}

/* ------------------------------------------------------------------ */
/* Original script                                                     */
/* ------------------------------------------------------------------ */

const SCRIPT_SYSTEM = "You are an award-winning documentary narrator. Write ORIGINAL narration — your own voice, no quotes, no source material copied verbatim. Commentary and storytelling, plain spoken English. Return strict JSON only.";

const DocSectionSchema = z.object({
  heading: z.string().trim().min(2).max(90),
  narration: z.string().trim().min(40).max(900),
  visualPrompt: z.string().trim().min(8).max(220).optional(),
});
const DocScriptSchema = z.object({
  title: z.string().trim().min(3).max(90),
  logline: z.string().trim().min(8).max(220),
  sections: z.array(DocSectionSchema).min(3).max(config.docMaxScenes + 1),
});

export function heuristicScript(topic: string, research: ResearchDocument, outline: OutlineDocument): ExplainerScript {
  const sections: ExplainerSection[] = outline.sections.map((section, index) => {
    const detail = research.keyPoints[index]?.detail ?? section.keyPoints.join(" ");
    const narration = [
      section.heading === outline.sections[0].heading
        ? `This is the story of ${topic}. `
        : "",
      `${section.heading}. ${detail}`,
      index === outline.sections.length - 1 ? ` And that is where ${topic} stands today.` : "",
    ].join(" ").trim();
    return {
      heading: "chapter" as const,
      title: section.heading,
      narration,
      targetSec: section.targetSec,
      visualPrompt: `Cinematic 9:16 visual for: ${section.heading}. Evocative, well-lit, documentary style.`,
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
  return {
    version: 1,
    title: topic.slice(0, 88),
    logline: research.summary.slice(0, 200),
    sections,
    provider: "fallback-heuristic",
    model: "deterministic",
    updatedAt: new Date().toISOString(),
  };
}

export async function writeDocumentaryScript(options: {
  jobId?: string;
  topic: string;
  research: ResearchDocument;
  outline: OutlineDocument;
  targetSec: number;
  onCheckpoint?: (script: ExplainerScript) => void | Promise<void>;
}): Promise<ExplainerScript> {
  try {
    const { value, provider, model } = await requestStructuredJsonWithRepair({
      system: SCRIPT_SYSTEM,
      user: [
        `TOPIC: ${options.topic}`,
        `RESEARCH: ${options.research.summary}`,
        `OUTLINE (${options.outline.sections.length} sections, ~${options.targetSec}s total):`,
        ...options.outline.sections.map((section, index) => `${index + 1}. ${section.heading} (${section.targetSec}s) — ${section.keyPoints.join("; ")}`),
        "Write the original narration for each outline section. The FIRST section is the hook: open with a striking question or fact. The LAST section is the payoff: close the story and leave one final thought.",
        "Each section's narration must be spoken-word commentary of roughly the section's target seconds (about 2.4 words per second).",
        "Also give each section a visualPrompt: one cinematic sentence describing the 9:16 visual that should accompany it (setting, subject, mood, light).",
        'JSON only: {"title":"…(max 88)","logline":"…(max 200)","sections":[{"heading":"…","narration":"…","visualPrompt":"…"}, …]}',
      ].join("\n"),
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
                narration: { type: "string" },
                visualPrompt: { type: "string" },
              },
              required: ["heading", "narration"],
            },
          },
        },
        required: ["title", "logline", "sections"],
      },
      outputTokenLimit: 2_400,
      jobId: options.jobId,
      label: "documentary script",
    });
    const parsed = DocScriptSchema.parse(value);
    const script: ExplainerScript = {
      version: 1,
      title: parsed.title,
      logline: parsed.logline,
      sections: parsed.sections.map((section, index) => {
        const outlineSection = options.outline.sections[index];
        return {
          heading: "chapter" as const,
          title: section.heading,
          narration: section.narration.trim(),
          targetSec: outlineSection?.targetSec ?? Math.round(estimateNarrationDurationSec(section.narration)),
          visualPrompt: (section.visualPrompt ?? `Cinematic 9:16 visual for: ${section.heading}`).slice(0, 220),
          sceneStartSec: null,
          sceneEndSec: null,
          sceneTitle: section.heading,
          narrationProvider: null,
          narrationKey: null,
          narrationSec: null,
          audioStatus: "pending",
          error: null,
        };
      }),
      provider,
      model,
      updatedAt: new Date().toISOString(),
    };
    await options.onCheckpoint?.(script);
    console.info(`[doc-script] job=${options.jobId ?? "unknown"} written title="${script.title}" sections=${script.sections.length} provider=${provider}`);
    return script;
  } catch (error) {
    console.warn(`[doc-script] job=${options.jobId ?? "unknown"} AI script unavailable (${(error as Error).message.slice(0, 200)}); using deterministic fallback script`);
    const fallback = heuristicScript(options.topic, options.research, options.outline);
    await options.onCheckpoint?.(fallback);
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Scene plan + assets                                                 */
/* ------------------------------------------------------------------ */

/** Deterministic scene plan: every scene tracks narration, duration, visual
 *  prompt, required assets, captions, audio and generation status. */
export function buildScenePlan(script: ExplainerScript): DocumentaryScene[] {
  return script.sections.map((section, index) => ({
    index,
    heading: section.title,
    narration: section.narration,
    targetSec: Math.max(config.docMinSceneSec, Math.min(config.docMaxSceneSec, Math.round(section.targetSec || estimateNarrationDurationSec(section.narration)))),
    visualPrompt: section.visualPrompt,
    requiredAssets: [section.visualPrompt],
    captions: section.narration,
    assetKey: null,
    assetStatus: "pending",
    assetError: null,
    audio: { status: "pending", provider: null, key: null, durationSec: null, error: null },
  }));
}

/** Deterministic palette (animated gradient) derived from the visual prompt. */
const SCENE_PALETTES: Array<[string, string]> = [
  ["0x101820", "0x2e5399"],
  ["0x1a2a3a", "0x3a6e65"],
  ["0x2b1d3a", "0x7a4f9e"],
  ["0x1f2937", "0x5b7c99"],
  ["0x2a1a1a", "0x8e5a3a"],
  ["0x10201a", "0x3f7d5e"],
  ["0x1c1c2e", "0x5a5a8e"],
  ["0x26221a", "0x9a8a4a"],
];

export function paletteForScene(scene: { index: number; visualPrompt: string }): [string, string] {
  let hash = 0;
  const source = `${scene.index}:${scene.visualPrompt}`;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }
  return SCENE_PALETTES[hash % SCENE_PALETTES.length];
}

/** Validate a persisted research checkpoint still matches this job's inputs. */
export function researchCheckpointMatches(
  checkpoint: StoryAnalysisCheckpoint | null | undefined,
  topic: string,
  materialHash: string,
): checkpoint is StoryAnalysisCheckpoint {
  return Boolean(
    checkpoint
    && checkpoint.version === 1
    && checkpoint.variant === "documentary"
    && checkpoint.research
    && checkpoint.signature === `doc-research-v1:${topic.length}:${materialHash}`,
  );
}

export function documentarySignature(topic: string, material: string | null | undefined): string {
  const source = material ?? "";
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) >>> 0;
  }
  return `doc-research-v1:${topic.length}:${hash.toString(16)}`;
}

export function assertTopic(topic: unknown): string {
  const value = typeof topic === "string" ? topic.trim().replace(/\s+/g, " ") : "";
  if (value.length < 3) {
    throw new AppError("bad_request", "Give the documentary a topic (at least 3 characters).", { status: 400 });
  }
  if (value.length > 200) {
    throw new AppError("bad_request", "The topic is too long (max 200 characters).", { status: 400 });
  }
  return value;
}
