// spec-409 — content/static guards (no DB): the grounding Prompt Button prose
// and late-specify guidance live in a phases markdown file (not inline in code);
// the migration adds the four columns; the tool is in the shared manifest; and
// the work ships fair-code (no .ee markers on the files this spec touches).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { toolManifest, BASE_SCAFFOLD } from "@memex/shared";

// The Specify-phase Prompt Button (`plan-handoff`) is the surface a human copies
// into their coding agent. The grounding handoff must live in THAT assembled
// prompt — asserting the source markdown merely exists let an orphaned section
// pass while the rendered prompt said nothing (the original false-green).
const specifyPromptText =
  BASE_SCAFFOLD.promptButtons.find((b) => b.id === "plan-handoff")?.text ?? "";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-409/acs/ac-${n}`;

// Tests run with cwd = packages/server.
const SERVER_ROOT = process.cwd();
const REPO_ROOT = resolve(SERVER_ROOT, "..", "..");

describe("spec-409 grounding handoff in the assembled Specify prompt (ac-4)", () => {
  it("the plan-handoff Prompt Button routes the agent to ground_spec (not just orphaned markdown)", () => {
    tagAc(AC(4));
    expect(specifyPromptText).not.toBe("");
    // The rendered prompt the user copies must hand the grounding job over and
    // route to the ground_spec tool with the dec-3 presence assertion.
    expect(specifyPromptText.toLowerCase()).toContain("ground this spec in the code");
    expect(specifyPromptText).toMatch(/ground_spec/);
    expect(specifyPromptText).toMatch(/codebase_present/);
    expect(specifyPromptText.toLowerCase()).toMatch(
      /source behind each resolved decision|read the actual source/,
    );
    // Prose lives in the scaffold (std-15/std-23), proven by reading it FROM the
    // scaffold dataset above rather than from an inline string in handler code.
  });
});

describe("spec-409 late-specify timing in the assembled Specify prompt (ac-5)", () => {
  it("the plan-handoff prompt steers grounding into the latter part of specify", () => {
    tagAc(AC(5));
    const t = specifyPromptText.toLowerCase();
    expect(t).toContain("latter part of");
    expect(t).toContain("specify");
    expect(t).toContain("build");
  });
});

describe("spec-409 migration adds the grounding columns (ac-6)", () => {
  it("0112 migration ALTERs documents with the four columns", () => {
    tagAc(AC(6));
    const sql = readFileSync(
      resolve(SERVER_ROOT, "drizzle/0112_add_documents_code_grounding.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ALTER TABLE documents/i);
    expect(sql).toMatch(/grounded_in_code boolean NOT NULL DEFAULT false/i);
    expect(sql).toMatch(/grounded_at timestamptz/i);
    expect(sql).toMatch(/grounded_by_user_id uuid/i);
    expect(sql).toMatch(/grounded_by_name text/i);
  });
});

describe("spec-409 ground_spec is in the shared tool manifest (ac-11)", () => {
  it("toolManifest carries a ground_spec planning entry", () => {
    tagAc(AC(11));
    const entry = toolManifest.find((e) => e.name === "ground_spec");
    expect(entry).toBeDefined();
    expect(entry!.group).toBe("planning");
    expect(entry!.readOnlyHint).toBe(false);
    expect(entry!.args).toBe("ground_spec(ref, codebase_present)");
  });
});

describe("spec-409 ships fair-code (ac-14)", () => {
  // The defining footprint of this Spec: every file that carries the grounding
  // feature (schema + migration, the MCP/agent path, the prompt prose, the React
  // surfaces). std-25 decides the licence boundary per-Spec up front — this asserts
  // it: none of these is EE-marked, so the whole feature ships fair-code.
  //
  // Why an explicit list rather than a git diff: the earlier `git diff develop...HEAD`
  // form passed locally but went empty in CI's shallow PR checkout (depth-1, detached
  // HEAD — `develop` isn't even fetched), so the sanity guard tripped (`expected 0 to
  // be greater than 0`). The licence marker lives in the PATH (std-25), so reading the
  // paths off disk is both deterministic across environments and the actual invariant.
  const SPEC_409_FILES = [
    "packages/server/src/db/schema.ts",
    "packages/server/drizzle/0112_add_documents_code_grounding.sql",
    "packages/server/drizzle/0113_drop_documents_paused_at.sql",
    "packages/server/src/agent/handlers/lifecycle.ts",
    "packages/server/src/agent/phases/_base/code-grounding.md",
    "packages/server/src/services/documents.ts",
    "packages/server/src/services/phase-assessment.ts",
    "packages/shared/src/tool-manifest.ts",
    "packages/shared/src/scaffold-data.ts",
    "packages/ui/src/components/CodeGroundedBadge.tsx",
    "packages/ui/src/components/spec-board/KanbanColumn.tsx",
    "packages/ui/src/pages/DocDocument.tsx",
    "packages/ui/src/pages/SpecList.tsx",
  ];

  it("every file this Spec introduces exists and carries no .ee. / .ee marker", () => {
    tagAc(AC(14));
    // Sanity: the footprint is real — each listed file is actually on disk. A
    // renamed/removed feature file fails here instead of silently shrinking the scan.
    const missing = SPEC_409_FILES.filter(
      (p) => !existsSync(resolve(REPO_ROOT, p)),
    );
    expect(missing).toEqual([]);
    const eeMarked = SPEC_409_FILES.filter((p) => /\.ee\.|\/\.ee\//.test(p));
    expect(eeMarked).toEqual([]);
  });
});
