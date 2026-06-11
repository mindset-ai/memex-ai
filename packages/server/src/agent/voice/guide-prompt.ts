// spec-190 t-3 (dec-1/dec-6) — assemble the voice guide's system prompt for the
// /voice/guide-chat SSE proxy. The system blocks are STATIC per surface/deploy
// (persona + in-app walkthrough beats, cache_control: ephemeral — the
// prompt-cache breakpoint). The PER-TURN screen-context text is rendered by
// renderScreenContext() and injected into the final user message by the chat
// handler — keeping volatile content out of the system prefix so the
// conversation history caches across turns (spec-222 latency follow-up).
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
import { assertGuideSurface, type GuideSurface } from "../../services/guide-content.js";
import { HANDHOLD_PHASES } from "../../db/handhold-demo.fixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read once at module load — both personas are static (std-15: prompt prose lives
// in markdown, never inline). spec-222 t-9 (dec-6): the corpus is surface-keyed,
// and so is the PERSONA — the in-app guide (Specky teaching the product, with the
// demo walkthrough) and the website guide (Specky on the marketing site, no app
// actions, no walkthrough) are DISTINCT system prompts selected by the
// server-supplied surface. The website persona deliberately EXCLUDES the spec-178
// demo-walkthrough beats.
const GUIDE_SYSTEM_BY_SURFACE: Record<GuideSurface, string> = {
  "memex-app": readFileSync(resolve(__dirname, "guide-system.md"), "utf8"),
  "memex-website": readFileSync(resolve(__dirname, "guide-system.website.md"), "utf8"),
  // spec-251: Specky on the mindset.ai marketing site — same identity, third
  // surface. No walkthrough beats (the beats block below is memex-app-only).
  "mindset-website": readFileSync(
    resolve(__dirname, "guide-system.mindset-website.md"),
    "utf8",
  ),
};

// spec-206 t-4 / spec-211 t-4 (dec-1 / ac-6 / ac-9): the demo walkthrough beats,
// SINGLE-SOURCED from the spec-178 fixture (HANDHOLD_PHASES[].valueCallout) — NOT
// re-typed here and NOT fetched via any doc-lookup tool (the demo specs are
// invisible to every agent surface, spec-178 dec-11). Built once at module load;
// static per deploy, so it rides the cached system block.
//
// spec-211: the app drives the walkthrough one phase at a time (it opens each demo
// spec and advances the board). Each turn it asks the guide to narrate ONE named
// phase — the guide uses that phase's beat below. The guide does NOT narrate all
// five at once and does NOT advance the board itself (see guide-system.md).
const WALKTHROUGH_BEATS = [
  "## Demo walkthrough beats",
  "",
  "Reference beats for the demo-specs walkthrough — one per phase. When the app asks you to narrate a specific phase, narrate THAT phase using its beat below (a sentence or two, spoken), then give a short cue toward the next phase. Do not narrate phases you weren't asked about, and do not advance the board yourself — the app does that.",
  "",
  ...HANDHOLD_PHASES.map((p) => `- **${p.phase}** — ${p.valueCallout}`),
].join("\n");

export interface GuideSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface GuidePromptInput {
  /**
   * Which product surface this session serves (spec-222 t-9, dec-6) — selects the
   * persona/system prompt SERVER-side. Defaults to "memex-app" when omitted so the
   * existing in-app callers keep their behaviour. This is a SERVER-supplied value,
   * never read from client free input (the prompt-injection guard, ac-20).
   */
  surface?: GuideSurface;
  /** Current screen's stable key, or null before the route resolves one. */
  screenKey: string | null;
  /** Highlightable elements on the current screen (dec-3 registry subset). */
  screenRegistry: GuideElement[];
  /** Pre-fetched + per-turn retrieved guide-content chunks (dec-6). */
  guideContext: string[];
}

/**
 * Render the per-turn screen-context text the model reads each turn.
 *
 * Exported (spec-222 latency follow-up): this volatile text is injected into the
 * FINAL user message by the chat handler, NOT emitted as a trailing system block.
 * A volatile system block sits between the cached persona and the message
 * history, so every turn it invalidated the conversation prefix — moving it
 * after the history lets the whole prior conversation be served from cache.
 */
export function renderScreenContext(input: Omit<GuidePromptInput, "surface">): string {
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
 * Build the Anthropic `system` blocks for a guide turn — STATIC content only:
 * the persona/instruction prompt (cached), SELECTED BY SURFACE, plus the in-app
 * walkthrough beats. The fresh per-turn screen context is rendered separately
 * (renderScreenContext) and rides the final user message, not system.
 *
 * spec-222 t-9 (dec-6 → ac-19/ac-20): the persona is chosen SOLELY from the
 * server-supplied surface — "memex-website" gets the website persona and NO
 * walkthrough beats; "memex-app" gets the in-app persona plus the demo walkthrough
 * beats (existing behaviour). The system text is NEVER derived from any
 * client-supplied field — `GuidePromptInput` carries only surface + screen context
 * + retrieved guide chunks, so no client `system`/`prompt`/`persona` string can
 * ever reach the model (the prompt-injection guard). An unknown surface throws
 * rather than silently falling back.
 */
export function buildGuideSystemBlocks(input: GuidePromptInput): GuideSystemBlock[] {
  const surface = assertGuideSurface(input.surface ?? "memex-app");
  const personaText = GUIDE_SYSTEM_BY_SURFACE[surface];

  const blocks: GuideSystemBlock[] = [
    { type: "text", text: personaText, cache_control: { type: "ephemeral" } },
  ];

  // The demo walkthrough beats are an IN-APP concern only — the website guide
  // teaches marketing/docs content and has no demo-specs walkthrough (it can't
  // perform in-app actions). So the beats block is emitted ONLY for memex-app.
  if (surface === "memex-app") {
    // spec-206 t-4: static per deploy, so it shares the cached prefix with the
    // instruction prompt above (ac-6 / ac-9: narration is single-sourced from the
    // fixture, never a doc-lookup).
    blocks.push({
      type: "text",
      text: WALKTHROUGH_BEATS,
      cache_control: { type: "ephemeral" },
    });
  }

  // NOTE (spec-222 latency follow-up): the per-turn screen context is NOT a
  // system block any more. System renders before messages, so a volatile block
  // here re-keyed the prefix every turn and made the conversation history
  // uncacheable. The handler injects renderScreenContext() into the final user
  // message instead — system is now fully static per surface/deploy.
  return blocks;
}
