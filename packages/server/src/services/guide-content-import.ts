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

function hashContent(content: string): string {
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

  summary.rowsPruned = await pruneGuideContent(keepPaths);
  return summary;
}
