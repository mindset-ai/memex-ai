// spec-106 t-2 — the lens-shape GuidanceBlock in BASE_SCAFFOLD.
//
// **ac-11** — the specify-phase GuidanceBlock teaches the agent to PROPOSE the
// section anatomy (Overview, Design & UX, Architecture & Security, + adaptive
// lenses) at Spec creation.
//
// **ac-12** — the guidance teaches the agent to READ existing section types to
// scope reading/writing, WITHOUT hard-coding enforcement.
//
// The block is authored in `scaffold-data.ts` as a `shared_nudge` PromptBlock
// (`spec-shape-lenses`) plus two base GuidanceBlocks targeting `{ phase:'specify' }`
// and `{ tool:'create_doc' }` (Spec birth). These assertions pin the prose
// intent and the targeting so a future re-word can't silently drop the
// behavioural contract.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { BASE_SCAFFOLD } from "./scaffold-data.js";
import { toNudge } from "./scaffold-model.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-106/acs/ac-${n}`;

const LENS_BLOCK = BASE_SCAFFOLD.promptBlocks.find(
  (b) => b.id === "spec-shape-lenses",
);

describe("spec-106 t-2: lens-shape PromptBlock authoring (ac-11)", () => {
  it("a `spec-shape-lenses` shared_nudge prompt block exists", () => {
    tagAc(AC(11));
    expect(LENS_BLOCK, "BASE_SCAFFOLD must carry id `spec-shape-lenses`").toBeDefined();
    // shared_nudge so it rides the nudge footer to both surfaces (spec-68 dec-9).
    expect(LENS_BLOCK!.surface).toBe("shared_nudge");
    expect(LENS_BLOCK!.rationale.trim().length).toBeGreaterThan(0);
  });

  it("teaches the three CORE lenses by name", () => {
    tagAc(AC(11));
    const text = LENS_BLOCK!.text;
    expect(text).toContain("Overview");
    expect(text).toContain("Design & UX");
    expect(text).toContain("Architecture & Security");
    // Framed as CORE / always present.
    expect(text.toLowerCase()).toContain("core");
  });

  it("teaches the ADAPTIVE Operations lens for deploy/migration/rollout/perf/observability work", () => {
    tagAc(AC(11));
    const lower = LENS_BLOCK!.text.toLowerCase();
    expect(lower).toContain("operations");
    expect(lower).toContain("adaptive");
    // The signal vocabulary the agent matches the work against.
    expect(lower).toContain("deploy");
    expect(lower).toContain("migration");
    expect(lower).toContain("rollout");
    expect(lower).toContain("perf");
    expect(lower).toContain("observability");
  });

  it("marks Decisions (dec-N) and ACs (ac-N) as PRIMITIVES, never prose sections", () => {
    tagAc(AC(11));
    const text = LENS_BLOCK!.text;
    expect(text.toUpperCase()).toContain("PRIMITIVE");
    expect(text).toContain("dec-N");
    expect(text).toContain("ac-N");
  });

  it("allows a genuinely trivial Spec to be Overview-only", () => {
    tagAc(AC(11));
    const lower = LENS_BLOCK!.text.toLowerCase();
    expect(lower).toContain("trivial");
    expect(lower).toContain("overview-only");
  });

  it("names the absence convention (mark `n/a`, never silently drop a core lens)", () => {
    tagAc(AC(11));
    const lower = LENS_BLOCK!.text.toLowerCase();
    expect(lower).toContain("n/a");
    expect(lower).toContain("never silently drop");
  });

  it("references std-18 as the source of truth and does NOT duplicate the list inline (ac-5)", () => {
    tagAc(AC(11));
    const text = LENS_BLOCK!.text;
    expect(text).toContain("std-18");
    // ac-5 / no-second-copy: the block points at std-18 rather than re-listing
    // a full taxonomy. The block names std-18 as the source of truth and tells
    // the agent to follow it rather than enumerate the set inline. (The three
    // core lens names are necessarily present as the behavioural teaching; the
    // canonical list lives in std-18.)
    expect(text.toLowerCase()).toMatch(/std-18 is the source of truth/);
    expect(text.toLowerCase()).toContain("follow it rather than re-listing");
  });

  it("is advice, not law — framed as PROPOSE, not enforce", () => {
    tagAc(AC(11));
    const lower = LENS_BLOCK!.text.toLowerCase();
    expect(lower).toContain("propose");
    // The header explicitly disclaims template-filling.
    expect(lower).toContain("don't fill a template");
  });
});

describe("spec-106 t-2: read-existing-types guidance, no enforcement (ac-12)", () => {
  it("teaches the agent to READ existing section types to scope its work", () => {
    tagAc(AC(12));
    const lower = LENS_BLOCK!.text.toLowerCase();
    expect(lower).toContain("read the existing section types");
    expect(lower).toContain("scope");
  });

  it("frames adaptation to existing shape, NOT enforcement of a fixed set", () => {
    tagAc(AC(12));
    const lower = LENS_BLOCK!.text.toLowerCase();
    expect(lower).toContain("adapt to it");
    expect(lower).toContain("don't impose");
    // Soft posture: no enforcement / no required set.
    expect(lower).toContain("don't enforce");
  });
});

describe("spec-106 t-2: targeting in BASE_SCAFFOLD baseGuidance (ac-11)", () => {
  const matching = BASE_SCAFFOLD.baseGuidance.filter(
    (g) => g.text === LENS_BLOCK!.text,
  );

  it("is targeted at phase=specify (shaping the narrative)", () => {
    tagAc(AC(11));
    const specifyBlock = matching.find(
      (g) => g.target.phase === "specify" && g.target.tool === undefined,
    );
    expect(specifyBlock, "a base GuidanceBlock must target phase=specify").toBeDefined();
    expect(specifyBlock!.source).toBe("base");
    expect(specifyBlock!.enabled).toBe(true);
  });

  it("is ALSO targeted at the create_doc tool so it fires at Spec birth", () => {
    tagAc(AC(11));
    const birthBlock = matching.find((g) => g.target.tool === "create_doc");
    expect(
      birthBlock,
      "a base GuidanceBlock must target the create_doc tool (Spec birth)",
    ).toBeDefined();
    expect(birthBlock!.source).toBe("base");
    expect(birthBlock!.enabled).toBe(true);
    // create_doc targeting is phase-agnostic — at Spec birth no phase resolves.
    expect(birthBlock!.target.phase).toBeUndefined();
  });

  it("composes into the specify-phase nudge (both surfaces) and into the create_doc nudge (Spec birth)", () => {
    tagAc(AC(11));
    // Specify phase, any tool → lens block present (phase-targeted).
    const specifyNudge = toNudge({
      dataset: BASE_SCAFFOLD,
      tool: "update_section",
      phase: "specify",
    });
    expect(specifyNudge).toContain(LENS_BLOCK!.text);

    // Spec birth: create_doc tool, phase undefined (no Spec resolved yet) →
    // lens block present via the tool-targeted copy.
    const birthNudge = toNudge({
      dataset: BASE_SCAFFOLD,
      tool: "create_doc",
    });
    expect(birthNudge).toContain(LENS_BLOCK!.text);
  });

  it("does NOT leak into a build-phase nudge with no matching tool (phase-scoped)", () => {
    tagAc(AC(12));
    // The lens block is specify/create_doc only — it must not appear on an
    // unrelated build-phase tool call. Proves the targeting is scoped, not global.
    const buildNudge = toNudge({
      dataset: BASE_SCAFFOLD,
      tool: "update_task",
      phase: "build",
    });
    expect(buildNudge).not.toContain(LENS_BLOCK!.text);
  });
});
