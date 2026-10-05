import test from "node:test";
import assert from "node:assert/strict";

// Every test in this file runs in its own process. The script output budget is
// configured BEFORE the app modules load, so it must apply to config and to
// the provider request — while every other stage's budget stays untouched.
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_TEXT_MODEL = "gemini-test-model";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_TEXT_MODEL = "openrouter-test-model";
process.env.GROQ_API_KEY = "test-groq-key";
process.env.GROQ_TEXT_MODEL = "groq-test-model";
process.env.NVIDIA_API_KEY = "test-nvidia-key";
process.env.NVIDIA_TEXT_MODEL = "nvidia-test-model";
process.env.ANALYSIS_PROVIDERS = "gemini,groq,openrouter,nvidia";
process.env.ANALYSIS_SCRIPT_OUTPUT_TOKENS = "2731";

const { writeExplainerScript } = await import("@/lib/movie-ai");
const { config } = await import("@/lib/config");

function makeTranscript() {
  const segments = [];
  for (let i = 0; i < 60; i += 1) {
    segments.push({ start: i * 10, end: i * 10 + 9, text: `Segment ${i}: the crew argues about the failing pump.` });
  }
  return {
    language: "en",
    durationSec: 600,
    text: segments.map((segment, i) => `[S${i}] ${segment.text}`).join("\n"),
    segments,
    words: [],
    chunkCount: 1,
    model: "whisper-test-model",
  };
}

function section(heading: string, i: number) {
  return {
    heading,
    title: `${heading} title ${i}`,
    narration: `Original spoken commentary for the ${heading} section, written to fit the budget.`,
    targetSec: 12,
    sceneStartSec: 40 + i * 100,
    sceneEndSec: 95 + i * 100,
    sceneTitle: `Shot ${i}`,
  };
}

const CANONICAL = ["hook", "setup", "what_happened", "why_it_matters", "payoff"];
const validScriptJson = () =>
  JSON.stringify({
    title: "The Shadow of the Collective",
    logline: "A town built on a secret begins to collapse when its founder resurfaces.",
    sections: CANONICAL.map((heading, i) => section(heading, i)),
  });

const BASE = {
  jobId: "test-script-budget-job",
  transcript: makeTranscript(),
  characters: [{ name: "Maya", role: "protagonist", description: "Engineer chasing the leak.", firstSeenSec: 12 }],
  events: [
    {
      id: "e0",
      startSec: 40,
      endSec: 95,
      summary: "Maya finds the overridden pump report.",
      characters: ["Maya"],
      cause: "a hidden maintenance order",
      effect: "emergency shutdown",
      importance: 8,
    },
  ],
  arc: "The leak becomes a cover-up.",
  durationSec: 600,
  targetSec: 120,
  sourceName: "Test Source.mp4",
};

test("the script stage honors ANALYSIS_SCRIPT_OUTPUT_TOKENS (2731) in config AND in the provider request", async () => {
  let seenLimit: number | null = null;
  const result = await writeExplainerScript({
    ...BASE,
    callOverride: async (_provider, input) => {
      seenLimit = input.outputTokenLimit;
      return validScriptJson();
    },
  });
  assert.equal(config.analysisScriptOutputTokens, 2731, "config picks up the env override");
  assert.equal(seenLimit, 2731, "the provider request carries the overridden budget (not the default 3200, not the hardcoded 1800)");
  assert.equal(config.analysisStoryOutputTokens, 2_048, "the story stage budget is unaffected by the script budget");
  assert.equal(result.provider, "gemini");
});
