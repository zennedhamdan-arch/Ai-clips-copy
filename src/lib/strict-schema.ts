/**
 * Shared strict-JSON-schema layer for structured-output providers.
 *
 * OpenAI-compatible strict structured output (Groq, OpenRouter) requires:
 *   1. `additionalProperties: false` on EVERY object schema — the root object
 *      AND every `items` schema of an object array (the classic failure is
 *      `/properties/characters/items`).
 *   2. every key declared in `properties` listed in `required` (strict mode
 *      does not support optional fields).
 *   3. an explicit `type` on every node.
 *
 * These rules are enforced recursively, provider-agnostically, in this single
 * module — no provider-specific copies. `normalizeStrictSchema` returns a
 * strict-safe deep copy (the caller's schema is never mutated) and reports the
 * hard, unfixable problems (`hardIssues`) that must make the request fail
 * BEFORE the API call.
 */

export type StrictSchemaIssue = { path: string; message: string };

export type StrictSchemaAudit = {
  /** True when the schema is expressible in strict mode (after soft fixes). */
  ok: boolean;
  /** Hard, unfixable problems — the schema must be repaired by hand. */
  hardIssues: StrictSchemaIssue[];
  /** Soft problems the normalizer fixes automatically. */
  fixes: string[];
};

export type StrictSchemaNormalization = {
  ok: boolean;
  /** Strict-safe normalized copy of the schema, or null when !ok. */
  schema: Record<string, unknown> | null;
  hardIssues: StrictSchemaIssue[];
  /** Human-readable list of what the normalizer added (for logging). */
  fixes: string[];
};

type SchemaNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that have no strict-mode representation and cannot be normalized. */
const UNSUPPORTED_KEYS: Record<string, string> = {
  anyOf: "anyOf is not supported in strict structured output",
  oneOf: "oneOf is not supported in strict structured output",
  allOf: "allOf is not supported in strict structured output",
  not: "not is not supported in strict structured output",
  $ref: "$ref is not supported in strict structured output",
  $id: "$id is not supported in strict structured output",
  const: "const is not supported in strict structured output",
  patternProperties: "patternProperties is not supported in strict structured output",
  dependencies: "dependencies is not supported in strict structured output",
  definitions: "definitions must be inlined for strict structured output",
  $defs: "$defs must be inlined for strict structured output",
};

function isObjectNode(node: SchemaNode): boolean {
  if (node.type === "object") return true;
  // Implicit object: no explicit type but a properties/required declaration.
  return node.type === undefined && (isPlainObject(node.properties) || Array.isArray(node.required));
}

function walk(node: unknown, path: string, hardIssues: StrictSchemaIssue[], fixes: string[]): void {
  if (!isPlainObject(node)) {
    hardIssues.push({ path, message: "schema node must be an object" });
    return;
  }
  for (const [key, message] of Object.entries(UNSUPPORTED_KEYS)) {
    if (key in node) hardIssues.push({ path, message: `${message} (found "${key}")` });
  }
  if (node.nullable === true) {
    hardIssues.push({ path, message: "nullable is not supported in strict structured output" });
  }
  if (Array.isArray(node.enum) && node.enum.length === 0) {
    hardIssues.push({ path, message: "enum must not be empty in strict structured output" });
  }

  if (isObjectNode(node)) {
    const props = isPlainObject(node.properties) ? node.properties : undefined;
    if (props) {
      for (const [name, child] of Object.entries(props)) {
        walk(child, `${path}.properties.${name}`, hardIssues, fixes);
      }
    }
    const required: string[] = [];
    if (Array.isArray(node.required)) {
      for (const entry of node.required) {
        if (typeof entry === "string") required.push(entry);
        else hardIssues.push({ path, message: "required entries must be strings" });
      }
    }
    if (props) {
      for (const name of Object.keys(props)) {
        if (!required.includes(name)) fixes.push(`${path}: promoted property "${name}" to required`);
      }
      for (const name of required) {
        if (!Object.hasOwn(props, name)) {
          hardIssues.push({ path, message: `required property "${name}" is not declared in properties` });
        }
      }
    }
    if (node.type === undefined) fixes.push(`${path}: added explicit type "object"`);
    if (node.additionalProperties !== false) fixes.push(`${path}: added additionalProperties false`);
  } else if (node.type === "array") {
    if (!("items" in node) || node.items === undefined) {
      hardIssues.push({ path, message: "array schemas must define items in strict structured output" });
    } else {
      walk(node.items, `${path}.items`, hardIssues, fixes);
    }
  } else if (node.type === undefined) {
    hardIssues.push({ path, message: "schema node must declare a type in strict structured output" });
  }
}

/**
 * Inspect a schema for strict structured-output compatibility.
 * `hardIssues` are unfixable by construction; `fixes` are what the normalizer
 * would add. The input is never mutated.
 */
export function auditStrictSchema(schema: Record<string, unknown>): StrictSchemaAudit {
  const hardIssues: StrictSchemaIssue[] = [];
  const fixes: string[] = [];
  walk(schema, "$", hardIssues, fixes);
  return { ok: hardIssues.length === 0, hardIssues, fixes };
}

/** Apply the soft fixes mechanically to a (cloned) schema. */
function applyFixes(node: unknown, path: string): void {
  if (!isPlainObject(node)) return;
  if (isObjectNode(node)) {
    if (node.type === undefined) node.type = "object";
    if (node.additionalProperties !== false) node.additionalProperties = false;
    const props = isPlainObject(node.properties) ? node.properties : undefined;
    if (props) {
      const required: unknown[] = Array.isArray(node.required) ? [...node.required] : [];
      for (const name of Object.keys(props)) {
        if (!required.includes(name)) required.push(name);
      }
      node.required = required;
      for (const [name, child] of Object.entries(props)) {
        applyFixes(child, `${path}.properties.${name}`);
      }
    }
  } else if (node.type === "array" && node.items !== undefined) {
    applyFixes(node.items, `${path}.items`);
  }
}

const normalizationCache = new WeakMap<Record<string, unknown>, StrictSchemaNormalization>();

/**
 * Return a strict-safe copy of `schema` (or null with `hardIssues` when the
 * schema cannot be expressed in strict mode and must fail before the API
 * request). Safe for repeated calls on the same schema reference.
 */
export function normalizeStrictSchema(schema: Record<string, unknown>): StrictSchemaNormalization {
  const cached = normalizationCache.get(schema);
  if (cached) return cached;
  const { hardIssues, fixes } = auditStrictSchema(schema);
  const result: StrictSchemaNormalization = { ok: hardIssues.length === 0, schema: null, hardIssues, fixes };
  if (result.ok) {
    const clone: Record<string, unknown> = structuredClone(schema);
    applyFixes(clone, "$");
    result.schema = clone;
  }
  normalizationCache.set(schema, result);
  return result;
}
