#!/usr/bin/env node
// Layer B regression guard for std-2: walks packages/*/src/**/*.{ts,tsx,js,mjs}
// and fails on string templates of the shape `${slug}.${host}` where `${host}`
// resolves to a hostname containing memex.ai. The pattern is the bug
// b-52 deletes — interpolating a tenant slug as a subdomain.
//
// Zero dependencies — Node 22 built-ins only.
//
// Allowlist: any line ending in `// url-shape-lint-ok: <reason>` is skipped.
// Use sparingly — only the std-2 negative-assertion test should need it.
//
// Wire into CI:   make check-url-shape
// Pre-commit hint: add `node scripts/check-url-shape.mjs` to .git/hooks/pre-commit
// or an equivalent hook runner.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

// Match `${something}.<host>` where the host is a literal containing
// `memex.ai`. Both bare (`.memex.ai`) and nested (`.int.memex.ai`) hosts
// catch. The leading `${...}` interpolation is what signals "slug-as-subdomain".
const LEGACY_PATTERN = /\$\{[^}]+\}\.[A-Za-z0-9-]*(?:int\.)?memex\.ai\b/;

const ALLOW_MARKER = "url-shape-lint-ok:";

// File extensions to scan. Match everything under packages/*/src/.
const EXTS = new Set([".ts", ".tsx", ".js", ".mjs"]);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot >= 0 && EXTS.has(entry.name.slice(dot))) yield full;
    }
  }
}

async function listSrcRoots() {
  const pkgs = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const roots = [];
  for (const p of pkgs) {
    if (!p.isDirectory()) continue;
    roots.push(join(PACKAGES_DIR, p.name, "src"));
  }
  return roots;
}

async function scanFile(path) {
  const content = await readFile(path, "utf8");
  const lines = content.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!LEGACY_PATTERN.test(line)) continue;
    if (line.includes(ALLOW_MARKER)) continue;
    hits.push({ line: i + 1, text: line.trim() });
  }
  return hits;
}

async function main() {
  const roots = await listSrcRoots();
  let totalHits = 0;
  for (const root of roots) {
    for await (const file of walk(root)) {
      const hits = await scanFile(file);
      if (!hits.length) continue;
      const rel = relative(REPO_ROOT, file);
      for (const h of hits) {
        console.error(`${rel}:${h.line}: legacy URL shape (per std-2)`);
        console.error(`    ${h.text}`);
      }
      totalHits += hits.length;
    }
  }
  if (totalHits > 0) {
    console.error(
      `\n${totalHits} hit(s). Per std-2 every URL is <HOST>/<namespace>/<memex>/...; never <slug>.<host>.`,
    );
    console.error(
      `If the match is legitimate (e.g. a negative-assertion test), append \`// ${ALLOW_MARKER} <reason>\` to the line.`,
    );
    process.exit(1);
  }
  console.log("URL-shape check passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
