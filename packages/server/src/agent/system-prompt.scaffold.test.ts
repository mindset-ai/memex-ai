// spec-360 t-2 — the scaffold mode's system-prompt assembly.
//
// **ac-10** — when the request is in scaffold mode, buildSystemBlocks appends the
// scaffold-agent behavioural block, and the composed grounding (structure + org
// additions + rationale/standards) rides the system prompt's context block.
// **ac-13** — that grounding context block carries `cache_control: ephemeral`, so
// the large-but-stable scaffold context is paid for once per session (dec-10).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { SCAFFOLD_AGENT_GUIDANCE, toScaffoldGrounding, BASE_SCAFFOLD } from "@memex/shared";
import { buildSystemBlocks } from "./system-prompt.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-360/acs/ac-${n}`;

// A representative grounding payload — exactly what buildScaffoldContext feeds in.
const GROUNDING = toScaffoldGrounding(BASE_SCAFFOLD, []);

describe("spec-360 t-2: scaffold-mode prompt assembly (ac-10)", () => {
  it("appends the scaffold-agent behavioural block only in scaffold mode", () => {
    tagAc(AC(10));
    const on = buildSystemBlocks(GROUNDING, "specify", false, false, false, undefined, true);
    const off = buildSystemBlocks(GROUNDING, "specify", false, false, false, undefined, false);
    const instructionsOn = on[0].text;
    const instructionsOff = off[0].text;
    // The behavioural prose (single-sourced in @memex/shared) is present only in
    // scaffold mode — it is an overlay over the same phase-composed base.
    expect(instructionsOn).toContain("Scaffold assistant");
    expect(instructionsOn).toContain("propose_scaffold_change");
    expect(instructionsOn).toContain(SCAFFOLD_AGENT_GUIDANCE.text);
    expect(instructionsOff).not.toContain("Scaffold assistant");
  });

  it("LEADS with the scaffold identity and SUPPRESSES the doc-bound 'document assistant' role", () => {
    tagAc(AC(10));
    // The bug this guards: appending the scaffold block AFTER the generic
    // "document assistant" role let that role dominate a cold turn, so the
    // assistant introduced itself as the doc agent. In scaffold mode the
    // doc-bound base identity blocks (role / context-awareness / create-from-doc)
    // are dropped and the scaffold identity leads.
    const instructions = buildSystemBlocks(
      GROUNDING,
      "specify",
      false,
      false,
      false,
      undefined,
      true,
    )[0].text;
    // The generic doc-assistant identity is GONE — it's the conflicting role.
    expect(instructions).not.toContain("You are a document assistant for Memex");
    // The doc-context-awareness block (assumes a bound doc) is GONE too.
    expect(instructions).not.toContain("Never call `list_memexes`");
    // The scaffold identity is the FIRST thing the model reads.
    expect(instructions.trimStart().startsWith("## Scaffold assistant")).toBe(true);
    // Sanity: the spec (non-scaffold) prompt still leads with the doc role.
    const specInstructions = buildSystemBlocks(GROUNDING, "specify")[0].text;
    expect(specInstructions).toContain("You are a document assistant for Memex");
  });

  it("rides the composed grounding (structure + projections) in the context block", () => {
    tagAc(AC(10));
    const blocks = buildSystemBlocks(GROUNDING, "specify", false, false, false, undefined, true);
    // buildSystemBlocks puts documentContext in the second block under a heading.
    const context = blocks[1].text;
    expect(context).toContain(GROUNDING);
    // The grounding is real structure, not a stub.
    expect(context).toContain("The scaffold you administer");
    expect(context).toContain("Phase: build");
  });
});

describe("spec-360 t-2: grounding is cached (ac-13)", () => {
  it("the grounding context block carries cache_control: ephemeral", () => {
    tagAc(AC(13));
    const blocks = buildSystemBlocks(GROUNDING, "specify", false, false, false, undefined, true);
    const cached = blocks.filter(
      (b) => (b as { cache_control?: { type: string } }).cache_control?.type === "ephemeral",
    );
    // At least one block is an ephemeral cache breakpoint, and the grounding rides it.
    expect(cached.length).toBeGreaterThan(0);
    const groundingBlock = cached.find((b) => b.text.includes(GROUNDING));
    expect(
      groundingBlock,
      "the scaffold grounding must ride a cache_control:ephemeral block",
    ).toBeDefined();
  });
});
