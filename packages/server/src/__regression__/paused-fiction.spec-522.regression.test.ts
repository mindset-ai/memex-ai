// spec-522 t-6 (ac-6) — there is no "paused" content, so nothing may claim to exclude it.
//
// For years the search comments, the MCP tool descriptions and the shipped agent
// guidance all said search "excludes archived and paused content". Half of that
// was fiction:
//
//   - `paused` was NEVER a document status. schema.ts constrains status to
//     draft | review | implementation | done | approved | specify | build | verify.
//   - It was only ever `documents.paused_at`, a nullable timestamp added by
//     0037_add_document_lifecycle_columns.sql.
//   - spec-409 (commit 3a17b45) removed the pause feature end-to-end, and
//     0113_drop_documents_paused_at.sql dropped the column.
//   - No SQL anywhere filters on it. Every search arm's visibility clause is
//     `AND d.archived_at IS NULL` plus `AND d.is_demo IS NOT TRUE`.
//
// The real posture, and the only one any comment / description / prompt may state:
// archived excluded (opt in via `includeArchived`), demo Specs excluded
// unconditionally, drafts included, NO status filter of any kind.
//
// THE RULE THIS GUARD ENFORCES: the word "paused" may appear in server/shared
// source only where it is immediately buried — i.e. within two lines of the
// history that killed it (spec-409 / 3a17b45 / 0113_drop_documents_paused_at.sql).
// That history is worth keeping. The claim is not. A bare "paused" is the fiction
// growing back, most dangerously in prose we SHIP to agents.
//
// Deliberately out of scope (legitimate, unrelated uses of the word):
//   - the migrations themselves (0037 / 0113 / 0131) — they are the history;
//     they live in packages/server/drizzle, outside the scanned trees.
//   - `packages/ui` carousel / heartbeat / media "pause" state, and the agent-loop
//     "pause" of the render_* UI tools — none of those is the token `paused`.
//   - the `spec-pause` HIDDEN_FEATURES slug, and `paused_at` column references:
//     neither matches \bpaused\b.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-522/acs/ac-${n}`;

const SERVER_SRC = join(__dirname, "..");
const SHARED_SRC = join(__dirname, "../../../shared/src");
const REPO_ROOT = join(__dirname, "../../../..");

// The obituary: naming any of these next to "paused" marks the mention as
// history rather than a live claim.
const OBITUARY_TOKENS = ["spec-409", "3a17b45", "0113_drop_documents_paused_at"];

// How far from the word the obituary may sit (comment blocks wrap).
const WINDOW = 2;

const PAUSED = /\bpaused\b/i;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "coverage") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|json|md)$/.test(name)) out.push(full);
  }
  return out;
}

describe("spec-522 — the 'paused' fiction is retired (ac-6)", () => {
  it("no server/shared source claims search excludes 'paused' content", () => {
    tagAc(AC(6));

    const files = [...walk(SERVER_SRC), ...walk(SHARED_SRC)].filter(
      // This file argues ABOUT the word; it can't also be bound by the rule.
      (f) => !f.includes("paused-fiction.spec-522"),
    );
    // Denominator: prove the walk found the trees, so a bad path can't turn this
    // into a vacuous pass.
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!PAUSED.test(line)) return;
        const window = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join("\n");
        if (OBITUARY_TOKENS.some((t) => window.includes(t))) return;
        offenders.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `"paused" is stated as a live thing in ${offenders.length} place(s):\n` +
          `  ${offenders.join("\n  ")}\n\n` +
          `There is no paused status and no paused_at column — spec-409 (3a17b45) removed\n` +
          `the pause feature and 0113_drop_documents_paused_at.sql dropped the column. No\n` +
          `SQL filters on it. State the real posture instead: archived excluded (opt in via\n` +
          `includeArchived), demo Specs excluded, drafts included, no status filter.\n\n` +
          `If you genuinely need the word — explaining why it ISN'T there — cite the history\n` +
          `within ${WINDOW} lines (${OBITUARY_TOKENS.join(" / ")}).\n\n` +
          `Check: packages/server/src/__regression__/paused-fiction.spec-522.regression.test.ts`,
    ).toEqual([]);
  });

  it("guidance/phases.json describes ONE lifecycle flag, and it is not 'paused'", () => {
    tagAc(AC(6));

    // Served verbatim to every agent via get_information(topic='phases'), so a
    // stale flag here teaches the fiction to every session that reads it.
    const raw = readFileSync(join(SERVER_SRC, "guidance/phases.json"), "utf8");
    const phases = JSON.parse(raw) as { body: string };

    expect(phases.body).not.toMatch(PAUSED);
    expect(phases.body).toMatch(/one orthogonal lifecycle flag/i);
    expect(phases.body).not.toMatch(/two orthogonal lifecycle flags/i);
    // The one that does exist still has to be described.
    expect(phases.body).toMatch(/\*\*archived\*\*/);
  });

  it("the Issue-suggestion ranker filters on `done` only, not on a phantom status", () => {
    tagAc(AC(6));

    // `h.status` is doc_status. Neither "archived" (that's the archived_at
    // column) nor "paused" (gone since spec-409) is a member, so comparing
    // against either is a dead no-op that reads as a real filter.
    const src = readFileSync(join(SERVER_SRC, "agent/handlers/shared.ts"), "utf8");
    const fn = src.slice(
      src.indexOf("export async function suggestActiveSpecsForIssue"),
    );
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    // Strip comments — the surviving comment deliberately QUOTES the dead clause
    // to stop anyone restoring it; only executable code is under test here.
    const code = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");

    expect(code).toMatch(/hits\.filter\(\(h\) => h\.status !== "done"\)/);
    expect(code).not.toMatch(/h\.status\s*[!=]==\s*"archived"/);
    expect(code).not.toMatch(/h\.status\s*[!=]==\s*"paused"/);
  });
});
