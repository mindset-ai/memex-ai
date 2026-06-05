import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// t-7 / dec-4 in doc-5: the tasks → tasks rename was reverted
// end-to-end. The product noun is "tasks" everywhere — DB, server, MCP,
// React UI, agent prompting, docs.
//
// This regression test fails if a /work[_ ]?item/i identifier sneaks
// back into source. It walks the repo (skipping node_modules, build
// outputs, .git, etc.) and reads files in scoped suffixes (.ts/.tsx/
// .md/.sql/.json/.js/.mjs/.cjs).
//
// The whitelist below allows historic mentions: migrations that
// literally RENAME tables (so they must name both forms), the doc-5
// spec doc that records this very revert, /docs/* archive material,
// drizzle/meta snapshots, and this test file itself.
//
// If you're deliberately re-introducing the term (please don't), add
// the file to the whitelist and document why.

describe("regression: no 'task' naming outside whitelisted history", () => {
  const repoRoot = resolve(__dirname, "../../../..");

  const skipDirNames = new Set([
    "node_modules",
    ".git",
    "dist",
    ".logs",
    "coverage",
    ".turbo",
    "build",
    ".pnpm",
    // Sibling git worktrees mounted under .claude/worktrees/. Walking into
    // them double-counts files (and forces stale branches' content through
    // this regression). Skip the whole tree.
    "worktrees",
  ]);

  const includeExt = new Set([
    ".ts",
    ".tsx",
    ".md",
    ".sql",
    ".json",
    ".js",
    ".mjs",
    ".cjs",
  ]);

  // Whitelist: paths whose contents may legitimately mention the old name.
  // Compared as substring (file.includes(frag)).
  const whitelist: string[] = [
    // Migrations that literally rename to/from tasks. The historic 0005-0007
    // sequence introduced and renamed work_items; the 0026 ↔ 0028 pair did
    // the round-trip via dec-4. The 0029 follow-up backfills lingering
    // 'work_item' reference_type values to 'task'. All four name the term
    // by necessity.
    "packages/server/drizzle/0005_add_decisions_and_work_items.sql",
    "packages/server/drizzle/0006_enhance_decisions_work_items.sql",
    "packages/server/drizzle/0007_rename_work_items_to_tasks.sql",
    "packages/server/drizzle/0009_add_comment_targets.sql",
    "packages/server/drizzle/0014_add_account_scoping.sql",
    "packages/server/drizzle/0019_consolidate_into_one_workspace.sql",
    "packages/server/drizzle/0023_add_codebase_intelligence.sql",
    "packages/server/drizzle/0026_v2_graph_foundation.sql",
    "packages/server/drizzle/0028_revert_to_tasks.sql",
    "packages/server/drizzle/0029_comment_reference_type_strategy_to_mission.sql",
    "packages/server/drizzle/0030_rename_strategy_repos_to_mission_repos.sql",
    // 0031 has a one-line comment narrating that a sibling migration "renamed
    // 'work_item' refs back to 'task'" — historical pointer, not a live identifier.
    "packages/server/drizzle/0031_rename_blueprint_to_standard.sql",
    // Drizzle snapshot files are auto-generated.
    "packages/server/drizzle/meta/",
    // This test itself names the term to test for it.
    "packages/server/src/__regression__/no-work-items-naming.regression.test.ts",
    // /docs/* are archived design notes — historical, not live source.
    "/docs/",
  ];

  const pattern = /work[ _]?item/i;

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      if (skipDirNames.has(entry)) continue;
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
      const dot = entry.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.slice(dot);
      if (includeExt.has(ext)) yield full;
    }
  }

  it("no source/markdown file outside the whitelist matches /work[ _]?item/i", () => {
    const offending: string[] = [];
    for (const file of walk(repoRoot)) {
      if (whitelist.some((frag) => file.includes(frag))) continue;
      let content;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (pattern.test(content)) offending.push(file.replace(repoRoot, ""));
    }

    if (offending.length > 0) {
      const list = offending.map((p) => `  - ${p}`).join("\n");
      throw new Error(
        `Found 'work[ _]?item' naming in ${offending.length} file(s) outside the whitelist.\n` +
          `The product noun is 'tasks' everywhere (doc-5 dec-4 / t-7). Either rename ` +
          `the usage to 'task' or add the file to the whitelist if it's genuinely historical.\n${list}`,
      );
    }

    expect(offending).toEqual([]);
  });
});
