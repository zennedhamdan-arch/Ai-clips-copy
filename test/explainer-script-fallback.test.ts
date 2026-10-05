import test from "node:test";
import assert from "node:assert/strict";

// Every test in this file runs in its own process. Configure all four
// providers as "configured" and use a NON-canonical order to prove that
// ANALYSIS_PROVIDERS controls provider priority (not merely enable/disable).
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_TEXT_MODEL = "gemini-test-model";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_TEXT_MODEL = "openrouter-test-model";
process.env.GROQ_API_KEY = "test-groq-key";
process.env.GROQ_TEXT_MODEL = "groq-test-model";
process.env.NVIDIA_API_KEY = "test-nvidia-key";
process.env.NVIDIA_TEXT_MODEL = "nvidia-test-model";
process.env.ANALYSIS_PROVIDERS = "gemini,groq,openrouter,nvidia";

const { writeExplainerScript } = await import("@/lib/movie-ai");
const { config } = await import("@/lib/config");

const CANONICAL = ["hook", "setup", "what_happened", "why_it_matters", "payoff"] as const;

function resetProviderState() {
  delete (globalThis as { __clipforgeProviderState?: unknown }).__clipforgeProviderState;
}

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

function section(heading: string, i: number, overrides: Record<string, unknown> = {}) {
  return {
    heading,
    title: `${heading} title ${i}`,
    narration: `Original spoken commentary for the ${heading} section, written to fit the budget.`,
    targetSec: 12,
    sceneStartSec: 40 + i * 100,
    sceneEndSec: 95 + i * 100,
    sceneTitle: `Shot ${i}`,
    ...overrides,
  };
}

function validScriptJson(sections: Array<Record<string, unknown>> = CANONICAL.map((heading, i) => section(heading, i))) {
  return JSON.stringify({
    title: "The Shadow of the Collective",
    logline: "A town built on a secret begins to collapse when its founder resurfaces.",
    sections,
  });
}

const BASE = {
  jobId: "test-script-job",
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

test("A. a truncated (malformed) HTTP-200 script from the first provider is rejected and falls through to the next", async () => {
  resetProviderState();
  const calls: string[] = [];
  const truncated = validScriptJson().slice(0, 260);
  // Sanity: the truncated payload is genuinely malformed JSON — no repair can
  // fabricate the missing sections, so the gate must reject it.
  assert.throws(() => JSON.parse(truncated), "fixture must be malformed");
  const result = await writeExplainerScript({
    ...BASE,
    callOverride: async (provider) => {
      calls.push(provider);
      if (provider === "gemini") return truncated; // HTTP 200 with a cut-off object
      return validScriptJson();
    },
  });
  assert.deepEqual(calls, ["gemini", "groq"], "truncated JSON must not count as success; next provider in ANALYSIS_PROVIDERS order");
  assert.equal(result.provider, "groq");
  assert.equal(result.sections.length, 5);
});

test("B. a valid script from the first provider is accepted without any further calls", async () => {
  resetProviderState();
  const calls: string[] = [];
  const result = await writeExplainerScript({
    ...BASE,
    callOverride: async (provider) => {
      calls.push(provider);
      return validScriptJson();
    },
  });
  assert.deepEqual(calls, ["gemini"], "a valid first response must stop the chain");
  assert.equal(result.provider, "gemini");
  assert.equal(result.title, "The Shadow of the Collective");
  assert.equal(result.logline, "A town built on a secret begins to collapse when its founder resurfaces.");
  assert.equal(result.sections.length, 5);
});

test("C. an empty HTTP-200 body from the first provider is rejected and a valid fallback is accepted", async () => {
  resetProviderState();
  const calls: string[] = [];
  const result = await writeExplainerScript({
    ...BASE,
    callOverride: async (provider) => {
      calls.push(provider);
      if (provider === "gemini") return ""; // HTTP 200, zero content
      return validScriptJson();
    },
  });
  assert.deepEqual(calls, ["gemini", "groq"], "an empty body must not count as success");
  assert.equal(result.provider, "groq");
  assert.equal(result.sections.length, 5);
});

test("D. a valid-JSON but schema-invalid script (bad heading enum) is rejected by the Zod gate and falls through", async () => {
  resetProviderState();
  const calls: string[] = [];
  const badHeadingJson = validScriptJson([
    {
      heading: "intro", // not one of the five canonical headings
      title: "Intro title",
      narration: "Original spoken commentary that is long enough to pass the minimum length check.",
      targetSec: 12,
      sceneStartSec: null,
      sceneEndSec: null,
      sceneTitle: null,
    },
    ...CANONICAL.slice(1).map((heading, i) => section(heading, i + 1)),
  ]);
  // Sanity: it PARSES as JSON — the rejection must come from ScriptSchema, not extraction.
  JSON.parse(badHeadingJson);
  const result = await writeExplainerScript({
    ...BASE,
    callOverride: async (provider) => {
      calls.push(provider);
      if (provider === "gemini") return badHeadingJson;
      return validScriptJson();
    },
  });
  assert.deepEqual(calls, ["gemini", "groq"], "schema-invalid JSON must not count as success");
  assert.equal(result.provider, "groq");
  assert.deepEqual(result.sections.map((section) => section.heading), CANONICAL);
});

test("E. five canonical headings returned out of order become an ordered five-section script; null targetSec is accepted", async () => {
  resetProviderState();
  const shuffled = [
    section("payoff", 4),
    section("hook", 0),
    section("why_it_matters", 3),
    section("what_happened", 2),
    // The strict provider schema represents targetSec as ["number","null"];
    // a model-emitted null must pass the Zod gate (not be coerced to 0).
    section("setup", 1, { targetSec: null }),
  ];
  const result = await writeExplainerScript({
    ...BASE,
    callOverride: async () => validScriptJson(shuffled),
  });
  assert.equal(result.version, 1);
  assert.deepEqual(result.sections.map((section) => section.heading), CANONICAL, "sections must be re-ordered to the canonical five");
  assert.equal(result.sections.length, 5);
  const hook = result.sections[0];
  assert.equal(hook.sceneStartSec, 40, "scene fields survive the ordering pass");
  assert.equal(hook.sceneEndSec, 95);
  assert.equal(hook.sceneTitle, "Shot 0");
  const setup = result.sections[1];
  // Model-emitted null targetSec must pass the Zod gate and then fall back to
  // the estimated narration duration (existing fallback-section behavior).
  assert.equal(typeof setup.targetSec, "number", "null targetSec is replaced by the estimated duration, never left null");
  assert.ok(setup.targetSec > 0);
});

test("F. the script stage sends the explicit strict schema on pass 1 with the default 3200-token budget", async () => {
  resetProviderState();
  const seen: Array<{ mode: string; outputTokenLimit: number; schema: Record<string, unknown> }> = [];
  const result = await writeExplainerScript({
    ...BASE,
    callOverride: async (_provider, input) => {
      seen.push({ mode: input.mode, outputTokenLimit: input.outputTokenLimit, schema: input.schema });
      return validScriptJson();
    },
  });
  assert.equal(config.analysisScriptOutputTokens, 3_200, "default budget is 3200 when ANALYSIS_SCRIPT_OUTPUT_TOKENS is unset");
  assert.equal(seen.length, 1, "provider call must have happened exactly once");
  const call = seen[0];
  assert.equal(call.outputTokenLimit, 3_200, "the script stage uses the script budget, not a hardcoded value");
  assert.equal(call.mode, "json_schema", "strict schema is sent on the first pass");
  assert.equal(call.schema.additionalProperties, false, "root object must be strictly closed");
  assert.deepEqual(call.schema.required, ["title", "logline", "sections"], "root required must be declared explicitly");
  const items = (call.schema.properties as Record<string, unknown>).sections as { items: Record<string, unknown> };
  assert.equal(items.items.additionalProperties, false, "section items must be strictly closed");
  assert.deepEqual(
    [...(items.items.required as string[])].sort(),
    ["heading", "narration", "sceneEndSec", "sceneStartSec", "sceneTitle", "targetSec", "title"],
    "every section property must be declared required (strict-mode nullable-optional pattern)",
  );
  const props = items.items.properties as Record<string, { type: unknown }>;
  assert.deepEqual(props.sceneStartSec.type, ["number", "null"], "optional scene seconds must be nullable unions");
  assert.deepEqual(props.sceneEndSec.type, ["number", "null"]);
  assert.deepEqual(props.sceneTitle.type, ["string", "null"]);
  assert.deepEqual(props.targetSec.type, ["number", "null"]);
  assert.equal(result.provider, "gemini");
});
