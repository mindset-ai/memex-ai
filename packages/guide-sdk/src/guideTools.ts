// spec-190 t-5 / dec-4: client-side execution of the guide's UI tools. The guide
// graph (dec-1) emits a tool_use; React performs it here. highlight resolves a
// registry id to the live DOM node (t-4) and flashes it; navigate validates a
// registered, navigable screen key BEFORE any router call and runs inside the
// user's authenticated session via the app router (so existing permission
// enforcement applies unchanged — unauthorized → 404 per std-7; back-button
// reversible). The guide NEVER client-executes a product-data tool (dec-4 /
// ac-28): dispatchGuideUiTool only knows highlight + navigate.

import { findGuideElement } from './guideElements';
import type { NavigationAdapter, NavigateOutcome } from './navigation/NavigationAdapter';

const HIGHLIGHT_CLASS = 'guide-highlight';
const PULSE_MS = 1000;
const PULSE_COUNT = 3;
/** High-contrast violet, visible on light and dark hosts alike. */
const HIGHLIGHT_RGB = '124, 58, 237';

/**
 * The highlight visual must be SELF-SUFFICIENT: the highlighted node lives in
 * the HOST light DOM, where the engine's shadow-root CSS cannot reach, and
 * host sites ship no `.guide-highlight` rule — a class alone renders NOTHING
 * there (observed on mindset.ai: the model highlighted, the visitor saw only
 * the scroll). So the visual is a pronounced pulsing ring driven inline + via
 * the Web Animations API; the class still applies so hosts that DO define a
 * rule (the Memex app) can layer their own styling on top.
 *
 * The highlight PERSISTS: it stays on the element until the guide highlights
 * something else (the new highlight replaces the old one) or the element
 * unmounts. A timed flash proved too easy to miss.
 */
let clearActiveHighlight: (() => void) | null = null;

function applyHighlight(node: HTMLElement): void {
  clearActiveHighlight?.();

  const prevOutline = node.style.outline;
  const prevOffset = node.style.outlineOffset;
  node.classList.add(HIGHLIGHT_CLASS);
  node.style.outline = `3px solid rgba(${HIGHLIGHT_RGB}, 0.9)`;
  node.style.outlineOffset = '3px';

  // Pronounced expanding/fading ring to catch the eye, then the solid outline
  // stays. WAAPI is absent in jsdom and very old browsers; the static outline
  // above still shows there.
  const pulse = node.animate?.(
    [
      { boxShadow: `0 0 0 0 rgba(${HIGHLIGHT_RGB}, 0.85)` },
      { boxShadow: `0 0 0 18px rgba(${HIGHLIGHT_RGB}, 0)` },
    ],
    { duration: PULSE_MS, iterations: PULSE_COUNT },
  );

  clearActiveHighlight = () => {
    clearActiveHighlight = null;
    pulse?.cancel();
    node.classList.remove(HIGHLIGHT_CLASS);
    node.style.outline = prevOutline;
    node.style.outlineOffset = prevOffset;
  };
}

export interface HighlightResult {
  ok: boolean;
}

/** Highlight the current screen's element — persistently, replacing any prior
 *  highlight. Best-effort: a missing element (not currently rendered) is a
 *  no-op, never a throw. */
export function executeHighlight(input: { elementId?: string }): HighlightResult {
  const id = input?.elementId;
  if (!id) return { ok: false };
  const node = findGuideElement(id);
  if (!node) return { ok: false };
  applyHighlight(node);
  node.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  return { ok: true };
}

/**
 * spec-222 t-6 (dec-5) — host capability flags. The SDK CORE ships only the
 * reusable engine (highlight + navigate). The app-only demo-walkthrough tools
 * (`advance_demo` / `start_walkthrough`, spec-211) activate ONLY when the host
 * enables `walkthrough` — the Memex app sets it; the public website does NOT, so
 * those tools are inert on the website even if the model emits them (ac-6, ac-18).
 */
export interface GuideCapabilities {
  /** Enables the spec-211 demo-walkthrough client tools (advance_demo /
   *  start_walkthrough). App-only; absent (false) on the website. */
  walkthrough?: boolean;
}

export interface NavigateContext {
  /** spec-222 (ac-9): the injected navigation seam. It OWNS key→path validation
   *  and the actual navigation (the engine no longer touches react-router or
   *  `@memex/shared`). executeNavigate delegates to `adapter.navigate(screen)`. */
  adapter: NavigationAdapter;
  /** spec-222 t-6: which optional host features are live. Walkthrough tools are
   *  gated on `capabilities.walkthrough`. Absent → core-only (website posture). */
  capabilities?: GuideCapabilities;
  /** spec-206 t-2/dec-1: advance the shared Handhold reveal pointer (board walks
   *  draft→specify→build→verify→done). Optional so callers that don't wire it
   *  (and tests) degrade to a no-op rather than throwing. */
  advanceDemo?: () => void;
  /** spec-211 t-3 (dec-1): hand control to the client demo-walkthrough sequencer.
   *  The guide calls `start_walkthrough` when the user accepts the offer; the
   *  client then drives the speech-synced per-phase tour. Optional → no-op. */
  startWalkthrough?: () => void;
}

export interface AdvanceDemoResult {
  ok: boolean;
}

/** Advance the demo reveal pointer one phase (dec-1). Best-effort: a missing
 *  callback (no provider wired) is a no-op, never a throw — mirrors highlight. */
export function executeAdvanceDemo(ctx: NavigateContext): AdvanceDemoResult {
  if (!ctx.advanceDemo) return { ok: false };
  ctx.advanceDemo();
  return { ok: true };
}

/** spec-211 t-3: start the client demo-walkthrough sequencer. Best-effort no-op
 *  when nothing is wired (tests / no sequencer mounted). */
export function executeStartWalkthrough(ctx: NavigateContext): { ok: boolean } {
  if (!ctx.startWalkthrough) return { ok: false };
  ctx.startWalkthrough();
  return { ok: true };
}

export type NavigateResult = NavigateOutcome;

/** Navigate to a registered, navigable screen. spec-222 (ac-9): the validate-then-
 *  navigate decision now lives in the injected adapter — it owns key→path
 *  resolution and the actual navigation, and returns the NavigateOutcome so the
 *  ok/path/reason contract is preserved (an unregistered / detail-only destination
 *  is rejected WITHOUT navigating, ac-26). The engine only guards the missing-screen
 *  case before delegating. */
export function executeNavigate(input: { screen?: string }, ctx: NavigateContext): NavigateResult {
  if (!input?.screen) return { ok: false, reason: 'missing screen' };
  return ctx.adapter.navigate(input.screen);
}

/** The CORE client tools — always live in the SDK (the reusable engine, ac-6). */
export const CORE_CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set(['highlight', 'navigate']);

/** The app-only demo-walkthrough client tools (spec-211) — live ONLY when the
 *  host enables the `walkthrough` capability (ac-18). */
export const WALKTHROUGH_CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'advance_demo',
  'start_walkthrough',
]);

/** Every client tool the engine CAN recognise (core ∪ capability-gated). The
 *  ACTIVE set for a given host is `activeClientToolNames(capabilities)`. */
export const GUIDE_CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CORE_CLIENT_TOOL_NAMES,
  ...WALKTHROUGH_CLIENT_TOOL_NAMES,
]);

/** The client tools active for the given host capabilities (spec-222 t-6). Core
 *  always; the walkthrough tools only when `capabilities.walkthrough` is set —
 *  so the website (no capabilities) is core-only, the app (walkthrough:true) gets
 *  the demo tools too. */
export function activeClientToolNames(capabilities?: GuideCapabilities): ReadonlySet<string> {
  if (!capabilities?.walkthrough) return CORE_CLIENT_TOOL_NAMES;
  return GUIDE_CLIENT_TOOL_NAMES;
}

/**
 * Dispatch a guide UI tool emitted by the graph. Core tools (highlight/navigate)
 * always run; the walkthrough tools (advance_demo/start_walkthrough) run ONLY when
 * the host enabled the `walkthrough` capability (ac-18) — otherwise they are
 * refused, inert on the website. Any other tool name (incl. a product-data tool)
 * is not a client UI tool and is refused here (dec-4 / ac-28).
 */
export function dispatchGuideUiTool(
  name: string,
  input: Record<string, unknown>,
  ctx: NavigateContext,
): { ok: boolean; path?: string; reason?: string } {
  switch (name) {
    case 'highlight':
      return executeHighlight(input as { elementId?: string });
    case 'navigate':
      return executeNavigate(input as { screen?: string }, ctx);
    case 'advance_demo':
    case 'start_walkthrough':
      // Capability gate (ac-18): inert unless the host enabled the walkthrough.
      if (!ctx.capabilities?.walkthrough) {
        return { ok: false, reason: 'capability not enabled: walkthrough' };
      }
      return name === 'advance_demo' ? executeAdvanceDemo(ctx) : executeStartWalkthrough(ctx);
    default:
      return { ok: false };
  }
}
