import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, "skills");

const cache = new Map<string, string>();
// Skills are edited frequently in dev; re-read each call so .md changes show up
// without a server restart. In production they're static, so we cache.
const shouldCache = process.env.NODE_ENV === "production";

/**
 * Load a skill markdown file by name (without extension) and return its contents.
 *
 * Skills are reference documents injected into system prompts — each captures a
 * discrete slice of domain knowledge (e.g. what a Spec document is). Callers
 * opt into specific skills at the point they build a prompt, so the knowledge
 * scales horizontally without the base prompt growing unbounded.
 */
export function loadSkill(name: string): string {
  if (shouldCache) {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
  }

  const path = resolve(SKILLS_DIR, `${name}.md`);
  const contents = readFileSync(path, "utf8");
  if (shouldCache) cache.set(name, contents);
  return contents;
}
