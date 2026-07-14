// spec-482 (t-4 / t-5 / t-8) — the in-Spec agent's OPENING POSTURE overlay.
//
// buildSystemBlocks appends the composed opening posture (toOpeningPosture) to the
// PRIMARY Spec agent's prompt, driven by the entry framing (landing recap vs
// return-visit reorientation) and the tier the two per-user signals (mcpConnected,
// phaseWatermark) select. Pure assertions on the assembled prompt text — no DB, no
// LLM. The prose is single-sourced from @memex/shared (std-15).

import { describe, it, expect } from "vitest";
import { toOpeningPosture } from "@memex/shared";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildSystemBlocks, type OpeningPosture } from "./system-prompt.js";
import type { PhaseWatermark } from "../services/phase-watermark.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-482/acs/ac-${n}`;

const CTX = "## Document Context\nSpec: Ship the widget. Open decisions: 2. Open tasks: 3.";

// The primary Spec agent's opening posture rides positional arg 9 of buildSystemBlocks:
// (documentContext, phase, readOnly, reviewer, driftMode, integrationState,
//  scaffoldMode, scopedMode, openingPosture).
function specPrompt(posture?: OpeningPosture): string {
  const blocks = buildSystemBlocks(
    CTX,
    "specify",
    false,
    false,
    false,
    undefined,
    false,
    undefined,
    posture,
  );
  return blocks[0]!.text;
}

function posture(
  entry: "landing" | "return",
  mcpConnected: boolean,
  phaseWatermark: PhaseWatermark,
): OpeningPosture {
  return { entry, mcpConnected, phaseWatermark };
}

// Distinctive, stable phrases from each prose block (single-sourced in scaffold-data.ts).
const WHY_FIRST = "Lead with WHY it matters, grounded in THIS specific Spec";
const LANDING_RECAP = "SHALLOW, state-computed RECAP";
const LANDING_SKIP = "If NOTHING is open, SKIP the recap entirely";
const LANDING_SCOPE = "normal Spec-authoring scope";
const RETURN_FIXED = "FIXED-SHAPE reorientation";
const RETURN_NO_REPLAY = "Do NOT replay or reference any earlier conversation";
const RETURN_NO_ELAPSED = "do NOT branch on how long it has been since the last visit";
const WHATS_OPEN = "unresolved decisions"; // the shared "what's open" reading

const TIER_MCP_ONE_LINE = "AT MOST ONE line";
const TIER_MCP_NO_QUESTION = "ask NO clarifying question";
const TIER_MCP_CONNECT_NOT_INSTALL = 'Always say "connect" — NEVER "install"';
// t-12 (dec-7 revised): the handoff is delivered as prose + a render_handoff Copy
// block — never a persistent card, never inline copyable text.
const COPY_BUTTON_RULE = 'renders with a Copy button';
const COPY_NO_INLINE = 'NEVER as inline copyable text';
const HANDOFF_PASTE_STEP = 'use the Memex MCP on this Spec';
const TIER_BUILD = "Explain what BUILD means";
const TIER_VERIFY = "Teach ONLY verify";
const TIER_DONE = "Teach ONLY the step to done";
const TIER_EXPERIENCED = "Emit NO workflow-teaching content";

describe("spec-482 opening posture — presence / single-sourcing", () => {
  it("the default primary agent (no posture) carries NONE of the opening-posture prose", () => {
    const p = specPrompt(undefined);
    expect(p).not.toContain(WHY_FIRST);
    expect(p).not.toContain(LANDING_RECAP);
    expect(p).not.toContain(RETURN_FIXED);
    expect(p).not.toContain(TIER_BUILD);
  });

  it("appends the composed posture VERBATIM (single source, std-15) and keeps the Spec-agent base", () => {
    const pst = posture("landing", true, "none");
    const p = specPrompt(pst);
    // Verbatim single-source: the whole composed block is present, not re-inlined.
    expect(p).toContain(
      toOpeningPosture({ entry: "landing", tier: "teach_build" }),
    );
    // The agent keeps its general Spec-agent posture — the skills-awareness block and
    // phase guidance still lead; the posture is an overlay, not a replacement.
    expect(p).toContain("## Skills");
  });

  it("only the PRIMARY Spec agent gets the posture — a scoped/drift agent never does", () => {
    // driftMode=true → not the primary agent; even with a posture arg it is suppressed.
    const blocks = buildSystemBlocks(
      CTX,
      "specify",
      false,
      false,
      true, // driftMode
      undefined,
      false,
      undefined,
      posture("landing", false, "none"),
    );
    expect(blocks[0]!.text).not.toContain(WHY_FIRST);
    expect(blocks[0]!.text).not.toContain(LANDING_RECAP);
  });
});

describe("spec-482 t-4 — landing recap (ac-6 / ac-7 / ac-8)", () => {
  it("landing entry → a shallow state-computed recap of what's open, with a skip clause", () => {
    tagAc(AC(6));
    tagAc(AC(7));
    const p = specPrompt(posture("landing", true, "none"));
    // ac-6: a shallow, state-computed recap of the open decisions/tasks — not a cold
    // greeting, not a replay.
    expect(p).toContain(LANDING_RECAP);
    expect(p).toContain(WHATS_OPEN);
    expect(p).toContain("not a replay of any earlier conversation");
    // ac-7: skipped entirely when nothing is open.
    expect(p).toContain(LANDING_SKIP);
  });

  it("landing recap preserves the normal Spec-agent authoring scope (ac-8)", () => {
    tagAc(AC(8));
    const p = specPrompt(posture("landing", true, "none"));
    expect(p).toContain(LANDING_SCOPE);
    // Still the Spec agent: the phase-composed base is intact (skills overlay present).
    expect(p).toContain("## Skills");
  });
});

describe("spec-482 t-5 — tiers gated by mcpConnected then phaseWatermark", () => {
  it("ac-12: watermark 'specify_build' teaches VERIFY and does NOT re-teach specify→build", () => {
    tagAc(AC(12));
    const p = specPrompt(posture("landing", true, "specify_build"));
    expect(p).toContain(TIER_VERIFY);
    expect(p).toContain("confirming the built work actually satisfies");
    // The exited phase is never re-taught.
    expect(p).not.toContain(TIER_BUILD);
  });

  it("ac-12: watermark 'none' (connected) teaches BUILD", () => {
    tagAc(AC(12));
    const p = specPrompt(posture("landing", true, "none"));
    expect(p).toContain(TIER_BUILD);
    // Not yet teaching a later phase.
    expect(p).not.toContain(TIER_VERIFY);
    expect(p).not.toContain(TIER_DONE);
  });

  it("watermark 'build_verify' teaches only the final step to DONE, never earlier phases", () => {
    const p = specPrompt(posture("landing", true, "build_verify"));
    expect(p).toContain(TIER_DONE);
    expect(p).not.toContain(TIER_BUILD);
    expect(p).not.toContain(TIER_VERIFY);
  });

  it("ac-13: watermark 'verify_done' emits NO workflow-teaching content", () => {
    tagAc(AC(13));
    const p = specPrompt(posture("landing", true, "verify_done"));
    expect(p).toContain(TIER_EXPERIENCED);
    // No phase is taught — none of the teaching directives appear.
    expect(p).not.toContain(TIER_BUILD);
    expect(p).not.toContain(TIER_VERIFY);
    expect(p).not.toContain(TIER_DONE);
  });

  it("ac-16: mcpConnected=false → ≤1-line recap, no clarifying question, and 'connect' not 'install'", () => {
    tagAc(AC(16));
    // mcpConnected=false wins REGARDLESS of the watermark ordinal.
    const p = specPrompt(posture("landing", false, "verify_done"));
    expect(p).toContain(TIER_MCP_ONE_LINE);
    expect(p).toContain(TIER_MCP_NO_QUESTION);
    expect(p).toContain(TIER_MCP_CONNECT_NOT_INSTALL);
    // The connect tier pre-empts every teaching tier.
    expect(p).not.toContain(TIER_BUILD);
    expect(p).not.toContain(TIER_EXPERIENCED);
  });

  it("ac-5 / ac-25: the connect tier delivers the 3-step handoff, with copyable text via a render_handoff Copy button (never a card, never inline)", () => {
    tagAc(AC(5));
    // ac-25 (dec-8): the connect tier reuses the existing connect path via render_handoff,
    // says "connect" not "install", and hand-rolls no per-tool instruction matrix.
    tagAc(AC(25));
    const p = specPrompt(posture("landing", false, "none"));
    // The three-step sequence: connect → copy URL → paste + tell it to use MCP.
    expect(p).toContain("copy THIS Spec");
    expect(p).toContain(HANDOFF_PASTE_STEP);
    expect(p).toContain(TIER_MCP_CONNECT_NOT_INSTALL);
    // Every copyable piece rides a render_handoff Copy button — not inline prose,
    // and (post-t-12) not a persistent on-screen card.
    expect(p).toContain("render_handoff");
    expect(p).toContain(COPY_BUTTON_RULE);
    expect(p).toContain(COPY_NO_INLINE);
  });

  it("ac-5: the copyable-text-via-render_handoff rule is cross-tier (present even once connected)", () => {
    tagAc(AC(5));
    // The COPYABLE TEXT RULE lives in the shared why-first preamble, so it governs
    // every tier — a connected user copying a build-handoff prompt gets a Copy button too.
    for (const wm of ["none", "specify_build", "verify_done"] as PhaseWatermark[]) {
      const p = specPrompt(posture("landing", true, wm));
      expect(p).toContain("render_handoff");
      expect(p).toContain(COPY_BUTTON_RULE);
    }
  });

  it("ac-19: why-before-how leads EVERY tier", () => {
    tagAc(AC(19));
    const watermarks: PhaseWatermark[] = [
      "none",
      "specify_build",
      "build_verify",
      "verify_done",
    ];
    // The connected tiers…
    for (const wm of watermarks) {
      expect(specPrompt(posture("landing", true, wm))).toContain(WHY_FIRST);
      expect(specPrompt(posture("return", true, wm))).toContain(WHY_FIRST);
    }
    // …and the disconnected tier.
    expect(specPrompt(posture("landing", false, "none"))).toContain(WHY_FIRST);
  });
});

describe("spec-482 t-8 — return-visit reorientation (ac-17 / ac-18)", () => {
  it("ac-17: return entry → a fixed-shape reorientation, no replay, no elapsed-time branching", () => {
    tagAc(AC(17));
    const p = specPrompt(posture("return", true, "none"));
    expect(p).toContain(RETURN_FIXED);
    expect(p).toContain(RETURN_NO_REPLAY);
    expect(p).toContain(RETURN_NO_ELAPSED);
  });

  it("ac-18: return visit reuses the SAME signals — only the entry framing differs from landing", () => {
    tagAc(AC(18));
    // Same "what's open" reading as the landing recap.
    const ret = specPrompt(posture("return", true, "specify_build"));
    expect(ret).toContain(WHATS_OPEN);

    // For identical signals, landing and return differ ONLY in the entry framing —
    // the tier block (the next-action) is byte-for-byte the same.
    const landingBlock = toOpeningPosture({ entry: "landing", tier: "teach_verify" });
    const returnBlock = toOpeningPosture({ entry: "return", tier: "teach_verify" });
    expect(landingBlock).toContain(LANDING_RECAP);
    expect(returnBlock).toContain(RETURN_FIXED);
    // Strip the framing lines: both must carry the identical tier text (TIER_VERIFY).
    expect(landingBlock).toContain(TIER_VERIFY);
    expect(returnBlock).toContain(TIER_VERIFY);
    // Neither leaks the other's framing.
    expect(returnBlock).not.toContain(LANDING_RECAP);
    expect(landingBlock).not.toContain(RETURN_FIXED);
  });
});
