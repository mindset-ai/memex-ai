// spec-409 — content/static guards (no DB): the grounding Prompt Button prose
// and late-specify guidance live in a phases markdown file (not inline in code);
// the migration adds the four columns; the tool is in the shared manifest; and
// the work ships fair-code (no .ee markers on the files this spec touches).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
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
  it("0110 migration ALTERs documents with the four columns", () => {
    tagAc(AC(6));
    const sql = readFileSync(
      resolve(SERVER_ROOT, "drizzle/0110_add_documents_code_grounding.sql"),
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
  it("no file touched by this branch carries a .ee. / .ee marker", () => {
    tagAc(AC(14));
    // The files this spec added or modified, per git, relative to the worktree root.
    const out = execSync(
      "git diff --name-only HEAD; git ls-files --others --exclude-standard",
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const touched = out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Sanity: we should have touched something.
    expect(touched.length).toBeGreaterThan(0);
    const eeMarked = touched.filter((p) => /\.ee\.|\/\.ee\//.test(p));
    expect(eeMarked).toEqual([]);
  });
});
