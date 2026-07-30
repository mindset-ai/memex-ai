// The CLAUDE.md standards index is GENERATED (spec-512 dec-4).
//
//   node scripts/ci/standards-index.mjs --check   # staleness gate (offline lane)
//   node scripts/ci/standards-index.mjs --write   # regenerate  (`make standards-gen`)
//
// Why this exists: the index was hand-maintained, and it drifted — std-38, std-39,
// std-40, std-41 and std-42 were all approved in Memex and simply absent from the
// table agents orient from at session start. A Standard nobody can find from the
// codebase pointer is not binding anyone's behaviour. The pre-existing guard
// (spec-172-e2e-standard-index) pinned that ONE row (std-28) existed; nothing
// enforced completeness, so adding a Standard left the pointer stale with nothing red.
//
// Source of truth chain:
//   Memex (authoritative)  --agent, online-->  standards.manifest.json (committed)
//   standards.manifest.json  --this script-->  the CLAUDE.md table
//
// The manifest is the OFFLINE authority on purpose: CI holds no Memex credentials
// and the fast lane must not need the network. Manifest-vs-Memex drift is a
// separate online concern; an offline PR must never fail because a network call
// was unavailable.
//
// ── Marker handling ──────────────────────────────────────────────────────────
// This introduces the repo's FIRST BEGIN/END generated region (every other
// generated artifact here is whole-file with a prose banner), so it is written
// against the documented failure mode: a generator that rewrites only the FIRST
// marked block passes its own check while leaving the file broken. This one
// rewrites EVERY region and rejects duplicate, orphaned, unmatched or
// out-of-order markers rather than guessing.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = "scripts/ci/standards-index.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAUDE_MD = join(ROOT, "CLAUDE.md");
const MANIFEST = join(ROOT, "standards.manifest.json");

export const BEGIN = "<!-- BEGIN generated: standards-index -->";
export const END = "<!-- END generated: standards-index -->";

/** Render the manifest as the markdown table body (no surrounding markers). */
export function renderTable(standards) {
  const lines = ["| Standard | Covers |", "|---|---|"];
  for (const s of standards) lines.push(`| ${s.handle} | ${s.summary} |`);
  return lines.join("\n");
}

/** Locate every generated region. Throws with a contract-shaped message on any
 *  malformed marker rather than silently rewriting part of the file. */
export function findRegions(text) {
  const begins = [...text.matchAll(new RegExp(escapeRe(BEGIN), "g"))].map((m) => m.index);
  const ends = [...text.matchAll(new RegExp(escapeRe(END), "g"))].map((m) => m.index);

  if (begins.length !== ends.length) {
    throw new Error(
      `Unbalanced generated markers in CLAUDE.md — ${begins.length} BEGIN vs ${ends.length} END.\n` +
        `  An orphaned marker means a partial rewrite would corrupt the file, so nothing was written.\n` +
        `  Fix: restore the matching marker, or delete the orphan, then re-run:\n` +
        `    make standards-gen\n` +
        `  Check: ${SELF}`,
    );
  }
  if (begins.length === 0) {
    throw new Error(
      `No generated region found in CLAUDE.md.\n` +
        `  Expected a block delimited by:\n    ${BEGIN}\n    ${END}\n` +
        `  Fix: re-add the markers around the standards table, then run:\n` +
        `    make standards-gen\n` +
        `  Check: ${SELF}`,
    );
  }
  const regions = [];
  for (let i = 0; i < begins.length; i++) {
    if (ends[i] < begins[i]) {
      throw new Error(
        `Generated markers are out of order in CLAUDE.md (END at ${ends[i]} precedes BEGIN at ${begins[i]}).\n` +
          `  Fix: correct the marker order, then run:\n    make standards-gen\n` +
          `  Check: ${SELF}`,
      );
    }
    if (i > 0 && begins[i] < ends[i - 1]) {
      throw new Error(
        `Nested generated regions in CLAUDE.md (region ${i + 1} starts inside region ${i}).\n` +
          `  Fix: unnest the markers, then run:\n    make standards-gen\n` +
          `  Check: ${SELF}`,
      );
    }
    regions.push({ start: begins[i], end: ends[i] + END.length });
  }
  return regions;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrite EVERY generated region — never just the first. */
export function applyRegions(text, body) {
  const regions = findRegions(text);
  const block = `${BEGIN}\n${body}\n${END}`;
  let out = "";
  let cursor = 0;
  for (const r of regions) {
    out += text.slice(cursor, r.start) + block;
    cursor = r.end;
  }
  return out + text.slice(cursor);
}

function loadManifest() {
  const parsed = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const standards = parsed.standards ?? [];
  if (standards.length === 0) {
    throw new Error(
      `standards.manifest.json lists ZERO standards — refusing to generate an empty index.\n` +
        `  An empty manifest would silently blank the table agents orient from.\n` +
        `  Fix: refresh it from Memex (search_memex({kind:'standard'})), then:\n` +
        `    make standards-gen\n` +
        `  Check: ${SELF}`,
    );
  }
  return standards;
}

function main(argv) {
  const mode = argv.includes("--write") ? "write" : "check";
  const standards = loadManifest();
  const current = readFileSync(CLAUDE_MD, "utf8");
  const next = applyRegions(current, renderTable(standards));

  if (mode === "write") {
    if (next === current) {
      process.stdout.write(`✓ CLAUDE.md standards index already current (${standards.length} standards)\n`);
      return 0;
    }
    writeFileSync(CLAUDE_MD, next);
    process.stdout.write(
      `✓ regenerated the CLAUDE.md standards index from standards.manifest.json ` +
        `(${standards.length} standards)\n`,
    );
    return 0;
  }

  if (next !== current) {
    const inFile = new Set(
      [...current.matchAll(/^\|\s*(std-\d+)\s*\|/gm)].map((m) => m[1]),
    );
    const inManifest = standards.map((s) => s.handle);
    const missing = inManifest.filter((h) => !inFile.has(h));
    const extra = [...inFile].filter((h) => !inManifest.includes(h));

    process.stderr.write(
      `CLAUDE.md STANDARDS INDEX IS STALE (spec-512 dec-4)\n` +
        `\n` +
        `  The generated table does not match standards.manifest.json.\n` +
        `  Manifest lists ${inManifest.length} standards; CLAUDE.md's table has ${inFile.size}.\n` +
        (missing.length
          ? `  Missing from CLAUDE.md: ${missing.join(", ")}\n`
          : "") +
        (extra.length ? `  In CLAUDE.md but not the manifest: ${extra.join(", ")}\n` : "") +
        (!missing.length && !extra.length
          ? `  Same handles, but one or more summaries differ.\n`
          : "") +
        `\n` +
        `  CLAUDE.md is how an agent discovers which rules bind it. A Standard that is\n` +
        `  approved but absent from this table is not binding anyone's behaviour.\n` +
        `\n` +
        `  Fix:\n` +
        `    make standards-gen\n` +
        `\n` +
        `  Check: ${SELF}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `✓ CLAUDE.md standards index matches the manifest (${standards.length} standards)\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`\n${err.message}\n`);
    process.exit(2);
  }
}
