import test from "node:test";
import assert from "node:assert/strict";
import { after, afterEach } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Regression tests for the structured-JSON reliability fix (round 2).
 *
 * The fixtures use the REAL story-analysis schema (storyAnalysisSchema from
 * src/lib/movie-ai.ts) — not a toy replacement — run through:
 *   normalizeStrictSchema() → validateFinalStrictSchema() →
 *   Groq request payload construction (real HTTP request captured locally).
 *
 * Covers: recursive strict normalization, nullable optional fields, final
 * schema validation, Groq valid structured response, Groq schema rejection
 * (one bounded repair pass), Groq generation failure (json_validate_failed
 * ≠ schema problem), OpenRouter empty response (reasoning-budget markers,
 * no blind retry), and the normalizer's treatment of the actual story shape
 * (characters[], characters[] nested objects, events[] nested objects).
 *
 * Every test file runs in its own process; env is set before the app module
 * graph is imported (config is built at import time).
 */

// ---------------------------------------------------------------------------
// Local provider server (started before app imports)
// ---------------------------------------------------------------------------

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

// groq first, openrouter second — both pointed at the local server.
process.env.GROQ_API_KEY = "test-groq-key";
process.env.GROQ_TEXT_MODEL = "openai/gpt-oss-120b";
process.env.GROQ_BASE_URL = `${base}/groq/v1`;
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_TEXT_MODEL = "google/gemini-2.5-flash";
process.env.OPENROUTER_BASE_URL = `${base}/openrouter/v1`;
process.env.ANALYSIS_PROVIDERS = "groq,openrouter";
delete process.env.GEMINI_API_KEY;
delete process.env.NVIDIA_API_KEY;

const { requestStructuredJson } = await import("@/lib/analyze");
const { auditStrictSchema, normalizeStrictSchema, validateFinalStrictSchema } = await import("@/lib/strict-schema");
const { storyAnalysisSchema } = await import("@/lib/movie-ai");
const { AppError } = await import("@/lib/errors");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY_JSON = {
  title: "The Leak",
  characters: [{ name: "Maya", role: "protagonist", description: "Engineer chasing the leak.", firstSeenSec: 0 }],
  events: [
    {
      startSegment: 0,
      endSegment: 1,
      summary: "Maya finds the overridden valve in the control room.",
      characters: ["Maya"],
      cause: "a hidden maintenance order",
      effect: "emergency shutdown",
      importance: 8,
    },
  ],
  arc: "The crew splits over the shutdown.",
};

const validateStory = (value: unknown): unknown => {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a story object");
  if (!Array.isArray(v.events) || v.events.length === 0) throw new Error("expected non-empty events");
  if (v.characters !== undefined && v.characters !== null && !Array.isArray(v.characters)) throw new Error("expected characters array or null");
  return value;
};

const okJson = (payload: unknown): ResponderOut => ({
  status: 200,
  json: { choices: [{ message: { content: typeof payload === "string" ? payload : JSON.stringify(payload) } }] },
});

/** 200 with an EMPTY content field — the reasoning model spent its budget thinking. */
const emptyJson = (): ResponderOut => ({
  status: 200,
  json: {
    choices: [{ message: { content: "", reasoning: "thinking about the transcript…" }, finish_reason: "length" }],
    usage: { completion_tokens: 2048, completion_tokens_details: { reasoning_tokens: 2037 } },
  },
});

const GROQ_400_SCHEMA = { status: 400, raw: JSON.stringify({ error: { message: "Invalid JSON schema for response_format: 'analysis_result': /properties/characters/items: additionalProperties:false must be set on every object", type: "invalid_request_error", code: "invalid_schema" } }) };
const GROQ_400_GENERATION = { status: 400, raw: JSON.stringify({ error: { message: "Failed to validate JSON. Please adjust your prompt.", type: "invalid_request_error", code: "json_validate_failed", failed_generation: "" } }) };
const GROQ_400_UNSUPPORTED = { status: 400, raw: JSON.stringify({ error: { message: "Unrecognized request argument supplied: response_format" } }) };

function groqRequests(): RecordedRequest[] { return requests.filter((req) => req.path.startsWith("/groq/")); }
function openRouterRequests(): RecordedRequest[] { return requests.filter((req) => req.path.startsWith("/openrouter/")); }

function resetProviderState(): void {
  (globalThis as Record<string, unknown>).__clipforgeProviderState = undefined;
}

afterEach(() => {
  requests.length = 0;
  responder = () => ({ status: 500, raw: "unexpected request" });
  resetProviderState();
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const USER = "Analyze the transcript part. Return {characters, events, arc} JSON.";

// ---------------------------------------------------------------------------
// 1+2+4: the FINAL payload sent to Groq for the REAL story schema is strict
// on every object node, uses nullable optionals, and budgets reasoning
// ---------------------------------------------------------------------------

test("final payload for the real story schema: strict on every object, nullable optionals, reasoning budget", async () => {
  responder = () => okJson(STORY_JSON);
  const result = await requestStructuredJson({
    system: "Return strict JSON only.",
    user: USER,
    schema: storyAnalysisSchema,
    mode: "json_schema",
    outputTokenLimit: 2_048,
    validate: validateStory,
  });
  assert.equal(result.provider, "groq");
  assert.equal(requests.length, 1);

  const sent = groqRequests()[0].body;
  // Structured output stays strict json_schema (no silent format switch),
  // and the gpt-oss reasoning model gets a capped reasoning effort so its
  // hidden reasoning tokens do not eat the JSON budget.
  assert.equal(sent.response_format.type, "json_schema");
  assert.equal(sent.response_format.json_schema.name, "analysis_result");
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.equal(sent.reasoning_effort, "low", "gpt-oss must get reasoning_effort=low");
  assert.equal(sent.max_tokens, 2_048, "output budget must cover reasoning + JSON");

  const sentSchema: Record<string, any> = sent.response_format.json_schema.schema;
  const objectPaths: string[] = [];
  const walk = (node: any, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    if (node.type === "object") {
      objectPaths.push(path);
      assert.equal(node.additionalProperties, false, `object at ${path} must set additionalProperties:false`);
      const props = (node.properties ?? {}) as Record<string, any>;
      const required = (node.required ?? []) as string[];
      for (const name of Object.keys(props)) {
        assert.ok(required.includes(name), `object at ${path} must list property "${name}" in required`);
      }
      for (const [name, child] of Object.entries(props)) walk(child, `${path}.properties.${name}`);
    } else if (node.type === "array") {
      assert.ok("items" in node, `array at ${path} must define items`);
      walk(node.items, `${path}.items`);
    }
  };
  walk(sentSchema, "$");

  // Root AND /properties/characters/items AND /properties/events/items.
  assert.deepEqual(
    objectPaths.sort(),
    ["$", "$.properties.characters.items", "$.properties.events.items"],
  );

  // Nullable optional fields (the reported /properties/characters/items path):
  // semantically required stays plain, conceptually optional becomes ["t","null"].
  const characterItem: any = sentSchema.properties.characters.items;
  assert.equal(characterItem.additionalProperties, false, "/properties/characters/items sets additionalProperties:false");
  assert.deepEqual(characterItem.properties.name.type, "string", "name is semantically required — stays non-nullable");
  assert.deepEqual(characterItem.properties.role.type, ["string", "null"], "role is optional → nullable");
  assert.deepEqual(characterItem.properties.description.type, ["string", "null"], "description is optional → nullable");

  const eventItem: any = sentSchema.properties.events.items;
  assert.equal(eventItem.additionalProperties, false);
  assert.deepEqual(eventItem.properties.startSegment.type, "integer");
  assert.deepEqual(eventItem.properties.endSegment.type, "integer");
  assert.deepEqual(eventItem.properties.summary.type, "string");
  assert.deepEqual(eventItem.properties.cause.type, ["string", "null"], "cause is optional → nullable");
  assert.deepEqual(eventItem.properties.effect.type, ["string", "null"], "effect is optional → nullable");
  assert.deepEqual(eventItem.properties.importance.type, ["integer", "null"], "importance is optional → nullable");
  assert.deepEqual(eventItem.properties.characters.type, "array", "nested array optional stays non-nullable (no anyOf in strict)");
  assert.deepEqual(eventItem.required.sort(), ["cause", "characters", "effect", "endSegment", "importance", "startSegment", "summary"]);

  // Root: arc optional → nullable; no firstSeenSec anywhere (not consumed downstream).
  assert.deepEqual(sentSchema.properties.arc.type, ["string", "null"]);
  assert.equal(JSON.stringify(sentSchema).includes("firstSeenSec"), false, "unconsumed field was removed from the schema");
  assert.deepEqual(sentSchema.required.sort(), ["arc", "characters", "events"]);
  assert.equal(sentSchema.additionalProperties, false);
});

// ---------------------------------------------------------------------------
// 3: malformed schema fails BEFORE any request (local schema_validation_error)
// ---------------------------------------------------------------------------

test("malformed schema fails before any request (no provider burn-through)", async () => {
  responder = () => okJson(STORY_JSON);
  const badSchema = {
    type: "object",
    properties: { characters: { anyOf: [{ type: "array" }, { type: "string" }] } },
    required: ["characters"],
  };
  await assert.rejects(
    requestStructuredJson({ system: "Return strict JSON only.", user: USER, schema: badSchema, mode: "json_schema", validate: validateStory }),
    (error: unknown) => {
      assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
      assert.match(String((error as Error & { detail?: string }).detail ?? ""), /schema_validation_error/);
      return true;
    },
  );
  assert.equal(requests.length, 0, "no request may be sent for an invalid schema");
});

// ---------------------------------------------------------------------------
// 7: Groq generation failure (json_validate_failed) — distinct from schema rejection
// ---------------------------------------------------------------------------

test("Groq json_validate_failed is a generation failure, not a schema problem (no blind same-request retry)", async () => {
  responder = () => GROQ_400_GENERATION;
  const attempts: Array<{ provider: string; category?: string; reason?: string; pass?: number }> = [];
  await assert.rejects(
    requestStructuredJson({
      system: "Return strict JSON only.",
      user: USER,
      schema: storyAnalysisSchema,
      mode: "json_schema",
      outputTokenLimit: 2_048,
      validate: validateStory,
      onAttempt: (info) => attempts.push({ provider: info.provider, category: info.category, reason: info.reason, pass: info.pass }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /All providers exhausted\./);
      assert.match(error.message, /STRUCTURED_GENERATION_FAILED/);
      assert.match(error.message, /failed_generation_chars=0/);
      assert.doesNotMatch(error.message, /SCHEMA_REQUEST_INVALID/);
      return true;
    },
  );
  // Both providers failed with the generation error in pass 1 — all failures
  // were persistent, so the chain STOPS (no pass 2, no endless cycling).
  assert.equal(requests.length, 2);
  assert.equal(groqRequests().length, 1);
  assert.equal(openRouterRequests().length, 1);
  assert.deepEqual(
    attempts.map((a) => [a.provider, a.category, a.reason, a.pass]),
    [
      ["groq", "STRUCTURED_GENERATION_FAILED", "structured_generation_failed", 1],
      ["openrouter", "STRUCTURED_GENERATION_FAILED", "structured_generation_failed", 1],
    ],
  );
});

// ---------------------------------------------------------------------------
// 6: Groq schema rejection → ONE bounded repair pass (json_object), then done
// ---------------------------------------------------------------------------

test("Groq schema rejection runs one bounded repair pass in json_object, not repeated strict retries", async () => {
  let groqCalls = 0;
  responder = (req) => {
    if (req.path.startsWith("/openrouter/")) return GROQ_400_SCHEMA;
    groqCalls += 1;
    // Pass 1 strict request → 400 schema rejection. Pass 2 json_object → success.
    if (req.body.response_format?.type === "json_schema") return GROQ_400_SCHEMA;
    return okJson(STORY_JSON);
  };
  const result = await requestStructuredJson({
    system: "Return strict JSON only.",
    user: USER,
    schema: storyAnalysisSchema,
    mode: "json_schema",
    outputTokenLimit: 2_048,
    validate: validateStory,
  });
  assert.equal(result.provider, "groq");
  // groq: pass 1 strict (400) + pass 2 json_object (200) = exactly 2 calls.
  assert.equal(groqCalls, 2);
  assert.equal(groqRequests()[0].body.response_format.type, "json_schema");
  assert.deepEqual(groqRequests()[1].body.response_format, { type: "json_object" });
  // openrouter was tried once in pass 1 and not re-cycled in pass 2 (groq won).
  assert.equal(openRouterRequests().length, 1);
});

// ---------------------------------------------------------------------------
// 8: unsupported structured-output mode → UNSUPPORTED_STRUCTURED_OUTPUT, one looser retry
// ---------------------------------------------------------------------------

test("unsupported strict format is classified and retried once in json_object", async () => {
  let groqCalls = 0;
  responder = (req) => {
    if (req.path.startsWith("/openrouter/")) return { status: 503, raw: "overloaded" };
    groqCalls += 1;
    return groqCalls === 1 ? GROQ_400_UNSUPPORTED : okJson(STORY_JSON);
  };
  const attempts: Array<{ provider: string; category?: string }> = [];
  const result = await requestStructuredJson({
    system: "Return strict JSON only.",
    user: USER,
    schema: storyAnalysisSchema,
    mode: "json_schema",
    outputTokenLimit: 2_048,
    validate: validateStory,
    onAttempt: (info) => attempts.push({ provider: info.provider, category: info.category }),
  });
  assert.equal(result.provider, "groq");
  assert.equal(groqCalls, 2, "no repeated retries of the same strict request");
  assert.equal(groqRequests()[0].body.response_format.type, "json_schema");
  assert.deepEqual(groqRequests()[1].body.response_format, { type: "json_object" });
  assert.equal(openRouterRequests().length, 1, "the 503'd provider is not re-tried within the same pass");
  assert.deepEqual(
    attempts.filter((a) => a.provider === "groq").map((a) => a.category),
    ["UNSUPPORTED_STRUCTURED_OUTPUT", undefined],
  );
});

// ---------------------------------------------------------------------------
// 5: OpenRouter-style EMPTY_RESPONSE with reasoning-budget markers, no blind retry
// ---------------------------------------------------------------------------

test("empty response is marked EMPTY_RESPONSE with finish_reason/reasoning markers and NOT blindly retried", async () => {
  responder = () => emptyJson();
  const attempts: Array<{ provider: string; category?: string; reason?: string }> = [];
  await assert.rejects(
    requestStructuredJson({
      system: "Return strict JSON only.",
      user: USER,
      schema: storyAnalysisSchema,
      mode: "json_schema",
      outputTokenLimit: 2_048,
      validate: validateStory,
      onAttempt: (info) => attempts.push({ provider: info.provider, category: info.category, reason: info.reason }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /All providers exhausted\./);
      assert.match(error.message, /EMPTY_RESPONSE/);
      assert.match(error.message, /finish_reason=length/);
      assert.match(error.message, /reasoning_tokens=2037/);
      assert.match(error.message, /provider=openrouter/);
      return true;
    },
  );
  // One attempt per provider, and both were EMPTY_RESPONSE (persistent) →
  // the chain stops: the exact same request is never retried blindly.
  assert.equal(requests.length, 2);
  assert.deepEqual(
    attempts.map((a) => [a.provider, a.category, a.reason]),
    [
      ["groq", "EMPTY_RESPONSE", "empty_response"],
      ["openrouter", "EMPTY_RESPONSE", "empty_response"],
    ],
  );
});

// ---------------------------------------------------------------------------
// 9: successful structured JSON
// ---------------------------------------------------------------------------

test("valid structured JSON succeeds on the first provider", async () => {
  responder = () => okJson(STORY_JSON);
  const result = await requestStructuredJson({
    system: "Return strict JSON only.",
    user: USER,
    schema: storyAnalysisSchema,
    mode: "json_schema",
    outputTokenLimit: 2_048,
    validate: validateStory,
  });
  assert.equal(result.provider, "groq");
  assert.equal(result.model, "openai/gpt-oss-120b");
  assert.equal(requests.length, 1);
  assert.equal(groqRequests()[0].body.model, "openai/gpt-oss-120b");
  assert.deepEqual(JSON.parse(result.content), STORY_JSON);
});

// ---------------------------------------------------------------------------
// Normalizer + final-validator unit behavior on the REAL story schema
// ---------------------------------------------------------------------------

test("normalizer: real story schema → strict objects, nullable optionals, no mutation, cached", () => {
  const audit = auditStrictSchema(storyAnalysisSchema);
  assert.ok(audit.ok, `expected fixable schema, got hard issues: ${JSON.stringify(audit.hardIssues)}`);
  assert.ok(audit.fixes.length >= 6, "root + character fields + event fields + arc need fixes");

  const { ok, schema, fixes } = normalizeStrictSchema(storyAnalysisSchema);
  assert.ok(ok);
  assert.ok(schema);
  assert.ok(fixes.length >= 6);
  const final = schema as any;

  assert.equal(final.additionalProperties, false);
  assert.deepEqual(final.properties.characters.items.additionalProperties, false, "the reported /properties/characters/items path is fixed");
  assert.deepEqual(final.properties.events.items.additionalProperties, false);
  assert.deepEqual(final.properties.characters.items.required, ["name", "role", "description"]);
  assert.deepEqual(final.properties.events.items.required, ["startSegment", "endSegment", "summary", "characters", "cause", "effect", "importance"]);
  assert.deepEqual(final.required, ["events", "characters", "arc"]);
  assert.deepEqual(final.properties.characters.items.properties.role.type, ["string", "null"]);
  assert.deepEqual(final.properties.events.items.properties.importance.type, ["integer", "null"]);
  assert.equal(final.properties.characters.items.properties.name.type, "string");

  // The FINAL schema must pass the local validator before any request.
  const check = validateFinalStrictSchema(schema);
  assert.deepEqual(check, { ok: true, issues: [] });

  // Never mutates the caller's schema; result is cached per reference.
  assert.equal((storyAnalysisSchema.required as string[]).length, 1, "original required list untouched");
  assert.ok(!("additionalProperties" in storyAnalysisSchema), "original root untouched");
  const first = normalizeStrictSchema(storyAnalysisSchema);
  const second = normalizeStrictSchema(storyAnalysisSchema);
  assert.equal(second, first, "cached result for the same schema reference");
});

test("normalizer: malformed schemas are rejected with hard issues and a null schema", () => {
  const cases: Array<Record<string, unknown>> = [
    { type: "object", properties: { a: { oneOf: [{ type: "string" }] } } },
    { type: "object", properties: { a: { $ref: "#/definitions/x" } } },
    { type: "object", properties: { a: { type: "string", enum: [] } } },
    { type: "object", properties: { a: { type: "array" } } },
    { type: "object", properties: { a: { type: "string" } }, required: ["missing"] },
    { type: "object", properties: { a: { type: ["string", "boolean"] } } },
    { type: "object", properties: { a: { type: "string", minLength: 10, maxLength: 5 } } },
  ];
  for (const bad of cases) {
    const result = normalizeStrictSchema(bad);
    assert.equal(result.ok, false, `expected hard issues for ${JSON.stringify(bad)}`);
    assert.equal(result.schema, null);
    assert.ok(result.hardIssues.length > 0);
  }
});

test("final validator: catches every invariant a normalized schema must satisfy", () => {
  // A fully valid strict schema passes.
  const valid = {
    type: "object",
    additionalProperties: false,
    required: ["a"],
    properties: { a: { type: ["string", "null"] } },
  };
  assert.deepEqual(validateFinalStrictSchema(valid), { ok: true, issues: [] });

  const broken: Array<[string, Record<string, unknown>]> = [
    ["missing additionalProperties", { type: "object", required: ["a"], properties: { a: { type: "string" } } }],
    ["property missing from required", { type: "object", additionalProperties: false, required: [], properties: { a: { type: "string" } } }],
    ["required not in properties", { type: "object", additionalProperties: false, required: ["zz"], properties: {} }],
    ["bad type union", { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: ["string", "boolean"] } } }],
    ["non-scalar type union", { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: ["object", "null"] } } }],
    ["minItems > maxItems", { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "array", minItems: 5, maxItems: 2, items: { type: "string" } } } }],
    ["array without items", { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "array" } } }],
    ["root not an object", { type: "string" }],
    ["unsupported key", { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } }, $defs: {} }],
  ];
  for (const [label, bad] of broken) {
    const check = validateFinalStrictSchema(bad);
    assert.equal(check.ok, false, `${label} must be rejected`);
    assert.ok(check.issues.length > 0, `${label} must report issues`);
  }
});
