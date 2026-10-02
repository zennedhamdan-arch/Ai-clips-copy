import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { StructuredJsonAttemptInfo } from "@/lib/analyze";

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

const { requestStructuredJson } = await import("@/lib/analyze");
const { providersConfigured } = await import("@/lib/config");
const { AppError } = await import("@/lib/errors");
const { analyzeStory } = await import("@/lib/movie-ai");

const ORDER = ["gemini", "groq", "openrouter", "nvidia"] as const;

/** Object-shaped gate standing in for the real Story schema (test A/B). */
const StoryGate = z.object({
  events: z.array(z.object({ startSegment: z.coerce.number().int(), endSegment: z.coerce.number().int(), summary: z.string() })).min(1),
});

const validStoryJson = (startSegment: number, endSegment: number) =>
  JSON.stringify({
    characters: [{ name: "Maya", role: "protagonist", description: "Engineer chasing the leak." }],
    events: [
      {
        startSegment,
        endSegment,
        summary: "Maya finds the overridden main valve in the control room.",
        characters: ["Maya"],
        cause: "a hidden maintenance order",
        effect: "emergency shutdown",
        importance: 8,
      },
    ],
    arc: "The investigation reaches the control room and the crew splits.",
  });

function makeTranscript(segmentCount: number) {
  const segments = [];
  for (let i = 0; i < segmentCount; i += 1) {
    segments.push({ start: i * 10, end: i * 10 + 9, text: `Segment ${i}: the crew argues about the failing reactor core.` });
  }
  return {
    language: "en",
    durationSec: segmentCount * 10,
    text: segments.map((segment, i) => `[S${i}] ${segment.text}`).join("\n"),
    segments,
    words: [],
    chunkCount: 1,
    model: "whisper-test-model",
  };
}

test("A. HTTP 503 from the first provider falls through to the next configured provider", async () => {
  const calls: string[] = [];
  const attempts: StructuredJsonAttemptInfo[] = [];
  const result = await requestStructuredJson({
    system: "test",
    user: "Return a story part as JSON.",
    schema: { type: "object" },
    validate: (value) => StoryGate.parse(value),
    onAttempt: (info) => attempts.push(info),
    callOverride: async (provider) => {
      calls.push(provider);
      if (provider === "gemini") {
        throw new AppError("internal", "Gemini analysis had a server error (HTTP 503).", { status: 502, retryable: true, providerStatus: 503 });
      }
      return validStoryJson(1, 3);
    },
  });
  assert.deepEqual(calls, ["gemini", "groq"], "gemini 503 → groq attempted next, in ANALYSIS_PROVIDERS order");
  assert.equal(result.provider, "groq");
  assert.equal(attempts[0].outcome, "failed");
  assert.equal(attempts[0].reason, "http_503");
  assert.equal(attempts[1].outcome, "passed");
});

test("B. a top-level array where an object is expected fails schema validation and falls back", async () => {
  const calls: string[] = [];
  const attempts: StructuredJsonAttemptInfo[] = [];
  const result = await requestStructuredJson({
    system: "test",
    user: "Return a story part as JSON.",
    schema: { type: "object" },
    validate: (value) => StoryGate.parse(value),
    onAttempt: (info) => attempts.push(info),
    callOverride: async (provider) => {
      calls.push(provider);
      if (provider === "gemini") {
        // HTTP 200, valid JSON — but an ARRAY where the schema expects an object.
        return JSON.stringify([{ events: [{ startSegment: 1, endSegment: 2, summary: "An event happened." }] }]);
      }
      return validStoryJson(1, 3);
    },
  });
  assert.deepEqual(calls, ["gemini", "groq"], "array response must not count as success");
  assert.equal(result.provider, "groq");
  assert.equal(attempts[0].outcome, "failed");
  assert.equal(attempts[0].reason, "schema_validation");
  assert.equal(attempts[1].outcome, "passed");
});

test("C. NaN segment indexes and inverted ranges are rejected and fall back to the next provider", async () => {
  const transcript = makeTranscript(10);
  const calls: Array<{ provider: string; mode: string }> = [];
  const responses = [
    // gemini: object-shaped and parseable, but endSegment is NaN.
    JSON.stringify({ events: [{ startSegment: 1, endSegment: "NaN", summary: "Maya opens the valve room door." }] }),
    // groq: schema-valid integers but start > end → no usable event.
    JSON.stringify({ events: [{ startSegment: 9, endSegment: 3, summary: "The reactor alarms start sounding." }] }),
    // openrouter: fully valid.
    validStoryJson(2, 5),
  ];
  let responseIndex = 0;
  const result = await analyzeStory({
    jobId: "story-test-c",
    transcript,
    durationSec: transcript.durationSec,
    callOverride: async (provider, input) => {
      calls.push({ provider, mode: input.mode });
      return responses[Math.min(responseIndex++, responses.length - 1)];
    },
  });
  assert.deepEqual(
    calls.map((call) => call.provider),
    ["gemini", "groq", "openrouter"],
    "NaN → schema rejection; inverted range → semantic rejection; openrouter accepted",
  );
  assert.equal(result.provider, "openrouter", "the provider that produced the VALID story is attributed");
  assert.ok(result.events.length >= 1);
  // Strict structured output on the first pass where supported.
  assert.ok(calls.every((call) => call.mode === "json_schema"), "first pass uses json_schema");
});

test("D. a valid story response passes final validation and the part is checkpointed", async () => {
  const transcript = makeTranscript(10);
  const checkpoints: Array<{ complete?: boolean; chunks?: Array<{ status?: string; events?: unknown[] }> }> = [];
  let callCount = 0;
  const result = await analyzeStory({
    jobId: "story-test-d",
    transcript,
    durationSec: transcript.durationSec,
    onCheckpoint: (checkpoint) => {
      checkpoints.push(checkpoint as never);
    },
    callOverride: async (provider) => {
      callCount += 1;
      assert.equal(provider, "gemini", "first provider in the configured order should win on a valid response");
      return validStoryJson(1, 4);
    },
  });
  assert.equal(callCount, 1);
  assert.equal(result.provider, "gemini");
  assert.equal(result.model, "gemini-test-model");
  assert.ok(result.events.length >= 1);
  const final = checkpoints[checkpoints.length - 1];
  assert.equal(final.complete, true);
  assert.equal(final.chunks?.[0]?.status, "succeeded");
  assert.ok((final.chunks?.[0]?.events?.length ?? 0) >= 1);
});

test("E. a previously successful part is reused from the checkpoint and NOT regenerated", async () => {
  // 70 segments × 10s = 700s → splits into 2 transcript chunks (>600s window).
  const transcript = makeTranscript(70);
  const checkpointsSeen: Array<{ complete?: boolean }> = [];

  // Run 1: part 1 succeeds, part 2 fails on every provider (including the repair pass).
  let savedCheckpoint: unknown = null;
  await assert.rejects(
    analyzeStory({
      jobId: "story-test-e",
      transcript,
      durationSec: transcript.durationSec,
      onCheckpoint: (checkpoint) => {
        checkpointsSeen.push(checkpoint as never);
        savedCheckpoint = checkpoint;
      },
      callOverride: async (_provider, input) => (input.user.includes("part 1 of") ? validStoryJson(1, 3) : "this is not json at all"),
    }),
    (error: unknown) => error instanceof AppError && error.resumeStage === "story_analysis",
  );
  assert.ok(savedCheckpoint, "the failed run must persist a checkpoint with part 1 succeeded");

  // Run 2 with that checkpoint: only part 2 may reach a provider.
  let callsInRun2 = 0;
  const result = await analyzeStory({
    jobId: "story-test-e",
    transcript,
    durationSec: transcript.durationSec,
    checkpoint: savedCheckpoint as never,
    callOverride: async (_provider, input) => {
      callsInRun2 += 1;
      assert.ok(input.user.includes("part 2 of"), "part 1 was already succeeded and must be reused, not regenerated");
      return validStoryJson(58, 60);
    },
  });
  assert.ok(callsInRun2 >= 1, "part 2 was actually requested");
  assert.ok(result.events.length >= 2, "events from BOTH parts (reused + newly analyzed) are merged");
  assert.ok(checkpointsSeen.length >= 2, "checkpoints were persisted during the failed run");
});

test("F. ANALYSIS_PROVIDERS order is respected exactly (not a forced canonical order)", async () => {
  const providers = providersConfigured();
  assert.deepEqual(providers.order, [...ORDER], "configured order follows ANALYSIS_PROVIDERS exactly");
  assert.ok(ORDER.every((provider) => providers[provider]), "all four test providers are configured");

  // And the request loop really walks that order, one provider at a time.
  const calls: string[] = [];
  const result = await requestStructuredJson({
    system: "test",
    user: "Return a story part as JSON.",
    schema: { type: "object" },
    validate: (value) => value,
    callOverride: async (provider) => {
      calls.push(provider);
      if (provider !== "nvidia") {
        throw new AppError("internal", "provider exploded", { status: 502, retryable: true, providerStatus: 503 });
      }
      return validStoryJson(1, 2);
    },
  });
  assert.deepEqual(calls, [...ORDER], "every provider tried once, in ANALYSIS_PROVIDERS order");
  assert.equal(result.provider, "nvidia");
});
