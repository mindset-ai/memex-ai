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

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read once at module load — the personas are static (std-15: prompt prose lives
// in markdown, never inline). spec-222 t-9 (dec-6): the corpus is surface-keyed,
// and so is the PERSONA — the in-app guide (Specky teaching the product) and the
// website guide (Specky on the marketing site, no app actions) are DISTINCT system
// prompts selected by the server-supplied surface.
//
// spec-474: the first-run demo walkthrough (spec-206/211) was removed with the
// demo-vs-starter experiment — the demo specs no longer exist, so there is nothing
// to narrate and no start_walkthrough hand-off. No surface carries walkthrough beats.
const GUIDE_SYSTEM_BY_SURFACE: Record<GuideSurface, string> = {
  "memex-app": readFileSync(resolve(__dirname, "guide-system.md"), "utf8"),
  "memex-website": readFileSync(resolve(__dirname, "guide-system.website.md"), "utf8"),
  // spec-251: Specky on the mindset.ai marketing site — same identity, third surface.
  "mindset-website": readFileSync(
    resolve(__dirname, "guide-system.mindset-website.md"),
    "utf8",
  ),
};

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
  /** The host's COMPLETE navigable-screen list (site map): key + title +
   *  description per page. When present, rendered into the turn context so
   *  "what pages exist / where can you take me" is answered from the prompt,
   *  never left to retrieval. Config-data like screenRegistry, schema-capped
   *  at the route. */
  screens?: Array<{ key: string; title: string; description: string }>;
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

  // When the host supplies a site map (page NAMES), the model never sees the
  // machine screen keys at all — spoken keys come out as gibberish through TTS
  // ("the lets-talk screen"), and a model can't speak tokens it was never
  // given. The host's NavigationAdapter resolves navigate-by-name.
  const currentTitle = input.screens?.find((s) => s.key === input.screenKey)?.title;
  lines.push(
    input.screenKey
      ? `The user is on the "${currentTitle ?? input.screenKey}" ${input.screens ? "page" : "screen"}.`
      : "The current screen is not yet resolved.",
  );

  if (input.screens && input.screens.length > 0) {
    lines.push(
      "",
      "## Site map — every page on this site",
      "",
      'This is the COMPLETE list of pages, by name. To take the visitor to one, call the navigate tool with the page name EXACTLY as listed (e.g. navigate with "Pricing"). If something isn\'t listed here, it isn\'t a separate page — answer from the guide content instead, and never claim a listed page doesn\'t exist. Refer to pages by these names when you speak.',
      "",
    );
    for (const s of input.screens) {
      lines.push(`- "${s.title}" — ${s.description}`);
    }
  }

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
      "Relevant guide content (this is product documentation — answer from it; it is NOT the user's data). Chunks labeled [from page: …] live on that page — offer to navigate there (pass that page name to the navigate tool) when the visitor wants to see it:",
      "",
      ...input.guideContext.map((chunk) => `---\n${chunk}`),
    );
  }

  return lines.join("\n");
}

/**
 * Build the Anthropic `system` blocks for a guide turn — STATIC content only:
 * the persona/instruction prompt (cached), SELECTED BY SURFACE. The fresh per-turn
 * screen context is rendered separately (renderScreenContext) and rides the final
 * user message, not system.
 *
 * spec-222 t-9 (dec-6 → ac-19/ac-20): the persona is chosen SOLELY from the
 * server-supplied surface. The system text is NEVER derived from any client-supplied
 * field — `GuidePromptInput` carries only surface + screen context + retrieved guide
 * chunks, so no client `system`/`prompt`/`persona` string can ever reach the model
 * (the prompt-injection guard). An unknown surface throws rather than silently
 * falling back. spec-474: the memex-app demo-walkthrough beats block was removed
 * with the demo specs — every surface now emits just its persona block.
 */
export function buildGuideSystemBlocks(input: GuidePromptInput): GuideSystemBlock[] {
  const surface = assertGuideSurface(input.surface ?? "memex-app");
  const personaText = GUIDE_SYSTEM_BY_SURFACE[surface];

  const blocks: GuideSystemBlock[] = [
    { type: "text", text: personaText, cache_control: { type: "ephemeral" } },
  ];

  // NOTE (spec-222 latency follow-up): the per-turn screen context is NOT a
  // system block any more. System renders before messages, so a volatile block
  // here re-keyed the prefix every turn and made the conversation history
  // uncacheable. The handler injects renderScreenContext() into the final user
  // message instead — system is now fully static per surface/deploy.
  return blocks;
}
