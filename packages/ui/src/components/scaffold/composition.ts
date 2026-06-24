// spec-343 t-3 / t-8: segment composition for the redesigned Scaffold surface.
//
// The redesign renders the composed prompt a circumstance produces as an
// ordered stack of SEGMENTS (base vs the team's additions, inline, in
// composition order) instead of a single monospace dump. These helpers split
// the same content the @memex/shared projections (toNudge / toRubric /
// toButtonPrompt) join into one string — and the spec-343 ac-8 guard asserts
// that `segments.map(s => s.text).join(SEGMENT_SEP)` is byte-identical to the
// projection output for every (tool, phase), transition, button, and the
// global band. Presentation changes; the prompt the agents receive does not.
//
// House style mirrors scaffold-model.ts: pure data, pure functions, no I/O.

import {
  toButtonPrompt,
  toNudge,
  toRubric,
  type GuidanceBlock,
  type GuidanceEmphasis,
  type Phase,
  type ScaffoldDataset,
  type Transition,
} from '@memex/shared';
import type { OrgScaffoldAddition } from '../../api/scaffold';

/** The separator the projections use between blocks. Must stay in lockstep
 *  with scaffold-model.ts's `.join('\n\n')` — the ac-8 guard pins it. */
export const SEGMENT_SEP = '\n\n';

/** One unit of composed prompt text, tagged by provenance so the UI can render
 *  base prose and the team's additions distinctly inline. Org segments carry
 *  the persisted row (`id` + `block`) so the detail can wire toggle/edit/delete
 *  controls without a second lookup. */
export interface ComposedSegment {
  text: string;
  source: 'base' | 'org';
  /** Present only on Org segments — the persisted row id for PATCH/DELETE/toggle. */
  id?: string;
  /** Present only on Org segments — the full block for controls + author/timestamp. */
  block?: OrgScaffoldAddition;
  emphasis?: GuidanceEmphasis;
}

function sortByOrder(blocks: readonly GuidanceBlock[]): GuidanceBlock[] {
  return blocks.slice().sort((a, b) => a.order - b.order);
}

function orgSegment(block: GuidanceBlock): ComposedSegment {
  const withId = block as OrgScaffoldAddition;
  return {
    text: block.text,
    source: 'org',
    id: withId.id,
    block: withId,
    emphasis: block.emphasis,
  };
}

function baseSegment(block: GuidanceBlock): ComposedSegment {
  return { text: block.text, source: 'base', emphasis: block.emphasis };
}

/** Mirror of `matchesNudgeTarget` (scaffold-model.ts) — a target matches a
 *  (tool, phase) context when every present dimension equals the context; an
 *  absent dimension is a wildcard. transition/button targets ride other
 *  channels and never match a nudge. */
function matchesNudge(
  target: GuidanceBlock['target'],
  ctx: { tool?: string; phase?: Phase },
): boolean {
  if (target.transition !== undefined) return false;
  if (target.button !== undefined) return false;
  if (target.phase !== undefined && target.phase !== ctx.phase) return false;
  if (target.tool !== undefined && target.tool !== ctx.tool) return false;
  return true;
}

/** Segments for a (tool, phase) nudge circumstance. Join === toNudge(...). */
export function nudgeSegments(
  dataset: ScaffoldDataset,
  tool: string | undefined,
  phase: Phase | undefined,
  orgBlocks: readonly GuidanceBlock[],
): ComposedSegment[] {
  const base = sortByOrder(
    dataset.baseGuidance.filter((b) => b.source === 'base' && matchesNudge(b.target, { tool, phase })),
  );
  const org = sortByOrder(
    orgBlocks.filter((b) => b.source === 'org' && b.enabled && matchesNudge(b.target, { tool, phase })),
  );
  return [...base.map(baseSegment), ...org.map(orgSegment)];
}

/** Segments for the always-applies (org-global) band. The runtime equivalent
 *  is `toNudge` with no tool and no phase — only empty-target blocks match. */
export function globalSegments(
  dataset: ScaffoldDataset,
  orgBlocks: readonly GuidanceBlock[],
): ComposedSegment[] {
  return nudgeSegments(dataset, undefined, undefined, orgBlocks);
}

/** Segments for a forward-transition gate rubric. Join === toRubric(...). */
export function rubricSegments(
  dataset: ScaffoldDataset,
  transition: Transition,
  orgBlocks: readonly GuidanceBlock[],
): ComposedSegment[] {
  const baseRubric = dataset.transitions.find((t) => t.transition === transition);
  const orgChecks = sortByOrder(
    orgBlocks.filter(
      (b) =>
        b.source === 'org' &&
        b.enabled &&
        b.target.transition === transition &&
        b.target.phase === undefined &&
        b.target.tool === undefined,
    ),
  );
  const segments: ComposedSegment[] = [];
  if (baseRubric) segments.push({ text: baseRubric.text, source: 'base' });
  segments.push(...orgChecks.map(orgSegment));
  return segments;
}

/** Segments for a prompt-button circumstance. Join === toButtonPrompt(...) with
 *  an empty context (placeholders left intact, exactly as the preview shows). */
export function buttonSegments(
  dataset: ScaffoldDataset,
  buttonId: string,
  orgBlocks: readonly GuidanceBlock[],
): ComposedSegment[] {
  const button = dataset.promptButtons.find((b) => b.id === buttonId);
  if (!button) return [];
  const orgAppends = sortByOrder(
    orgBlocks.filter(
      (b) =>
        b.source === 'org' &&
        b.enabled &&
        b.target.button === buttonId &&
        b.target.phase === undefined &&
        b.target.tool === undefined &&
        b.target.transition === undefined,
    ),
  );
  return [{ text: button.text, source: 'base' }, ...orgAppends.map(orgSegment)];
}

/** Stage-guidance segments for a phase — phase-targeted blocks that aren't
 *  scoped to a single tool (target.phase === phase, no tool/transition/button).
 *  This is a UI grouping (a sub-set of the phase's nudge content), not a
 *  standalone runtime projection, so it is not part of the ac-8 join guard. */
export function stageSegments(
  dataset: ScaffoldDataset,
  phase: Phase,
  orgBlocks: readonly GuidanceBlock[],
): ComposedSegment[] {
  const match = (b: GuidanceBlock): boolean =>
    b.target.phase === phase &&
    b.target.tool === undefined &&
    b.target.transition === undefined &&
    b.target.button === undefined;
  const base = sortByOrder(dataset.baseGuidance.filter((b) => b.source === 'base' && match(b)));
  const org = sortByOrder(orgBlocks.filter((b) => b.source === 'org' && b.enabled && match(b)));
  return [...base.map(baseSegment), ...org.map(orgSegment)];
}

/** The composed string a set of segments represents — base + enabled Org, in
 *  order. Equal to the matching projection output by construction; the ac-8
 *  guard test asserts that equality empirically. */
export function joinSegments(segments: readonly ComposedSegment[]): string {
  return segments.map((s) => s.text).join(SEGMENT_SEP);
}

// Re-export the projections so the guard test imports both from one place.
export { toNudge, toRubric, toButtonPrompt };

// ── Badge / footprint helpers — "where has the team added guidance?" ────────

/** Count of Org rows attached at a phase (stage + tool-in-this-phase nudges). */
export function orgCountForPhase(orgBlocks: readonly GuidanceBlock[], phase: Phase): number {
  return orgBlocks.filter((b) => b.target.phase === phase).length;
}

/** Count of Org rows attached at a forward-transition gate. */
export function orgCountForTransition(
  orgBlocks: readonly GuidanceBlock[],
  transition: Transition,
): number {
  return orgBlocks.filter(
    (b) => b.target.transition === transition && b.target.phase === undefined && b.target.tool === undefined,
  ).length;
}

/** Count of org-global rows (empty target — they ride the always-applies band). */
export function orgCountGlobal(orgBlocks: readonly GuidanceBlock[]): number {
  return orgBlocks.filter(
    (b) =>
      b.target.phase === undefined &&
      b.target.tool === undefined &&
      b.target.transition === undefined &&
      b.target.button === undefined,
  ).length;
}

/** Count of Org rows appended to a specific prompt button. */
export function orgCountForButton(orgBlocks: readonly GuidanceBlock[], buttonId: string): number {
  return orgBlocks.filter(
    (b) =>
      b.target.button === buttonId &&
      b.target.phase === undefined &&
      b.target.tool === undefined &&
      b.target.transition === undefined,
  ).length;
}
