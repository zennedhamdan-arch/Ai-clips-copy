/**
 * Node loader hooks for running the TypeScript sources with the built-in test
 * runner (node --experimental-strip-types):
 *   - resolves the repository's "@/lib/…" style aliases to src/ paths
 *   - resolves extensionless relative imports (and directory imports) to .ts
 * No dependencies, no build step.
 */
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tryResolve(absPath) {
  const fileCandidates = [`${absPath}.ts`, `${absPath}.js`];
  const dirCandidates = [path.join(absPath, "index.ts"), path.join(absPath, "index.js")];
  for (const candidate of [...fileCandidates, ...dirCandidates]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return pathToFileURL(candidate).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const mapped = path.join(root, "src", specifier.slice(2));
    const resolved = tryResolve(mapped);
    if (resolved) return nextResolve(resolved, context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !path.extname(specifier) && context.parentURL) {
    const parent = fileURLToPath(context.parentURL);
    const base = path.resolve(path.dirname(parent), specifier);
    const resolved = tryResolve(base);
    if (resolved) return nextResolve(resolved, context);
  }
  return nextResolve(specifier, context);
}
