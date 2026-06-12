/**
 * Pull the FIRST balanced JSON object out of model output. Models sometimes
 * append prose or a second object after the JSON; naive slice(indexOf("{"),
 * lastIndexOf("}")) then captures junk and JSON.parse throws "Unexpected
 * non-whitespace character after JSON".
 */
export function extractJson<T>(text: string): T {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("no JSON in model response");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as T;
    }
  }
  throw new Error("unbalanced JSON in model response");
}
