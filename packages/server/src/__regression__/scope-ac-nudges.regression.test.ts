// Regression guard: the channels that tell an agent to author Scope ACs
// right after create_doc must keep saying so.
//
// Observed failure mode this guards against: a real agent created a Spec
// via create_doc and then went straight to framing Decisions, never
// authoring Scope ACs. The skip was natural — the agent had no signal
// anywhere (tool description silent, response a one-liner, phases topic
// silent). After landing the nudges in three channels (description,
// response, phases topic), this test pins them so a future trim doesn't
// silently regress.
//
// Three independent assertions because the channels are independent:
//   - tool description (always in context per tool-selection)
//   - tool response handler (read at the activation moment)
//   - phases guidance topic (the canonical reference)
//
// If any one of these stops mentioning Scope ACs after create_doc, the
// other two still nudge. But ALL three should hold the line.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolSpecs } from "../agent/tool-specs.js";

describe("scope-AC-after-create_doc nudges (real-agent regression)", () => {
  it("create_doc tool description mentions authoring Scope ACs as the next step", () => {
    const spec = toolSpecs.find((s) => s.name === "create_doc");
    expect(spec, "create_doc spec must exist").toBeDefined();
    const desc = spec!.description.toLowerCase();
    expect(desc).toContain("scope ac");
    // The description should mention `create_ac` with `kind: 'scope'` so the
    // agent has the literal call-shape in tool-selection context.
    expect(spec!.description).toMatch(/create_ac\s*\(/);
    expect(desc).toMatch(/scope.{0,40}draft.{0,40}specify|draft.{0,40}specify.{0,40}scope/);
  });

  it("create_doc response handler emits a Scope-AC nudge for specs", async () => {
    // Synthesise the response by reading the source — we can't easily call
    // the handler without a full DB/ctx, and the wording is the part that
    // matters. The test would be fragile on the implementation; instead we
    // assert the source contains the literal nudge clause.
    const sourcePath = join(__dirname, "..", "agent", "tool-specs.ts");
    const src = readFileSync(sourcePath, "utf-8");
    // The nudge lives in the create_doc handler, just before the final
    // return. Match the diagnostic markers we put there.
    expect(src).toMatch(/scope-type acceptance criteria/i);
    expect(src).toMatch(/get_information\(topic='phases'\)/i);
    expect(src).toMatch(
      /kind:\s*["']scope["']/i,
      // The example call-shape must reference kind:'scope' so the agent
      // doesn't have to derive it. If we ever rename `kind`, find another
      // way to disambiguate Scope ACs in the response.
    );
  });

  it("phases guidance topic carries a 'Scope ACs in draft/specify' section", () => {
    const topicPath = join(__dirname, "..", "guidance", "phases.json");
    const topic = JSON.parse(readFileSync(topicPath, "utf-8")) as {
      body: string;
    };
    expect(topic.body).toMatch(/scope acs?/i);
    expect(topic.body).toMatch(/draft\s*\/\s*specify/i);
    // Specifically the "FIRST move after create_doc" or equivalent —
    // the section's whole point is to say "do this before framing Decisions."
    expect(topic.body).toMatch(/create_doc/i);
    expect(topic.body).toMatch(/before.{0,40}decision|decision.{0,40}anchor/i);
  });
});
