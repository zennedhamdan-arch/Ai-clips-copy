import test from "node:test";
import assert from "node:assert/strict";
import { after, afterEach } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Regression tests for the strict structured-JSON reliability fix.
 *
 * Covers (Task 9): the SAME analysis_result shape as the story pipeline
 * (characters: array<object> + nested objects) sent to Groq — verifying the
 * request body has additionalProperties:false on EVERY object node — plus
 * malformed schema (fail BEFORE the request), empty provider response
 * (EMPTY_RESPONSE), HTTP 503 (transient → next provider), HTTP 400 schema
 * error (one retry, then fail fast), successful structured JSON, fallback
 * after a transient failure, and unsupported-format downgrade.
 *
 * The OpenAI-compatible providers are pointed at a LOCAL http server so the
 * exact request bodies are captured (no callOverride on the HTTP tests).
 * Every test file runs in its own process, so env is set before the app
 * module graph is imported (config is built at import time).
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
const { auditStrictSchema, normalizeStrictSchema } = await import("@/lib/strict-schema");
const { AppError } = await import("@/lib/errors");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The SAME analysis_result shape the story pipeline sends (nested objects). */
const STORY_SHAPE_SCHEMA = {
  type: "object",
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          description: { type: "string" },
          firstSeenSec: { type: "number" },
        },
      },
    },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startSegment: { type: "integer" },
          endSegment: { type: "integer" },
          summary: { type: "string" },
          characters: { type: "array", items: { type: "string" } },
          cause: { type: "string" },
          effect: { type: "string" },
          importance: { type: "integer" },
        },
      },
    },
    arc: { type: "string" },
  },
  required: ["events"],
};

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
  if (!Array.isArray(v.characters)) throw new Error("expected characters array");
  return value;
};

const okJson = (payload: unknown): ResponderOut => ({
  status: 200,
  json: { choices: [{ message: { content: typeof payload === "string" ? payload : JSON.stringify(payload) } }] },
});

const emptyJson = (): ResponderOut => ({ status: 200, json: { choices: [{ message: { content: "" } }] } });

const GROQ_400_SCHEMA = { status: 400, raw: JSON.stringify({ error: { message: "Invalid JSON schema for response_format: 'analysis_result': /properties/characters/items: additionalProperties:false must be set on every object" } }) };
const GROQ_400_UNSUPPORTED = { status: 400, raw: JSON.stringify({ error: { message: "Unrecognized request argument supplied: response_format" } }) };

function groqRequests(): RecordedRequest[] { return requests.filter((req) => req.path.startsWith("/groq/")); }
function openRouterRequests(): RecordedRequest[] { return requests.filter((req) => req.path.startsWith("/openrouter/")); }

afterEach(() => {
  requests.length = 0;
  // Fresh provider runtime state (cooldowns/blocks/overload counters) per test.
  (globalThis as Record<string, unknown>).__clipforgeProviderState = undefined;
});

// Ensure the process can exit: close the local server and any keep-alive sockets.
after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Task 9: the schema actually SENT to Groq is strict on every object node
// ---------------------------------------------------------------------------

test("strict schema sent to groq has additionalProperties:false on EVERY object node", async () => {
  responder = () => okJson(STORY_JSON);
  const result = await requestStructuredJson({
    system: "Return strict JSON only.",
    user: "Analyze the transcript part. Return {characters, events, arc} JSON.",
    schema: STORY_SHAPE_SCHEMA,
    mode: "json_schema",
    validate: validateStory,
  });
  assert.equal(result.provider, "groq");
  assert.equal(requests.length, 1);

  const sent = groqRequests()[0].body.response_format;
  assert.equal(sent.type, "json_schema", "structured output must stay json_schema (no silent format switch)");
  assert.equal(sent.json_schema.name, "analysis_result");
  assert.equal(sent.json_schema.strict, true);
  const sentSchema = sent.json_schema.schema as Record<string, any>;

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

  // Root AND the reported failure path /properties/characters/items, plus events items.
  assert.deepEqual(
    objectPaths.sort(),
    ["$", "$.properties.characters.items", "$.properties.events.items"],
  );
  assert.equal(sentSchema.additionalProperties, false);
  assert.equal(sentSchema.properties.characters.items.additionalProperties, false, "/properties/characters/items must set additionalProperties:false");
  assert.equal(sentSchema.properties.events.items.additionalProperties, false);
});

// ---------------------------------------------------------------------------
// Task 2/5: malformed schema fails BEFORE any API request
// ---------------------------------------------------------------------------

test("malformed schema fails before any request (no provider burn-through)", async () => {
  responder = () => okJson(STORY_JSON);
  const badSchema = {
    type: "object",
    properties: { characters: { anyOf: [{ type: "array" }, { type: "string" }] } },
    required: ["characters"],
  };
  await assert.rejects(
    requestStructuredJson({
      system: "Return strict JSON only.",
      user: "Analyze the transcript part.",
      schema: badSchema,
      mode: "json_schema",
      validate: validateStory,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
      assert.equal(error.reason, "invalid_schema");
      return true;
    },
  );
  assert.equal(requests.length, 0, "no request may be sent for an invalid schema");
});

// ---------------------------------------------------------------------------
// Task 6: empty provider response → EMPTY_RESPONSE, no JSON.parse crash
// ---------------------------------------------------------------------------

test("empty provider response is marked EMPTY_RESPONSE with metadata and falls through", async () => {
  responder = () => emptyJson();
  const attempts: Array<{ provider: string; outcome: string; reason?: string }> = [];
  await assert.rejects(
    requestStructuredJson({
      system: "Return strict JSON only.",
      user: "Analyze the transcript part.",
      schema: STORY_SHAPE_SCHEMA,
      mode: "json_schema",
      validate: validateStory,
      onAttempt: (info) => attempts.push({ provider: info.provider, outcome: info.outcome, reason: info.reason }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /All providers exhausted\./);
      assert.match(error.message, /empty_response/);
      assert.match(error.message, /provider=groq/);
      assert.match(error.message, /provider=openrouter/);
      return true;
    },
  );
  assert.equal(requests.length, 2, "each provider was tried once");
  assert.deepEqual(
    attempts.map((a) => [a.provider, a.outcome, a.reason]),
    [["groq", "failed", "empty_response"], ["openrouter", "failed", "empty_response"]],
  );
});

// ---------------------------------------------------------------------------
// Task 7: 503 is transient overload → next provider (not a schema failure)
// ---------------------------------------------------------------------------

test("HTTP 503 from groq falls back to the next provider", async () => {
  responder = (req) => (req.path.startsWith("/groq/") ? { status: 503, raw: "overloaded, try again later" } : okJson(STORY_JSON));
  const attempts: Array<{ provider: string; outcome: string; reason?: string }> = [];
  const result = await requestStructuredJson({
    system: "Return strict JSON only.",
    user: "Analyze the transcript part.",
    schema: STORY_SHAPE_SCHEMA,
    mode: "json_schema",
    validate: validateStory,
    onAttempt: (info) => attempts.push({ provider: info.provider, outcome: info.outcome, reason: info.reason }),
  });
  assert.equal(result.provider, "openrouter");
  assert.equal(groqRequests().length, 1);
  assert.equal(openRouterRequests().length, 1);
  assert.deepEqual(attempts, [
    { provider: "groq", outcome: "failed", reason: "http_503" },
    { provider: "openrouter", outcome: "passed", reason: undefined },
  ]);
});

// ---------------------------------------------------------------------------
// Task 5: HTTP 400 schema rejection → ONE retry, then fail fast
// ---------------------------------------------------------------------------

test("HTTP 400 schema rejection retries once then fails fast (no provider burn-through)", async () => {
  let openrouterHits = 0;
  responder = (req) => {
    if (req.path.startsWith("/openrouter/")) {
      openrouterHits += 1;
      return okJson(STORY_JSON);
    }
    return GROQ_400_SCHEMA;
  };
  await assert.rejects(
    requestStructuredJson({
      system: "Return strict JSON only.",
      user: "Analyze the transcript part.",
      schema: STORY_SHAPE_SCHEMA,
      mode: "json_schema",
      validate: validateStory,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
      assert.equal(error.reason, "invalid_schema", "deterministic configuration error");
      assert.match(error.message, /All providers exhausted\./);
      assert.match(error.message, /groq/);
      assert.doesNotMatch(error.message, /openrouter/);
      return true;
    },
  );
  assert.equal(groqRequests().length, 2, "initial attempt + exactly ONE retry");
  assert.equal(openrouterHits, 0, "remaining providers must not be burned with the same schema");
  // Both groq requests used the strict envelope (retry is a normalized retry,
  // not a silent downgrade).
  for (const req of groqRequests()) {
    assert.equal(req.body.response_format.type, "json_schema");
    assert.equal(req.body.response_format.json_schema.schema.additionalProperties, false);
  }
});

// ---------------------------------------------------------------------------
// Task 3/5: unsupported structured-output mode → one downgrade, no repeat
// ---------------------------------------------------------------------------

test("unsupported strict format downgrades to json_object once on the same provider", async () => {
  let groqCalls = 0;
  responder = (req) => {
    if (req.path.startsWith("/groq/")) {
      groqCalls += 1;
      return groqCalls === 1 ? GROQ_400_UNSUPPORTED : okJson(STORY_JSON);
    }
    return okJson(STORY_JSON);
  };
  const result = await requestStructuredJson({
    system: "Return strict JSON only.",
    user: "Analyze the transcript part.",
    schema: STORY_SHAPE_SCHEMA,
    mode: "json_schema",
    validate: validateStory,
  });
  assert.equal(result.provider, "groq");
  assert.equal(groqRequests().length, 2, "no repeated retries of the same strict request");
  assert.equal(groqRequests()[0].body.response_format.type, "json_schema");
  assert.deepEqual(groqRequests()[1].body.response_format, { type: "json_object" });
  assert.equal(openRouterRequests().length, 0);
});

// ---------------------------------------------------------------------------
// Successful structured JSON
// ---------------------------------------------------------------------------

test("valid structured JSON succeeds on the first provider", async () => {
  responder = () => okJson(STORY_JSON);
  const result = await requestStructuredJson({
    system: "Return strict JSON only.",
    user: "Analyze the transcript part.",
    schema: STORY_SHAPE_SCHEMA,
    mode: "json_schema",
    validate: validateStory,
  });
  assert.equal(result.provider, "groq");
  assert.equal(result.model, "openai/gpt-oss-120b");
  assert.equal(requests.length, 1);
  assert.equal(groqRequests()[0].body.model, "openai/gpt-oss-120b");
  assert.deepEqual(JSON.parse(result.content), STORY_JSON);
});

// ---------------------------------------------------------------------------
// Task 2: shared normalizer unit behavior
// ---------------------------------------------------------------------------

test("normalizer: story shape → additionalProperties:false on every object, full required lists", () => {
  const audit = auditStrictSchema(STORY_SHAPE_SCHEMA);
  assert.ok(audit.ok, `expected fixable schema, got hard issues: ${JSON.stringify(audit.hardIssues)}`);
  assert.ok(audit.fixes.length >= 3, "root + characters.items + events.items need fixes");

  const { ok, schema, fixes } = normalizeStrictSchema(STORY_SHAPE_SCHEMA);
  assert.ok(ok);
  assert.ok(schema);
  assert.ok(fixes.length >= 3);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.characters.items.additionalProperties, false, "the reported /properties/characters/items path is fixed");
  assert.equal(schema.properties.events.items.additionalProperties, false);
  assert.deepEqual(
    (schema.properties.characters.items.required as string[]).sort(),
    ["description", "firstSeenSec", "name", "role"],
  );
  assert.deepEqual(
    (schema.properties.events.items.required as string[]).sort(),
    ["cause", "characters", "effect", "endSegment", "importance", "startSegment", "summary"],
  );
  assert.deepEqual((schema.required as string[]).sort(), ["arc", "characters", "events"]);
});

test("normalizer: malformed schemas are rejected with hard issues and a null schema", () => {
  const cases: Array<Record<string, unknown>> = [
    { type: "object", properties: { a: { oneOf: [{ type: "string" }] } } },
    { type: "object", properties: { a: { $ref: "#/definitions/x" } } },
    { type: "object", properties: { a: { type: "string", enum: [] } } },
    { type: "object", properties: { a: { type: "array" } } },
    { type: "object", properties: { a: { type: "string" } }, required: ["missing"] },
  ];
  for (const schema of cases) {
    const result = normalizeStrictSchema(schema);
    assert.equal(result.ok, false, `expected hard issues for ${JSON.stringify(schema)}`);
    assert.equal(result.schema, null);
    assert.ok(result.hardIssues.length > 0);
  }
});

test("normalizer: already-strict schema needs no fixes and is not mutated; cache is stable", () => {
  const strict = {
    type: "object",
    additionalProperties: false,
    required: ["clips"],
    properties: {
      clips: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" } } },
      },
    },
  };
  const first = normalizeStrictSchema(strict);
  assert.equal(first.ok, true);
  assert.equal(first.fixes.length, 0);
  assert.notEqual(first.schema, strict, "always returns a defensive copy");
  assert.deepEqual(first.schema, strict);
  const second = normalizeStrictSchema(strict);
  assert.equal(second, first, "cached result for the same schema reference");

  const mutated = normalizeStrictSchema(STORY_SHAPE_SCHEMA);
  assert.ok(mutated.schema);
  assert.notEqual(mutated.schema, STORY_SHAPE_SCHEMA, "must not mutate the caller's schema");
  assert.equal((STORY_SHAPE_SCHEMA.required as string[]).length, 1, "original required list untouched");
  assert.ok(!("additionalProperties" in STORY_SHAPE_SCHEMA), "original root untouched");
});
