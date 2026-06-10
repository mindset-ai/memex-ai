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
const DEFAULT_HIGHLIGHT_MS = 2500;

export interface HighlightResult {
  ok: boolean;
}

/** Flash a highlight on the current screen's element. Best-effort: a missing
 *  element (not currently rendered) is a no-op, never a throw. */
export function executeHighlight(
  input: { elementId?: string },
  opts: { durationMs?: number } = {},
): HighlightResult {
  const id = input?.elementId;
  if (!id) return { ok: false };
  const node = findGuideElement(id);
  if (!node) return { ok: false };
  node.classList.add(HIGHLIGHT_CLASS);
  node.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  const ms = opts.durationMs ?? DEFAULT_HIGHLIGHT_MS;
  setTimeout(() => node.classList.remove(HIGHLIGHT_CLASS), ms);
  return { ok: true };
}

export interface NavigateContext {
  /** spec-222 (ac-9): the injected navigation seam. It OWNS key→path validation
   *  and the actual navigation (the engine no longer touches react-router or
   *  `@memex/shared`). executeNavigate delegates to `adapter.navigate(screen)`. */
  adapter: NavigationAdapter;
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

/** The names the guide executes CLIENT-side. (search_guide is a SERVER tool,
 *  handled by the graph's tools node, not here.) */
export const GUIDE_CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'highlight',
  'navigate',
  // spec-206 t-2 (dec-1): the synced-walkthrough advance. The graph emits it per
  // narrated phase (t-4); React walks the shared reveal pointer here.
  'advance_demo',
  // spec-211 t-3 (dec-1): the guide calls this when the user accepts the demo
  // walkthrough; the client sequencer then drives the speech-synced tour.
  'start_walkthrough',
]);

/**
 * Dispatch a guide UI tool emitted by the graph. Knows ONLY the client UI tools
 * (highlight / navigate / advance_demo) — any other tool name (including any
 * product-data tool) is not a client UI tool and is refused here (dec-4 / ac-28).
 */
export function dispatchGuideUiTool(
  name: string,
  input: Record<string, unknown>,
  ctx: NavigateContext,
): { ok: boolean; path?: string } {
  switch (name) {
    case 'highlight':
      return executeHighlight(input as { elementId?: string });
    case 'navigate':
      return executeNavigate(input as { screen?: string }, ctx);
    case 'advance_demo':
      return executeAdvanceDemo(ctx);
    case 'start_walkthrough':
      return executeStartWalkthrough(ctx);
    default:
      return { ok: false };
  }
}
