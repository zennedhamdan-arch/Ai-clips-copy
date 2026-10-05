/**
 * Shared strict-JSON-schema layer for structured-output providers.
 *
 * OpenAI-compatible strict structured output (Groq, OpenRouter) requires:
 *   1. `additionalProperties: false` on EVERY object schema — the root object
 *      AND every `items` schema of an object array (the classic failure is
 *      `/properties/characters/items`).
 *   2. every key declared in `properties` listed in `required` (strict mode
 *      has no "optional" fields).
 *   3. an explicit `type` on every node.
 *
 * Optional fields: strict mode has no "optional", so a property that the
 * application does NOT mark as required in the source schema is promoted to
 * a NULLABLE required field — `type: ["<t>", "null"]` (Groq's documented
 * pattern for optional fields, see console.groq.com/docs/structured-outputs).
 * The model then always emits the key (satisfying `required`) but may emit
 * `null` instead of inventing a fake value. Non-scalar optionals (arrays,
 * nested objects) cannot be nulled without `anyOf` (unsupported in strict
 * mode), so they stay non-nullable and simply become required — an empty
 * array/object is a valid, cheap value for the model.
 *
 * Pipeline:  original schema → normalizeStrictSchema() →
 * validateFinalStrictSchema() → FINAL PROVIDER SCHEMA → API request.
 * Both steps fail LOCALLY (before any HTTP request) when the schema cannot
 * be expressed in strict mode.
 */

export type StrictSchemaIssue = { path: string; message: string };

export type StrictSchemaAudit = {
  /** True when the schema is expressible in strict mode (after normalization). */
  ok: boolean;
  /** Hard, unfixable problems — the schema must be repaired by hand. */
  hardIssues: StrictSchemaIssue[];
  /** Soft changes the normalizer applies (nullable promotion, required, …). */
  fixes: string[];
};

export type StrictSchemaNormalization = {
  ok: boolean;
  /** Strict-safe normalized copy of the schema, or null when !ok. */
  schema: Record<string, unknown> | null;
  hardIssues: StrictSchemaIssue[];
  /** Human-readable list of what the normalizer changed (for logging). */
  fixes: string[];
};

export type StrictSchemaValidation = {
  ok: boolean;
  /** Invariants violated by a FINAL (already-normalized) provider schema. */
  issues: StrictSchemaIssue[];
};

type SchemaNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);
const ALL_TYPES = new Set([...SCALAR_TYPES, "object", "array", "null"]);

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

/** type must be a known scalar, or ["<scalar>", "null"] (nullable). */
function nullableTypeFor(type: unknown): string[] | null {
  if (typeof type === "string" && SCALAR_TYPES.has(type)) return [type, "null"];
  if (Array.isArray(type) && type.length === 2 && type.includes("null")) {
    const base = type.find((t) => t !== "null");
    if (typeof base === "string" && SCALAR_TYPES.has(base)) return [base, "null"];
  }
  return null;
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
    hardIssues.push({ path, message: "nullable is not supported in strict structured output (use a type union with null)" });
  }
  if (Array.isArray(node.enum)) {
    if (node.enum.length === 0) {
      hardIssues.push({ path, message: "enum must not be empty in strict structured output" });
    } else if (node.enum.length > 100) {
      hardIssues.push({ path, message: "enum is too large for strict structured output" });
    }
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
        if (!required.includes(name)) {
          // Conceptually optional → will be promoted to nullable+required.
          const child = props[name];
          const nullable = isPlainObject(child) ? nullableTypeFor(child.type) : null;
          if (nullable) {
            fixes.push(`${path}: property "${name}" is optional → nullable ${JSON.stringify(nullable)} + required`);
          } else {
            fixes.push(`${path}: property "${name}" is optional → required (non-scalar stays non-nullable)`);
          }
        }
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
    if (typeof node.minItems === "number" && typeof node.maxItems === "number" && node.minItems > node.maxItems) {
      hardIssues.push({ path, message: "minItems is greater than maxItems" });
    }
  } else if (typeof node.type === "string") {
    if (!ALL_TYPES.has(node.type)) {
      hardIssues.push({ path, message: `unsupported type "${node.type}" in strict structured output` });
    }
    if (typeof node.minLength === "number" && typeof node.maxLength === "number" && node.minLength > node.maxLength) {
      hardIssues.push({ path, message: "minLength is greater than maxLength" });
    }
    if (typeof node.minimum === "number" && typeof node.maximum === "number" && node.minimum > node.maximum) {
      hardIssues.push({ path, message: "minimum is greater than maximum" });
    }
  } else if (Array.isArray(node.type)) {
    const ok = node.type.length === 2 && node.type.includes("null") &&
      typeof node.type.find((t) => t !== "null") === "string" &&
      SCALAR_TYPES.has(node.type.find((t) => t !== "null") as string);
    if (!ok) {
      hardIssues.push({ path, message: `unsupported type union ${JSON.stringify(node.type)} (only ["<scalar>", "null"] is allowed)` });
    }
  } else if (node.type === undefined) {
    hardIssues.push({ path, message: "schema node must declare a type in strict structured output" });
  }
}

/**
 * Inspect a schema for strict structured-output compatibility.
 * `hardIssues` are unfixable by construction; `fixes` describe what the
 * normalizer would change. The input is never mutated.
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
      const originalRequired = Array.isArray(node.required) ? (node.required as unknown[]).filter((r) => typeof r === "string") : [];
      const required: string[] = [...(originalRequired as string[])];
      for (const [name, child] of Object.entries(props)) {
        if (!required.includes(name)) required.push(name);
        // Conceptually optional scalar → nullable (the model may emit null
        // instead of inventing a value); the key itself stays required.
        if (!originalRequired.includes(name) && isPlainObject(child)) {
          const nullable = nullableTypeFor(child.type);
          if (nullable) child.type = nullable;
        }
        applyFixes(child, `${path}.properties.${name}`);
      }
      node.required = required;
    }
  } else if (node.type === "array" && node.items !== undefined) {
    applyFixes(node.items, `${path}.items`);
  }
}

const normalizationCache = new WeakMap<Record<string, unknown>, StrictSchemaNormalization>();

/**
 * Normalize a schema into a strict-safe copy (or null with `hardIssues` when
 * it cannot be expressed in strict mode — the request must then fail
 * BEFORE any API call). Safe for repeated calls on the same schema
 * reference. The caller's schema is never mutated.
 */
export function normalizeStrictSchema(schema: Record<string, unknown>): StrictSchemaNormalization {
  const cached = normalizationCache.get(schema);
  if (cached) return cached;
  const { hardIssues, fixes } = auditStrictSchema(schema);
  const result: StrictSchemaNormalization = { ok: hardIssues.length === 0, schema: null, hardIssues, fixes };
  if (result.ok) {
    const clone: Record<string, unknown> = structuredClone(schema);
    applyFixes(clone, "$");
    // Defense in depth: the normalized output must itself satisfy the
    // final-schema invariants before it is ever sent to a provider.
    const selfCheck = validateFinalStrictSchema(clone);
    if (!selfCheck.ok) {
      result.ok = false;
      result.schema = null;
      result.hardIssues.push(...selfCheck.issues.map((issue) => ({ path: `${issue.path} (after normalization)`, message: issue.message })));
    } else {
      result.schema = clone;
    }
  }
  normalizationCache.set(schema, result);
  return result;
}

/**
 * Validate a FINAL provider schema (the exact object that will be sent in
 * the strict json_schema envelope). Every invariant Groq/OpenAI strict mode
 * enforces is checked here, LOCALLY, before the HTTP request:
 *   - every object has additionalProperties: false and an explicit type
 *   - every property is listed in required (and vice versa)
 *   - arrays define items
 *   - types are supported (scalars, objects, arrays, ["<scalar>", "null"])
 *   - no unsupported constructs, no contradictory constraints
 */
export function validateFinalStrictSchema(schema: Record<string, unknown>): StrictSchemaValidation {
  const issues: StrictSchemaIssue[] = [];

  const checkType = (node: SchemaNode, path: string): void => {
    if (Array.isArray(node.type)) {
      const ok = node.type.length === 2 && node.type.includes("null") &&
        typeof node.type.find((t) => t !== "null") === "string" &&
        SCALAR_TYPES.has(node.type.find((t) => t !== "null") as string);
      if (!ok) issues.push({ path, message: `final schema must use a scalar type or ["<scalar>", "null"], got ${JSON.stringify(node.type)}` });
    } else if (typeof node.type !== "string" || !ALL_TYPES.has(node.type)) {
      issues.push({ path, message: `final schema node must have a supported type, got ${JSON.stringify(node.type)}` });
    }
    if (typeof node.minLength === "number" && typeof node.maxLength === "number" && node.minLength > node.maxLength) {
      issues.push({ path, message: "minLength is greater than maxLength" });
    }
    if (typeof node.minimum === "number" && typeof node.maximum === "number" && node.minimum > node.maximum) {
      issues.push({ path, message: "minimum is greater than maximum" });
    }
  };

  const walkFinal = (node: unknown, path: string): void => {
    if (!isPlainObject(node)) {
      issues.push({ path, message: "schema node must be an object" });
      return;
    }
    for (const [key, message] of Object.entries(UNSUPPORTED_KEYS)) {
      if (key in node) issues.push({ path, message: `${message} (found "${key}")` });
    }
    if (node.nullable === true) issues.push({ path, message: "nullable is not allowed in the final strict schema" });
    if (Array.isArray(node.enum) && node.enum.length === 0) issues.push({ path, message: "enum must not be empty" });

    if (node.type === "object" || (node.type === undefined && (isPlainObject(node.properties) || Array.isArray(node.required)))) {
      if (node.type !== "object") issues.push({ path, message: "object node must declare type \"object\"" });
      if (node.additionalProperties !== false) issues.push({ path, message: "object must set additionalProperties false" });
      const props = isPlainObject(node.properties) ? node.properties : undefined;
      const required = Array.isArray(node.required) ? (node.required as unknown[]).filter((r) => typeof r === "string") : [];
      if (props) {
        for (const [name, child] of Object.entries(props)) {
          if (!required.includes(name)) issues.push({ path, message: `property "${name}" is not listed in required` });
          walkFinal(child, `${path}.properties.${name}`);
        }
        for (const name of required) {
          if (!Object.hasOwn(props, name)) issues.push({ path, message: `required property "${name}" is not declared in properties` });
        }
      } else if (required.length) {
        issues.push({ path, message: "required is declared without properties" });
      }
    } else if (node.type === "array") {
      if (node.items === undefined) issues.push({ path, message: "array must define items" });
      else walkFinal(node.items, `${path}.items`);
      if (typeof node.minItems === "number" && typeof node.maxItems === "number" && node.minItems > node.maxItems) {
        issues.push({ path, message: "minItems is greater than maxItems" });
      }
    } else {
      checkType(node, path);
    }
  };

  walkFinal(schema, "$");
  if (schema.type !== "object" && !(schema.type === undefined && (isPlainObject(schema.properties) || Array.isArray(schema.required)))) {
    issues.unshift({ path: "$", message: "final schema root must be an object" });
  }
  return { ok: issues.length === 0, issues };
}
