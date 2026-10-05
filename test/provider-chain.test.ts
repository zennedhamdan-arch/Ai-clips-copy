import test from "node:test";
import assert from "node:assert/strict";
import { after, afterEach } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Provider-chain regression tests: all FOUR providers (Gemini, Groq,
 * OpenRouter, NVIDIA) pointed at a local HTTP server so per-provider
 * behavior and the BOUNDED chain policy are observable:
 *   - a provider is never retried repeatedly inside one pass
 *   - pass 2 runs only for deterministic schema or transient failures
 *   - all-persistent failures stop the chain
 *   - 503 overload = TRANSIENT_PROVIDER_ERROR (never a schema conclusion)
 *   - malformed JSON = STRUCTURED_GENERATION_FAILED (never a transcript conclusion)
 *
 * Every test file runs in its own process; env is set before the app module
 * graph is imported (config is built at import time).
 */

type RecordedRequest = { path: string; body: Record<string, any> };
type ResponderOut = { status: number; json?: unknown; raw?: string };
let responder: (req: RecordedRequest) => ResponderOut = () => ({ status: 500, raw: "unexpected request" });

const requests: RecordedRequest[] = [];
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let data = "";
  req.on("data", (chunk) => { data += chunk; });
  req.on("end", () => {
    try {
      const body = data ? JSON.parse(data) : {};
      const recorded = { path: req.url ?? "", body };
      requests.push(recorded);
      const out = responder(recorded);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(out.raw ?? JSON.stringify(out.json));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_TEXT_MODEL = "gemini-test-model";
process.env.GEMINI_BASE_URL = base;
process.env.GROQ_API_KEY = "test-groq-key";
process.env.GROQ_TEXT_MODEL = "openai/gpt-oss-120b";
process.env.GROQ_BASE_URL = `${base}/groq/v1`;
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_TEXT_MODEL = "google/gemini-2.5-flash";
process.env.OPENROUTER_BASE_URL = `${base}/openrouter/v1`;
process.env.NVIDIA_API_KEY = "test-nvidia-key";
process.env.NVIDIA_TEXT_MODEL = "meta/llama-3.3-70b-instruct";
process.env.NVIDIA_BASE_URL = `${base}/nvidia/v1`;
process.env.ANALYSIS_PROVIDERS = "gemini,groq,openrouter,nvidia";

const { requestStructuredJson } = await import("@/lib/analyze");

const STORY_JSON = {
  characters: [{ name: "Maya", role: "protagonist", description: "Engineer chasing the leak." }],
  events: [
    { startSegment: 0, endSegment: 1, summary: "Maya finds the overridden valve in the control room.", characters: ["Maya"], cause: "a hidden order", effect: "shutdown", importance: 8 },
  ],
  arc: "The crew splits over the shutdown.",
};

const validateStory = (value: unknown): unknown => {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a story object");
  if (!Array.isArray(v.events) || v.events.length === 0) throw new Error("expected non-empty events");
  return value;
};

// Provider-specific success payloads (Gemini generateContent vs OpenAI-compatible).
const okFor = (req: RecordedRequest): ResponderOut => {
  if (req.path.startsWith("/models/")) {
    return {
      status: 200,
      json: {
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(STORY_JSON) }] } }],
        usageMetadata: { candidatesTokenCount: 120 },
      },
    };
  }
  return { status: 200, json: { choices: [{ message: { content: JSON.stringify(STORY_JSON) } }] } };
};

const gemini503 = (): ResponderOut => ({ status: 503, raw: JSON.stringify({ error: { status: "UNAVAILABLE", message: "Resource has been exhausted (e.g. check quota). High demand." } }) });
const nvidia503 = (): ResponderOut => ({ status: 503, raw: "Service temporarily overloaded" });
const notJson = (): ResponderOut => ({ status: 200, json: { choices: [{ message: { content: "Sorry, I cannot do that." } }] } });

function countByPath(prefix: string): number {
  return requests.filter((req) => req.path.startsWith(prefix)).length;
}

afterEach(() => {
  requests.length = 0;
  responder = () => ({ status: 500, raw: "unexpected request" });
  (globalThis as Record<string, unknown>).__clipforgeProviderState = undefined;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const CALLS = {
  system: "Return strict JSON only.",
  user: "Analyze the transcript part. Return {characters, events, arc} JSON.",
  schema: {
    type: "object",
    properties: {
      characters: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
      events: {
        type: "array",
        minItems: 1,
        items: { type: "object", properties: { startSegment: { type: "integer" }, endSegment: { type: "integer" }, summary: { type: "string" } }, required: ["startSegment", "endSegment", "summary"] },
      },
      arc: { type: "string" },
    },
    required: ["events"],
  },
  mode: "json_schema" as const,
  outputTokenLimit: 2_048,
  validate: validateStory,
};

test("Gemini 503 → next provider; the overloaded provider is tried exactly once in the pass", async () => {
  responder = (req) => (req.path.startsWith("/models/") ? gemini503() : okFor(req));
  const attempts: Array<{ provider: string; category?: string; reason?: string; pass?: number }> = [];
  const result = await requestStructuredJson({
    ...CALLS,
    onAttempt: (info) => attempts.push({ provider: info.provider, category: info.category, reason: info.reason, pass: info.pass }),
  });
  assert.equal(result.provider, "groq", "falls through to the next configured provider");
  // One attempt per provider in pass 1 — the 503'd Gemini is NOT hammered.
  assert.equal(countByPath("/models/"), 1, "Gemini tried exactly once (no repeated in-pass retries)");
  assert.equal(countByPath("/groq/"), 1);
  assert.equal(countByPath("/openrouter/"), 0, "chain stops as soon as a provider succeeds");
  assert.deepEqual(
    attempts,
    [
      { provider: "gemini", category: "TRANSIENT_PROVIDER_ERROR", reason: "http_503", pass: 1 },
      { provider: "groq", category: undefined, reason: undefined, pass: 1 },
    ],
  );
});

test("NVIDIA malformed JSON is STRUCTURED_GENERATION_FAILED — not a transcript problem — and falls through", async () => {
  // gemini/groq/openrouter transient, nvidia returns prose instead of JSON.
  responder = (req) => {
    if (req.path.startsWith("/nvidia/")) return notJson();
    return { status: 503, raw: "overloaded" };
  };
  const attempts: Array<{ provider: string; category?: string; reason?: string }> = [];
  await assert.rejects(
    requestStructuredJson({
      ...CALLS,
      onAttempt: (info) => attempts.push({ provider: info.provider, category: info.category, reason: info.reason }),
    }),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /All providers exhausted\./);
      assert.match(message, /nvidia: STRUCTURED_GENERATION_FAILED/);
      assert.match(message, /gemini: TRANSIENT_PROVIDER_ERROR/);
      return true;
    },
  );
  const nvidia = attempts.filter((a) => a.provider === "nvidia");
  assert.deepEqual(
    nvidia.map((a) => [a.category, a.reason]),
    [
      ["STRUCTURED_GENERATION_FAILED", "invalid_json"],
      ["STRUCTURED_GENERATION_FAILED", "invalid_json"],
    ],
    "nvidia failed in both passes (the transient 503s triggered the bounded retry pass)",
  );
  // Bounded: 4 providers × 2 passes = 8 requests, never more.
  assert.equal(requests.length, 8);
  assert.equal(countByPath("/nvidia/"), 2);
});

test("NVIDIA 503 is TRANSIENT_PROVIDER_ERROR, distinct from its schema_validation behavior", async () => {
  responder = (req) => (req.path.startsWith("/nvidia/") ? nvidia503() : { status: 503, raw: "overloaded" });
  await assert.rejects(
    requestStructuredJson(CALLS),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /nvidia: TRANSIENT_PROVIDER_ERROR/);
      assert.match(message, /503 transient provider unavailable/);
      assert.doesNotMatch(message, /SCHEMA_REQUEST_INVALID/);
      return true;
    },
  );
  assert.equal(requests.length, 8, "all four providers × two bounded passes");
  assert.equal(countByPath("/nvidia/"), 2, "one attempt per pass — the overload backoff gates, not removes, the provider");
});

test("all-persistent failures stop the chain after one pass (no endless provider cycling)", async () => {
  // Every provider returns a persistent failure (empty response) — no
  // transient, no schema problem → the bounded retry pass must NOT run.
  responder = (req) =>
    req.path.startsWith("/models/")
      ? { status: 200, json: { candidates: [{ finishReason: "STOP", content: { parts: [] } }] } }
      : { status: 200, json: { choices: [{ message: { content: "" } }] } };
  await assert.rejects(
    requestStructuredJson(CALLS),
    (error: unknown) => {
      assert.match(String((error as Error).message), /All providers exhausted\./);
      assert.match(String((error as Error).message), /EMPTY_RESPONSE/);
      return true;
    },
  );
  assert.equal(requests.length, 4, "exactly one attempt per provider — no second pass for all-persistent failures");
});
