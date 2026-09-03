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
//   - tool description (always in context per tool-selection) — toolSpecs (runtime)
//   - tool RESPONSE nudge (read at the activation moment) — renderFooterSignal (runtime)
//   - phases guidance topic (the canonical reference) — guidance JSON (prose artifact)
//
// spec-392 (workstream C of spec-388): the response channel USED to grep
// handler source for the literal nudge clause, with the comment "we can't
// easily call the handler ... assert the source contains the literal clause".
// We CAN call the producer: the create_doc spec-footer nudge is authored by
// renderFooterSignal({kind:'doc_created', docType:'spec'}) and that branch
// takes no DB. So the response channel is now BEHAVIOURAL — it exercises the
// real prose producer, catching a trim that a source grep would miss when the
// nudge is gated off at runtime but the string survives in the file.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { toolSpecs } from "../agent/tool-specs.js";
import {
  renderFooterSignal,
} from "../agent/handlers/guidance-envelope.js";

const AC6 = "mindset-prod/memex-building-itself/specs/spec-392/acs/ac-6";

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

  it("create_doc RESPONSE nudge fires for specs (behavioural: renderFooterSignal)", async () => {
    tagAc(AC6);
    // Call the real producer of the doc_created footer nudge. The 'doc_created'
    // spec branch consults no DB, so memexId/docId are unused placeholders.
    const docRef = "mindset-prod/memex-building-itself/specs/spec-999";
    const nudge =
      (await renderFooterSignal(
        { kind: "doc_created", docRef, docType: "spec" },
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-0000-0000-000000000000",
      )) ?? "";

    // The nudge must steer the agent to author SCOPE acceptance criteria...
    expect(nudge).toMatch(/scope-type acceptance criteria/i);
    // ...show the create_ac({kind:'scope'}) call-shape with the doc's OWN ref
    // pre-filled (proof it's the runtime producer threading the arg, not a
    // static template a grep would also match)...
    expect(nudge).toMatch(/kind:\s*["']scope["']/i);
    expect(nudge).toContain(docRef);
    // ...and point at the phases guidance topic for the full detail.
    expect(nudge).toMatch(/get_information\(topic='phases'\)/i);
  });

  it("the doc_created nudge is spec-only — a non-spec docType does NOT get the scope-AC nudge", async () => {
    tagAc(AC6);
    // Behaviour-preserving guard on the branch: only specs are steered to scope
    // ACs. A document (free-form) takes a different branch / none, so the
    // scope-AC clause must be absent — proving the producer BRANCHES on docType
    // rather than always emitting the string.
    const nudge =
      (await renderFooterSignal(
        {
          kind: "doc_created",
          docRef: "mindset-prod/memex-building-itself/docs/doc-999",
          docType: "document",
        },
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-0000-0000-000000000000",
      )) ?? "";
    expect(nudge).not.toMatch(/scope-type acceptance criteria/i);
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
