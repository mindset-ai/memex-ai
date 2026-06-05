// Service for the `get_information` MCP tool.
//
// Reads JSON topic files from packages/server/src/guidance/. Each file is
// a single object with exactly three string fields:
//   - title         — human-readable topic name
//   - when_to_read  — short situational hint, surfaced in the topic index
//   - body          — the full guidance content (markdown-flavoured prose)
//
// Drop a new `<slug>.json` file in the directory and `get_information`
// picks it up automatically — no parsing, no registry, no code change.
//
// V0.0.1: hot-loads on every call (cheap — small directory, small files).
// Caching can be layered on later if it shows up in profiles; not before.
//
// Why this exists: the MCP `instructions` field is truncated by Claude
// Code around the first ~2.6 KB, so 80%+ of the operating guidance the
// server wants to convey can't be delivered via that channel. This tool
// lets agents pull depth on demand. The tiny surviving prefix in
// MEMEX_AGENT_INSTRUCTIONS announces this tool; tool descriptions and
// tool responses can also point at specific topics.

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NotFoundError, ValidationError } from "../types/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDANCE_DIR = join(__dirname, "..", "guidance");

export interface Topic {
  topic: string;
  title: string;
  whenToRead: string;
  body: string;
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function loadFromRaw(slug: string, raw: string): Topic {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ValidationError(
      `guidance/${slug}.json is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ValidationError(`guidance/${slug}.json must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!isStr(obj.title) || !isStr(obj.when_to_read) || !isStr(obj.body)) {
    throw new ValidationError(
      `guidance/${slug}.json must have string fields: title, when_to_read, body`,
    );
  }
  return {
    topic: slug,
    title: obj.title,
    whenToRead: obj.when_to_read,
    body: obj.body,
  };
}

function slugOf(filename: string): string {
  return filename.replace(/\.json$/, "");
}

function isValidSlug(slug: string): boolean {
  // Slug discipline: [a-z0-9-]. Defence-in-depth so a malformed `topic`
  // arg cannot path-traverse out of the guidance directory.
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

/**
 * List available guidance topics. Each entry carries the slug (used as
 * the `topic` argument to fetchTopic), title, and a "when to read" hint.
 * Body content is NOT included — fetch it via fetchTopic.
 */
export async function listTopics(): Promise<Array<Omit<Topic, "body">>> {
  const entries = await readdir(GUIDANCE_DIR);
  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();
  const out: Array<Omit<Topic, "body">> = [];
  for (const filename of jsonFiles) {
    const slug = slugOf(filename);
    if (!isValidSlug(slug)) continue; // skip oddly-named files silently
    const raw = await readFile(join(GUIDANCE_DIR, filename), "utf8");
    const topic = loadFromRaw(slug, raw);
    out.push({
      topic: topic.topic,
      title: topic.title,
      whenToRead: topic.whenToRead,
    });
  }
  return out;
}

/**
 * Fetch one topic by slug. Throws NotFoundError if the slug doesn't match
 * a file in the guidance directory.
 */
export async function fetchTopic(topic: string): Promise<Topic> {
  if (!isValidSlug(topic)) {
    throw new NotFoundError(`Unknown guidance topic: "${topic}"`);
  }
  const filename = `${topic}.json`;
  let raw: string;
  try {
    raw = await readFile(join(GUIDANCE_DIR, filename), "utf8");
  } catch {
    throw new NotFoundError(`Unknown guidance topic: "${topic}"`);
  }
  return loadFromRaw(topic, raw);
}
