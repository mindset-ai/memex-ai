// spec-190 t-3 (dec-1/dec-6) — assemble the voice guide's system prompt for the
// /voice/guide-chat SSE proxy. Mirrors agent/system-prompt.ts: a STATIC
// instruction block (cache_control: ephemeral — the prompt-cache breakpoint) plus
// a PER-REQUEST screen-context block (no cache_control, so it resolves fresh each
// turn as the screen / retrieved content changes).
//
// The static prompt is markdown (std-15) and lives in agent/voice/guide-system.md
// — deliberately OUTSIDE phases/ (the b-68 drift guard forbids new prose markdown
// there; that guard governs the spec-pipeline prompts, not this distinct agent).
//
// The per-request block carries ONLY the screen's shape (key + highlightable
// element ids/descriptions) and the pre-fetched / retrieved guide-content chunks
// (dec-6). It carries NO tenant data — the guide teaches the product, never reads
// the user's content (dec-4).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GuideElement } from "@memex/shared";
import { HANDHOLD_PHASES } from "../../db/handhold-demo.fixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read once at module load — the prompt is static.
const GUIDE_SYSTEM = readFileSync(resolve(__dirname, "guide-system.md"), "utf8");

// spec-206 t-4 (dec-1 / ac-6 / ac-9): the demo walkthrough beats, SINGLE-SOURCED
// from the spec-178 fixture (HANDHOLD_PHASES[].valueCallout) — NOT re-typed here
// and NOT fetched via any doc-lookup tool (the demo specs are invisible to every
// agent surface, spec-178 dec-11). Built once at module load; static per deploy,
// so it rides the cached system block. guide-system.md tells Specky how to narrate
// these and when to call `advance_demo`.
const WALKTHROUGH_BEATS = [
  "## Demo walkthrough beats",
  "",
  "Narrate these five phases in order when the user accepts the demo-specs walkthrough, calling `advance_demo` after each (see the instructions above). One short spoken beat per phase:",
  "",
  ...HANDHOLD_PHASES.map((p) => `- **${p.phase}** — ${p.valueCallout}`),
].join("\n");

export interface GuideSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface GuidePromptInput {
  /** Current screen's stable key, or null before the route resolves one. */
  screenKey: string | null;
  /** Highlightable elements on the current screen (dec-3 registry subset). */
  screenRegistry: GuideElement[];
  /** Pre-fetched + per-turn retrieved guide-content chunks (dec-6). */
  guideContext: string[];
}

/** Render the per-request screen-context block the model reads each turn. */
function renderScreenContext(input: GuidePromptInput): string {
  const lines: string[] = ["## Current screen context"];

  lines.push(
    input.screenKey
      ? `The user is on the **${input.screenKey}** screen.`
      : "The current screen is not yet resolved.",
  );

  if (input.screenRegistry.length > 0) {
    lines.push("", "Highlightable elements on this screen (use these ids with the highlight tool):");
    for (const el of input.screenRegistry) {
      lines.push(`- \`${el.id}\` — ${el.description}`);
    }
  } else {
    lines.push("", "This screen has no registered highlightable elements.");
  }

  if (input.guideContext.length > 0) {
    lines.push(
      "",
      "Relevant guide content (this is product documentation — answer from it; it is NOT the user's data):",
      "",
      ...input.guideContext.map((chunk) => `---\n${chunk}`),
    );
  }

  return lines.join("\n");
}

/**
 * Build the Anthropic `system` blocks for a guide turn. Block 1 is the static
 * instruction prompt (cached); block 2 is the fresh per-turn screen context.
 */
export function buildGuideSystemBlocks(input: GuidePromptInput): GuideSystemBlock[] {
  return [
    { type: "text", text: GUIDE_SYSTEM, cache_control: { type: "ephemeral" } },
    // spec-206 t-4: the demo walkthrough beats — static per deploy, so it shares
    // the cached prefix with the instruction prompt above (ac-6 / ac-9: narration
    // is single-sourced from the fixture, never a doc-lookup).
    { type: "text", text: WALKTHROUGH_BEATS, cache_control: { type: "ephemeral" } },
    { type: "text", text: renderScreenContext(input) },
  ];
}
