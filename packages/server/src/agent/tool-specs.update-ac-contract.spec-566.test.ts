// spec-566 issue-4 / t-12 — `update_ac` must DESCRIBE the refusal it performs.
//
// spec-566 made `update_ac` refuse a criterion that already reads as satisfied
// (dec-8, ac-23). The behaviour shipped to prod; the CONTRACT did not. The live
// surface at memex.ai was still advertising "Use this to polish wording, sharpen
// falsifiability, or fix typos" the day after the release — which is how this was
// found: by probing tools/list on prod, not by reading source.
//
// Why a test and not just an edit: a tool's description is the only thing a
// coding agent reads BEFORE it calls. No existing test asserted any of it, so
// the description was free to drift away from the code underneath it — and did,
// silently, through a full build-verify-release cycle.
//
// [per std-16] the tool contract has ONE source. It has two renderings — the
// server's `toolSpecs` description and the shared manifest's `summary` — so both
// are asserted here. Fixing one and not the other is the same defect again.
//
// Pure structural: no Postgres, no network.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { toolManifest } from "@memex/shared";
import { toolSpecs } from "./tool-specs.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";

describe("spec-566 issue-4 — update_ac's contract states the refusal it performs", () => {
  it("the MCP description names the refusal condition AND the path through it", () => {
    tagAc(`${SPEC}/acs/ac-30`);

    const spec = toolSpecs.find((s) => s.name === "update_ac");
    // Vacuity guard: every assertion below is about this object. If the tool
    // were renamed, `undefined?.description` would quietly satisfy nothing.
    expect(spec, "update_ac must be a registered tool spec").toBeTruthy();
    const description = spec!.description;
    expect(typeof description, "update_ac must carry a description").toBe("string");

    // THE CLAIM, half one: the description says an already-satisfied criterion
    // is refused. An agent that reads only this must not plan a free edit.
    expect(
      description,
      "update_ac's description must say a verified / already-satisfied criterion is refused",
    ).toMatch(/verified|already reads as satisfied|already satisfied/i);
    expect(
      description,
      "the description must state that such an edit is REFUSED, not merely discouraged",
    ).toMatch(/refus/i);

    // Half two [per std-53]: it names the call that gets the author through.
    // "This is refused" alone is a defect report, not a contract.
    expect(
      description,
      "update_ac's description must name propose_ac_supersession as the path",
    ).toContain("propose_ac_supersession");
  });

  it("drops the stale '(when exposed)' hedge — the supersession verbs ARE exposed", () => {
    tagAc(`${SPEC}/acs/ac-30`);

    const spec = toolSpecs.find((s) => s.name === "update_ac");
    expect(spec, "update_ac must be a registered tool spec").toBeTruthy();

    // Precondition asserted, not assumed: the hedge is only stale BECAUSE these
    // are registered. Without this, the assertion below would pass on a surface
    // that never shipped them.
    const names = toolSpecs.map((s) => s.name);
    expect(names).toContain("accept_ac_supersession");
    expect(names).toContain("reject_ac_supersession");

    expect(
      spec!.description,
      "'(when exposed)' described a surface that now exists — spec-566 shipped it",
    ).not.toMatch(/when exposed/i);
  });

  it("the shared manifest summary agrees — one contract, two renderings [std-16]", () => {
    tagAc(`${SPEC}/acs/ac-30`);

    const entry = toolManifest.find((t) => t.name === "update_ac");
    expect(entry, "update_ac must be in the shared tool manifest").toBeTruthy();

    // The manifest is what reaches a coding agent through the scaffold, so a
    // summary that still promises a free edit reintroduces the defect by the
    // other door. It is terser than the MCP description by design — it has to
    // carry the refusal, not the whole prose.
    expect(
      entry!.summary,
      "the manifest summary must not promise a free edit on a satisfied criterion",
    ).toMatch(/verified|already reads as satisfied|already satisfied|supersession/i);
  });
});
