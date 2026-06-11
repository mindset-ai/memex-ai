// spec-190 t-7 (dec-7): the guide-content import pipeline — the machine half of
// dec-7's freshness enforcement loop (the human half is the Memex standard).
//
// Reads the repo's `guide-content/` authoring directory, validates every
// frontmatter reference against the t-4 guide registry, chunks each file into
// heading-bounded sections, and upserts them into the guide_content table
// (t-6's upsertGuideChunk). It is idempotent — unchanged chunks (same
// content_hash) are never re-embedded — and prunes rows whose source file no
// longer exists, so it is safe to run on every deploy (ac-18).
//
// Two run modes:
//   * full import (default): validate → upsert every chunk → prune orphans.
//   * check mode (--check / { check: true }): validate ONLY, no DB writes and no
//     embeddings. Used as a CI gate (dec-7c) so a bad frontmatter reference fails
//     the build before it ever reaches a deploy.
//
// Validation rules (ac-18):
//   * ERROR — a screens/<key>.md whose frontmatter `screen` is not a known screen
//     key, or whose basename doesn't match its `screen`, or that references an
//     element id not registered on that screen.
//   * WARN  — a registered screen (one the registry has elements for) with no
//     screens/<key>.md authored yet.
//
// Authoring shape (dec-7a):
//   guide-content/screens/<screen-key>.md  — frontmatter: `screen`, `elements: [..]`
//   guide-content/concepts/*.md            — cross-screen, search-only (screen_key NULL)
//
// Embeddings ride on t-6's upsertGuideChunk → resolveEmbeddingProvider() (Cohere
// default, NOT OpenAI). When no provider is configured rows land without vectors
// and FTS covers (spec-64 posture) — the import never fails for lack of a key.

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  isKnownScreenKey,
  isKnownGuideElement,
  REGISTERED_SCREEN_KEYS,
  type GuideScreenKey,
} from "@memex/shared";
import type { GuideChunkInput } from "./guide-content.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

// The DB write layer is imported LAZILY (inside the non-check branch) so check
// mode — the CI frontmatter gate (dec-7c) — never pulls in db/connection.ts and
// therefore needs no DATABASE_URL. Validation is pure FS + registry work.

// Repo-root `guide-content/`, resolved from this module's location so it's
// correct regardless of the process CWD (the deploy runs from packages/server).
// services → src → server → packages → repo root (4 levels up).
const DEFAULT_GUIDE_CONTENT_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "guide-content",
);

export function resolveGuideContentDir(explicit?: string): string {
  return explicit ?? process.env.GUIDE_CONTENT_DIR ?? DEFAULT_GUIDE_CONTENT_DIR;
}

// The human/agent half of dec-7's enforcement loop: the Memex standard requiring
// that UI changes to a registered screen update the corresponding guide-content
// markdown in the same body of work (ac-21). This validator is the machine half;
// the handle links the two so an agent reading the code finds the rule.
// See https://memex.ai/mindset-prod/memex-building-itself/standards/std-29.
export const GUIDE_CONTENT_FRESHNESS_STANDARD = "std-29";

// ── Frontmatter parsing ─────────────────────────────────────────────────────
// Deliberately tiny — our frontmatter is only `key: scalar` and `key: [a, b, c]`
// lines between `---` fences. Avoids pulling a YAML dependency (std-24) for a
// format we fully control.

export interface Frontmatter {
  [key: string]: string | string[];
}

export function parseFrontmatter(raw: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const normalized = raw.replace(/^﻿/, ""); // strip BOM
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(normalized);
  if (!match) return { frontmatter: {}, body: normalized.trim() };

  const frontmatter: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      frontmatter[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
    } else {
      frontmatter[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }
  const body = normalized.slice(match[0].length).trim();
  return { frontmatter, body };
}

// ── Heading-bounded chunking ────────────────────────────────────────────────

export interface MarkdownChunk {
  heading: string | null;
  content: string;
}

const HEADING_RE = /^#{1,6}\s+(.*)$/;

/**
 * Split markdown into heading-bounded chunks: each chunk runs from a heading line
 * up to (but not including) the next heading. Any preamble before the first
 * heading becomes a leading chunk with a null heading. Empty chunks are dropped.
 */
export function chunkMarkdown(body: string): MarkdownChunk[] {
  const lines = body.split("\n");
  const chunks: MarkdownChunk[] = [];
  let heading: string | null = null;
  let buf: string[] = [];

  const flush = (): void => {
    const content = buf.join("\n").trim();
    if (content.length > 0) chunks.push({ heading, content });
    buf = [];
  };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      heading = m[1].trim();
    }
    buf.push(line);
  }
  flush();
  return chunks;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── File loading ────────────────────────────────────────────────────────────

export interface ParsedGuideFile {
  /** Path relative to the guide-content dir, e.g. "screens/specs-list.md". */
  sourcePath: string;
  /** Screen key for screens/*.md; null for concepts/*.md (search-only). */
  screenKey: GuideScreenKey | null;
  /** Element ids the frontmatter references (screens only). */
  elementRefs: string[];
  /** Whether this file lives under screens/ (vs concepts/). */
  isScreen: boolean;
  chunks: MarkdownChunk[];
}

async function readMarkdownDir(
  dir: string,
  subdir: string,
): Promise<Array<{ sourcePath: string; raw: string }>> {
  const full = join(dir, subdir);
  if (!existsSync(full)) return [];
  const entries = await readdir(full, { withFileTypes: true });
  const out: Array<{ sourcePath: string; raw: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const abs = join(full, entry.name);
    const raw = await readFile(abs, "utf-8");
    out.push({ sourcePath: relative(dir, abs), raw });
  }
  return out.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

export async function loadGuideContentFiles(dir: string): Promise<ParsedGuideFile[]> {
  const files: ParsedGuideFile[] = [];

  for (const { sourcePath, raw } of await readMarkdownDir(dir, "screens")) {
    const { frontmatter, body } = parseFrontmatter(raw);
    const screen = typeof frontmatter.screen === "string" ? frontmatter.screen : "";
    const elementRefs = Array.isArray(frontmatter.elements) ? frontmatter.elements : [];
    files.push({
      sourcePath,
      // Keep the raw declared value even if unknown — validation reports it.
      screenKey: (screen || null) as GuideScreenKey | null,
      elementRefs,
      isScreen: true,
      chunks: chunkMarkdown(body),
    });
  }

  for (const { sourcePath, raw } of await readMarkdownDir(dir, "concepts")) {
    const { body } = parseFrontmatter(raw);
    files.push({
      sourcePath,
      screenKey: null, // concepts are search-only
      elementRefs: [],
      isScreen: false,
      chunks: chunkMarkdown(body),
    });
  }

  return files;
}

// ── Validation (ac-18) ──────────────────────────────────────────────────────

export interface ValidationReport {
  errors: string[];
  warnings: string[];
}

export function validateGuideContent(files: ParsedGuideFile[]): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    if (!file.isScreen) continue; // concepts carry no screen/element bindings

    const declared = file.screenKey;
    if (!declared || !isKnownScreenKey(declared)) {
      errors.push(
        `${file.sourcePath}: frontmatter \`screen: ${declared ?? "(missing)"}\` is not a known screen key.`,
      );
      continue; // can't validate element refs without a valid screen
    }

    // Filename must match the declared screen (screens/<screen-key>.md).
    const expected = `${declared}.md`;
    if (basename(file.sourcePath) !== expected) {
      errors.push(
        `${file.sourcePath}: filename does not match frontmatter \`screen: ${declared}\` (expected screens/${expected}).`,
      );
    }

    for (const id of file.elementRefs) {
      if (!isKnownGuideElement(declared, id)) {
        errors.push(
          `${file.sourcePath}: element id \`${id}\` is not registered on screen \`${declared}\`.`,
        );
      }
    }

    if (file.chunks.length === 0) {
      warnings.push(`${file.sourcePath}: screen file has no content chunks.`);
    }
  }

  // WARN on registered screens (those the registry has elements for) with no file.
  const screensWithFiles = new Set(
    files.filter((f) => f.isScreen && f.screenKey).map((f) => f.screenKey),
  );
  for (const key of REGISTERED_SCREEN_KEYS) {
    if (!screensWithFiles.has(key)) {
      warnings.push(`registered screen \`${key}\` has no guide content authored yet.`);
    }
  }

  return { errors, warnings };
}

// ── Import orchestration ────────────────────────────────────────────────────

export interface ImportSummary {
  filesScanned: number;
  chunksSeen: number;
  chunksEmbedded: number;
  chunksReused: number;
  chunksWithoutVector: number;
  rowsPruned: number;
  report: ValidationReport;
  /** True when check mode ran (no DB writes). */
  checkOnly: boolean;
}

export class GuideContentValidationError extends Error {
  constructor(public readonly report: ValidationReport) {
    super(
      `guide-content validation failed with ${report.errors.length} error(s):\n` +
        report.errors.map((e) => `  - ${e}`).join("\n"),
    );
    this.name = "GuideContentValidationError";
  }
}

/**
 * Run the import. Validates first; throws GuideContentValidationError on any
 * referential error (so check mode and the deploy step both fail loudly on bad
 * frontmatter). In check mode it stops there. Otherwise it upserts every chunk
 * (idempotent by content_hash) and prunes rows whose source file is gone.
 */
export async function importGuideContent(
  opts: { dir?: string; check?: boolean; provider?: EmbeddingProvider | null } = {},
): Promise<ImportSummary> {
  const dir = resolveGuideContentDir(opts.dir);
  const files = await loadGuideContentFiles(dir);
  const report = validateGuideContent(files);

  if (report.errors.length > 0) {
    throw new GuideContentValidationError(report);
  }

  const summary: ImportSummary = {
    filesScanned: files.length,
    chunksSeen: 0,
    chunksEmbedded: 0,
    chunksReused: 0,
    chunksWithoutVector: 0,
    rowsPruned: 0,
    report,
    checkOnly: !!opts.check,
  };

  if (opts.check) return summary;

  // Lazy DB import — only the write path touches Postgres (see note at top).
  const { upsertGuideChunk, pruneGuideContent } = await import("./guide-content.js");

  const keepPaths: string[] = [];
  for (const file of files) {
    keepPaths.push(file.sourcePath);
    for (let index = 0; index < file.chunks.length; index++) {
      const chunk = file.chunks[index];
      summary.chunksSeen += 1;
      const input: GuideChunkInput = {
        // spec-222 t-7 (dec-3): the existing import is the in-product app corpus.
        // Website ingestion is a later task; this caller is always 'memex-app'.
        surface: "memex-app",
        screenKey: file.screenKey,
        sourcePath: file.sourcePath,
        chunkIndex: index,
        heading: chunk.heading,
        contentHash: hashContent(chunk.content),
        content: chunk.content,
      };
      const res = await upsertGuideChunk(input, { provider: opts.provider });
      if (res.status === "embedded") summary.chunksEmbedded += 1;
      else if (res.status === "reused") summary.chunksReused += 1;
      else if (res.status === "skipped-no-provider") summary.chunksWithoutVector += 1;
    }
  }

  // Surface-scoped prune (spec-222 t-7/t-8): the app import owns ONLY the
  // memex-app surface — it must never prune website rows (and vice versa).
  summary.rowsPruned = await pruneGuideContent("memex-app", keepPaths);
  return summary;
}

// ── Website corpus ingestion (spec-222 t-8, dec-3 → ac-13) ──────────────────
//
// The marketing site publishes a FLAT markdown artifact — `llms-full.txt` — with
// NO screens/concepts frontmatter (unlike the app corpus). This path ingests that
// single document into the SAME guide_content table under the SECOND surface,
// `memex-website`, REUSING the existing pipeline primitives:
//   * chunkMarkdown  — split the flat doc on heading boundaries (the same chunker
//     the app import uses), so retrieval lands on coherent sections.
//   * hashContent    — per-chunk change detection → idempotency (unchanged chunks
//     are NEVER re-embedded; upsertGuideChunk returns "reused").
//   * upsertGuideChunk — persist each chunk tagged `surface: "memex-website"`,
//     screen_key NULL (the website has no app screens — every website chunk is
//     search-only, never a Layer-1 screen pre-fetch).
//   * pruneGuideContent("memex-website", …) — prune orphans SCOPED to the website
//     surface only, so re-publishing a shorter doc removes stale website chunks
//     WITHOUT ever touching the app corpus.
//
// The app's screens/concepts import (importGuideContent above) is untouched and
// stays surface "memex-app"; the two ingestion paths share a table but never
// each other's surface.

// spec-251: the flat-artifact ingestion now serves MULTIPLE host-site surfaces
// (memex-website since spec-222 t-8; mindset-website since spec-251). The app's
// screens/concepts surface is NOT one of these — it has its own importer above.
export const WEBSITE_CORPUS_SURFACES = ["memex-website", "mindset-website"] as const;
export type WebsiteCorpusSurface = (typeof WEBSITE_CORPUS_SURFACES)[number];

export function isWebsiteCorpusSurface(s: string): s is WebsiteCorpusSurface {
  return (WEBSITE_CORPUS_SURFACES as readonly string[]).includes(s);
}

/** Stable source_path for the single published website artifact (the upsert key,
 *  with chunk_index). A constant — there's one flat doc, not a directory. */
export const WEBSITE_CORPUS_SOURCE_PATH = "llms-full.txt";

// spec-251 (CRITICAL): the guide_content upsert key is the UNIQUE index
// (source_path, chunk_index) — surface is NOT part of it (0079/0087). Two
// website surfaces sharing one source_path would silently OVERWRITE each
// other's rows on import (the upsert sets surface = EXCLUDED.surface). So every
// website surface gets a DISTINCT default source_path. memex-website keeps the
// original bare constant — its production rows already carry that key.
export const WEBSITE_CORPUS_SOURCE_PATH_BY_SURFACE: Record<WebsiteCorpusSurface, string> = {
  "memex-website": WEBSITE_CORPUS_SOURCE_PATH,
  "mindset-website": "mindset-website/llms-full.txt",
};

export interface WebsiteCorpusSource {
  /** Fetch the published artifact from this URL (e.g. https://memex.ai/llms-full.txt). */
  url?: string;
  /** Read the artifact from this local file path. */
  path?: string;
  /** Use this raw markdown directly (tests / piped input). Wins over url/path. */
  content?: string;
  /** Override the source_path written to each row (defaults to WEBSITE_CORPUS_SOURCE_PATH). */
  sourcePath?: string;
}

export interface WebsiteImportSummary {
  source: string;
  chunksSeen: number;
  chunksEmbedded: number;
  chunksReused: number;
  chunksWithoutVector: number;
  rowsPruned: number;
  /** True when check mode ran (fetch + chunk only, no DB writes). */
  checkOnly: boolean;
}

/** Resolve the website artifact's raw markdown from a string, local path, or URL. */
async function loadWebsiteCorpus(
  source: WebsiteCorpusSource,
): Promise<{ raw: string; origin: string }> {
  if (typeof source.content === "string") {
    return { raw: source.content, origin: "inline" };
  }
  if (source.path) {
    return { raw: await readFile(source.path, "utf-8"), origin: source.path };
  }
  if (source.url) {
    const res = await fetch(source.url);
    if (!res.ok) {
      throw new Error(
        `website corpus fetch failed: ${res.status} ${res.statusText} for ${source.url}`,
      );
    }
    return { raw: await res.text(), origin: source.url };
  }
  throw new Error("importWebsiteCorpus: provide one of { content, path, url }.");
}

/**
 * Ingest a host site's flat `llms-full.txt` into guide_content under that
 * site's surface (spec-222 t-8, dec-3 → ac-13; generalised for spec-251).
 * Defaults to `memex-website` so existing callers keep their behaviour.
 * Idempotent via content_hash; prunes orphans scoped to (surface, source_path)
 * only. In check mode it fetches + chunks but writes nothing (a bounded,
 * non-gating freshness probe).
 */
export async function importWebsiteCorpus(opts: {
  source: WebsiteCorpusSource;
  surface?: WebsiteCorpusSurface;
  check?: boolean;
  provider?: EmbeddingProvider | null;
}): Promise<WebsiteImportSummary> {
  const surface = opts.surface ?? "memex-website";
  if (!isWebsiteCorpusSurface(surface)) {
    throw new Error(
      `importWebsiteCorpus: "${surface}" is not a website corpus surface ` +
        `(expected one of: ${WEBSITE_CORPUS_SURFACES.join(", ")}).`,
    );
  }
  const { raw, origin } = await loadWebsiteCorpus(opts.source);
  const sourcePath =
    opts.source.sourcePath ?? WEBSITE_CORPUS_SOURCE_PATH_BY_SURFACE[surface];

  // The flat artifact has no frontmatter — strip any (defensively) and chunk the
  // whole body on heading boundaries, exactly as the app import does.
  const { body } = parseFrontmatter(raw);
  const chunks = chunkMarkdown(body);

  const summary: WebsiteImportSummary = {
    source: origin,
    chunksSeen: chunks.length,
    chunksEmbedded: 0,
    chunksReused: 0,
    chunksWithoutVector: 0,
    rowsPruned: 0,
    checkOnly: !!opts.check,
  };

  if (opts.check) return summary;

  // Lazy DB import — mirrors importGuideContent so check mode needs no DATABASE_URL.
  const { upsertGuideChunk, pruneGuideContentChunks } = await import("./guide-content.js");

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const input: GuideChunkInput = {
      surface,
      screenKey: null, // website chunks are search-only — no app screens
      sourcePath,
      chunkIndex: index,
      heading: chunk.heading,
      contentHash: hashContent(chunk.content),
      content: chunk.content,
    };
    const res = await upsertGuideChunk(input, { provider: opts.provider });
    if (res.status === "embedded") summary.chunksEmbedded += 1;
    else if (res.status === "reused") summary.chunksReused += 1;
    else if (res.status === "skipped-no-provider") summary.chunksWithoutVector += 1;
  }

  // Prune scoped to THIS surface + source_path ONLY — re-publishing a SHORTER doc
  // leaves stale tail rows (same source_path, higher chunk_index than the new
  // count), so we prune by chunk_index within this surface+source. Never touches
  // the app corpus, any other website surface, or any other source.
  summary.rowsPruned = await pruneGuideContentChunks(surface, sourcePath, chunks.length);
  return summary;
}
