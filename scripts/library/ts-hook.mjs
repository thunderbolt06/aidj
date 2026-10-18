/**
 * Lets a plain `node --experimental-strip-types` script import the app's
 * server modules (lib/server/*.ts) the way Next.js resolves them: `@/` is the
 * repo root, extensionless imports find their `.ts`, and JSON imports need no
 * `with { type: "json" }`. Used by eval_recs.mjs:
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/library/ts-hook.mjs <script>
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!globalThis.__tsHookRegistered) {
  globalThis.__tsHookRegistered = true;
  register(import.meta.url, import.meta.url);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function withExtension(file) {
  for (const f of [file, `${file}.ts`, `${file}.tsx`, path.join(file, "index.ts")])
    if (existsSync(f) && !f.endsWith("/")) return f;
  return file;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/"))
    return { url: pathToFileURL(withExtension(path.join(ROOT, specifier.slice(2)))).href, shortCircuit: true };
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.endsWith(".ts")) {
    const file = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    return { url: pathToFileURL(withExtension(file)).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".json")) {
    const text = await readFile(fileURLToPath(url), "utf8");
    return { format: "module", source: `export default ${text};`, shortCircuit: true };
  }
  return next(url, context);
}
