// b-105 t-13 / dec-10: the Brief → Spec migration's done-definition guard.
//
// Once the migration ships, the literal tokens `brief` / `mission` / `strategy`
// (case-insensitive, word-bounded) must NOT appear anywhere agents or humans
// read at runtime — code, docs, prompts, scripts, top-level config. A handful
// of legitimate survivors remain (wire-format compat columns, historical
// lineage comments, immutable Drizzle migrations, archived design docs, the
// migration's own SQL + runbook + CHANGELOG entry); those are enumerated in
// `.legacy-spec-vocab-allowlist.txt` at repo root, gated by CODEOWNERS so
// adding to it requires explicit reviewer sign-off.
//
// Red CI = migration drift. Add the offending file to the allowlist only if
// the hit is genuinely historical or a wire-format constraint that can't be
// renamed in this PR; otherwise rewrite the source.

import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";

// ---- constants ------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// packages/server/src/__regression__/<this file> → repo root is 4 levels up.
const REPO_ROOT = resolve(__dirname, "../../../..");

const ALLOWLIST_PATH = resolve(REPO_ROOT, ".legacy-spec-vocab-allowlist.txt");

const VOCAB_RE = /\b(brief|mission|strategy)\b/i;

// Files with these extensions get scanned. Other extensions (binaries,
// lockfiles, generated `.snap`, etc.) are skipped.
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".md", ".json", ".sql", ".sh"]);

// Extension-less files we still want to scan when encountered as basenames.
const SCAN_BASENAMES = new Set(["Makefile"]);

// Directory tree roots we walk under repo root.
const SCAN_DIRS = ["packages", "docs", "scripts"];

// Directory basenames we never descend into. These are matched against the
// directory entry name (not the full path), so anything named `node_modules`
// at any depth is skipped.
const EXCLUDE_DIR_NAMES = new Set([
  ".git",
  ".github",
  ".claude",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".logs",
  ".turbo",
  ".pnpm",
  // Sibling git worktrees mounted under .claude/worktrees/. Belt-and-braces
  // (.claude is already skipped above, but if it ever gets re-enabled we
  // still want this excluded).
  "worktrees",
]);

// Per dec-10: snapshot files are noise — they're regenerated and may carry
// legacy strings from history.
const EXCLUDE_FILE_SUFFIXES = [".snap"];

// ---- allowlist parser -----------------------------------------------------

type AllowlistEntry =
  | { kind: "file"; path: string }
  | { kind: "dir"; pathPrefix: string }
  | { kind: "line"; path: string; pattern: RegExp };

function parseAllowlist(contents: string): AllowlistEntry[] {
  const entries: AllowlistEntry[] = [];
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    // `path/**` — directory glob. Allowlists everything below that dir.
    if (line.endsWith("/**")) {
      const pathPrefix = line.slice(0, -3); // drop trailing `/**`
      entries.push({ kind: "dir", pathPrefix });
      continue;
    }

    // `path:pattern` — line-level allowlist. Split on the FIRST colon only
    // (file paths don't contain `:` on the platforms we care about; if they
    // ever do, escape upstream).
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      // No colon — whole file allowlisted.
      entries.push({ kind: "file", path: line });
      continue;
    }

    const path = line.slice(0, colonIdx);
    const patternSrc = line.slice(colonIdx + 1);
    // Pattern is a substring/regex matched against the full line text.
    entries.push({ kind: "line", path, pattern: new RegExp(patternSrc) });
  }
  return entries;
}

function isAllowlisted(
  entries: AllowlistEntry[],
  relPath: string,
  lineBody: string,
): boolean {
  for (const e of entries) {
    if (e.kind === "file" && e.path === relPath) return true;
    if (e.kind === "dir" && relPath.startsWith(e.pathPrefix + "/")) return true;
    if (e.kind === "line" && e.path === relPath && e.pattern.test(lineBody)) {
      return true;
    }
  }
  return false;
}

// ---- file walker ----------------------------------------------------------

function shouldScanFile(name: string): boolean {
  if (SCAN_BASENAMES.has(name)) return true;
  for (const suffix of EXCLUDE_FILE_SUFFIXES) {
    if (name.endsWith(suffix)) return false;
  }
  return SCAN_EXTENSIONS.has(extname(name));
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDE_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (!s.isFile()) continue;
    if (shouldScanFile(entry)) yield full;
  }
}

function* collectInScopeFiles(): Generator<string> {
  // Sub-trees first.
  for (const sub of SCAN_DIRS) {
    yield* walk(resolve(REPO_ROOT, sub));
  }
  // Repo-root *.md, *.json, and the Makefile.
  let rootEntries: string[];
  try {
    rootEntries = readdirSync(REPO_ROOT);
  } catch {
    return;
  }
  for (const entry of rootEntries) {
    const full = join(REPO_ROOT, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    if (entry === "Makefile" || entry.endsWith(".md") || entry.endsWith(".json")) {
      yield full;
    }
  }
}

// ---- the scanner ----------------------------------------------------------

interface Hit {
  path: string;
  line: number;
  body: string;
}

function scan(allowlist: AllowlistEntry[]): Hit[] {
  const hits: Hit[] = [];
  for (const fullPath of collectInScopeFiles()) {
    const relPath = relative(REPO_ROOT, fullPath);
    let content;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    if (!VOCAB_RE.test(content)) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const body = lines[i];
      // Reset the regex's lastIndex by using .test on the line (it's a new
      // regex each call because `i` flag forbids `g` here — `VOCAB_RE` has
      // no `g` so .test is safe to call repeatedly).
      if (!VOCAB_RE.test(body)) continue;
      if (isAllowlisted(allowlist, relPath, body)) continue;
      hits.push({ path: relPath, line: i + 1, body });
    }
  }
  return hits;
}

// ---- tests ----------------------------------------------------------------

describe("regression: no legacy spec vocab outside allowlist (b-105 / dec-10)", () => {
  const allowlist = parseAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"));

  it("repo is free of \\b(brief|mission|strategy)\\b matches outside the allowlist", () => {
    // ac-1: zero non-allowlisted \\b(brief|mission|strategy)\\b matches
    tagAc("mindset-prod/memex-building-itself/specs/spec-105/acs/ac-1");
    // ac-21: this regression test runs in CI and passes on green tree
    tagAc("mindset-prod/memex-building-itself/specs/spec-105/acs/ac-21");
    const hits = scan(allowlist);
    if (hits.length > 0) {
      const lines = hits.map((h) => `  ${h.path}:${h.line}:${h.body}`);
      const msg =
        `Found ${hits.length} legacy-spec-vocab hit(s) outside the allowlist.\n` +
        `Either rewrite the offending source to use 'spec' (preferred for prose) or\n` +
        `add a line to .legacy-spec-vocab-allowlist.txt with a justification comment\n` +
        `(wire-format / historical lineage / immutable migration only).\n\n` +
        lines.join("\n");
      throw new Error(msg);
    }
    expect(hits).toEqual([]);
  });

  // Negative test: a sentinel file outside the in-scope tree must be detectable
  // by the scanner if we drop it inside the in-scope tree. We materialise the
  // sentinel as a temp scratch file *inside* `packages/server/src/__regression__/`
  // (so the walker actually visits it), then assert the scanner flags it.
  //
  // Important: the sentinel file is removed in the `finally` block even if the
  // test fails, so a crashed run never leaves a residual file that would break
  // the main test on the next run.
  it("flags a sentinel file containing \\bbrief\\b that is NOT in the allowlist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "no-legacy-spec-vocab-sentinel-"));
    // We need the sentinel to be inside the scanner's scope. Drop it under
    // packages/ in a temp subdirectory (the walker recurses by directory
    // name, not by gitignore) and clean up after.
    const sentinelDir = resolve(
      REPO_ROOT,
      "packages/server/src/__regression__/__sentinel_tmp__",
    );
    try {
      // Create the sentinel directory next to this file.
      const fs = require("node:fs");
      fs.mkdirSync(sentinelDir, { recursive: true });
      const sentinelPath = join(sentinelDir, "sentinel.md");
      writeFileSync(sentinelPath, "this line mentions a brief and should fail\n");

      const hits = scan(allowlist);
      const relSentinel = relative(REPO_ROOT, sentinelPath);
      const flagged = hits.find((h) => h.path === relSentinel);
      expect(
        flagged,
        `scanner did not flag the sentinel file at ${relSentinel}`,
      ).toBeDefined();
    } finally {
      rmSync(sentinelDir, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
