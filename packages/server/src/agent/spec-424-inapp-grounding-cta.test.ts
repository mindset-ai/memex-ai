// spec-424 t-3 (ac-12; scope ac-6) — the in-app agent's honest grounding handoff.
//
// dec-4: the in-app agent CANNOT ground. `ground_spec` is hard-gated to
// `channel='mcp'`, and the agent cannot read the repo either. std-34 says no
// human-facing surface may instruct an MCP-only step, so the agent must POINT,
// never INSTRUCT — and it must not stay silent, because a Spec drifting
// ungrounded through specify is the failure this whole Spec exists to prevent.
//
// ── WHY THE SEAM IS buildSystemBlocks, NOT toPromptBlocks ─────────────────
// ac-12 asks what the IN-APP SURFACE emits. A `toPromptBlocks(BASE_SCAFFOLD,
// 'specify')` assertion would prove the block is registered and prove nothing
// about whether it reaches the agent — the block could be projected and then
// dropped by the composition, which is precisely the class of gap spec-424 was
// written about (spec-409's prose existed and never got delivered). So this
// asserts the COMPOSED system prompt the primary Spec agent actually receives.
//
// ── WHAT THIS TEST PINNED THAT THE TASK DID NOT KNOW ──────────────────────
// t-3's description says "nothing emits a grounding CTA on the in-app surface".
// True, but the real gap is wider and has TWO independent causes, both read at
// source on this branch:
//
//   1. The `code-grounding` prose is `surface: 'shared_nudge'`, so it rides the
//      nudge/rubric channels only and never enters the React system prompt.
//   2. `SHARED_HANDOFF_GUIDANCE` — the canonical map that contains "Asked to
//      TOUCH CODE → the coding agent over MCP" — is appended ONLY for
//      `scopedMode` of standards/issues/skills (`system-prompt.ts`), and the
//      primary Spec agent is `isPrimaryAgent = !scaffoldMode && !driftMode &&
//      !scopedMode`, which excludes it by construction.
//
// So the agent a user talks to ON A SPEC PAGE has no path to "this needs the
// coding agent" — for grounding or for anything else. This Spec closes the
// grounding case only, which is what dec-4 scoped. The general case (the primary
// agent carrying no handoff map at all) is registered as a separate todo Issue
// rather than fixed in passing: adding all five canonical handoffs to the
// most-used agent in the product is a behaviour change spec-424 does not own.
//
// ── WHY IT POINTS AT THE BUTTON RATHER THAN COMPOSING ITS OWN PROMPT ──────
// std-38 cl-4's affordance is `render_handoff` (an ad-hoc copyable prompt). This
// CTA points at the `plan-handoff` Prompt Button instead, and that is not a
// conflict: the button IS the maintained grounding instruction. Having the agent
// compose its own would create a second copy of prose that already has an owner
// (spec-33/dec-4). dec-4 chose the DRY path.
//
// ── std-28 ────────────────────────────────────────────────────────────────
// No Playwright journey. This adds agent prose to a system prompt; it renders no
// new element, and the Prompt Button it names already exists on the Spec page.
// There is no new user-facing flow to drive. Recorded here because the AC asks
// for the call to be made explicitly, and "prose only, and here is why" is the
// answer rather than an omission.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";
import { BASE_SCAFFOLD } from "@memex/shared";
import { buildSystemBlocks } from "./system-prompt.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-424/acs/ac-${n}`;

/** The primary Spec agent: no scaffold mode, no drift mode, no scoped mode. */
const primaryPrompt = (phase: "draft" | "specify" | "build" | "verify" | "done") =>
  buildSystemBlocks("Doc context.", phase)
    .map((b) => b.text)
    .join("\n\n");

/** The button dec-4 points at — named, so the user knows where to click. */
const NAMES_THE_BUTTON = /plan-handoff|handoff prompt|Specify handoff/i;
/** It has to say WHERE the work happens, or "handoff" is meaningless. */
const NAMES_THE_CODING_AGENT = /coding agent/i;
/**
 * std-34's negative. The in-app agent must not name the tool it cannot call —
 * the button's own prose owns that instruction, and repeating it here would both
 * instruct an impossible step and duplicate an owned string.
 */
const THE_MCP_ONLY_TOOL = /ground_spec/;

describe("spec-424 ac-12 — the in-app agent points at the grounding handoff, never instructs it", () => {
  it("the composed primary-agent prompt for specify carries the handoff and names the button", () => {
    tagAc(AC(12));
    tagAc(AC(6));

    const specify = primaryPrompt("specify");

    // ── Delivery is asserted by the block's OWN text reaching the composed
    // prompt, not by a keyword. A first draft of this test matched /coding
    // agent/ against the whole prompt and passed BEFORE the block existed — the
    // phrase occurs in the unrelated Skills block. A keyword assertion over a
    // large composed prompt is a coin flip; this pins the actual delivery.
    const node = BASE_SCAFFOLD.promptBlocks.find((n) => n.id === "grounding-handoff");
    expect(node, "the grounding-handoff block is not in the Scaffold model").toBeDefined();
    expect(
      specify,
      "the grounding handoff block never reaches the composed in-app prompt — registered but not delivered, which is the exact gap this Spec exists to close",
    ).toContain(node!.text);

    // ── Content: it has to say WHERE the work happens and WHERE to click.
    expect(node!.text, "the handoff does not name the coding agent").toMatch(
      NAMES_THE_CODING_AGENT,
    );
    expect(
      node!.text,
      "the handoff does not name the Prompt Button, so the user is told to hand off but not where to click",
    ).toMatch(NAMES_THE_BUTTON);

    // ── It must land where the impossible instruction lands. The in-app agent
    // is ALREADY told to "ground code-touching decisions against current
    // source" — shared phase guidance, correct for the MCP agent, impossible
    // here. The handoff is what makes that instruction actionable instead of a
    // dead end, so it has to be present in the same phase.
    expect(
      specify,
      "the specify prompt no longer carries the grounding instruction — if it moved, this handoff may now be orphaned",
    ).toMatch(/[Gg]round code-touching decisions against current source/);

    // ── std-34, the load-bearing negative. The in-app agent cannot call this
    // tool; naming it would instruct a step it cannot fulfil.
    expect(
      specify,
      "the in-app prompt names ground_spec — std-34 forbids instructing an MCP-only step here",
    ).not.toMatch(THE_MCP_ONLY_TOOL);
  });

  it("the copy is Scaffold data, not inline, and is portable", () => {
    tagAc(AC(12));

    // std-15 / std-38 cl-8: in-app agent prose lives in the scaffold model. This
    // is NOT the cl-68 footer carve-out — that applies to the composed MCP
    // footer (t-1), not to a React system-prompt block.
    const node = BASE_SCAFFOLD.promptBlocks.find((n) => n.id === "grounding-handoff");
    expect(node, "the grounding-handoff block is not in the Scaffold model").toBeDefined();
    expect(node!.surface, "the block must be react_only — it is in-app agent prose").toBe(
      "react_only",
    );

    // std-22: the copy reaches agents working on arbitrary codebases.
    const text = node!.text;
    expect(text, "the copy hardcodes a path or directory (std-22)").not.toMatch(
      /packages\/|src\/|\.ts\b/,
    );
    expect(text, "the copy names a framework or package manager (std-22)").not.toMatch(
      /vitest|jest|pnpm|npm |yarn|playwright/i,
    );
    expect(text, "the copy cites a Standard by handle (std-22)").not.toMatch(/\bstd-\d+/i);

    // std-15: it must not ALSO be inline in the server. One home.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "system-prompt.ts"),
      "utf8",
    );
    expect(
      src,
      "the CTA prose was inlined in system-prompt.ts instead of living in the Scaffold (std-15)",
    ).not.toMatch(NAMES_THE_BUTTON);
  });

  it("the ground_spec channel gate is untouched and still points at a coding agent with the repo open", () => {
    tagAc(AC(12));

    // dec-4 changes PROMPTING only. The structural refusal that makes the honest
    // CTA necessary in the first place must still be there: if this gate were
    // relaxed, the CTA would be lying about the boundary rather than describing
    // it. Read at source rather than assumed.
    const lifecycle = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "handlers", "lifecycle.ts"),
      "utf8",
    );
    expect(lifecycle, "ground_spec left the lifecycle handler").toMatch(/name:\s*"ground_spec"/);
    expect(
      lifecycle,
      "the channel='mcp' gate on ground_spec is gone — the in-app CTA now describes a boundary that does not exist",
    ).toMatch(/channel\s*[!=]==?\s*["']mcp["']/);
    expect(
      lifecycle,
      "the rejection no longer tells the caller where the work belongs",
    ).toMatch(/coding agent/i);
  });
});
