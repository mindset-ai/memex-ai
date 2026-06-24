// spec-343 t-5: target language for in-context authoring.
//
// dec-5 — the admin authors guidance against the circumstance they're viewing;
// the target is DERIVED from timeline position and stated in plain language,
// never hand-assembled from raw dimension dropdowns. These helpers turn a
// GuidanceTarget into prose and offer the optional one-click "broaden" choices
// (relax exactly one dimension). They are pure so the editor and its tests
// share one source of truth.

import type { GuidanceTarget, Phase, Transition } from '@memex/shared';

/** The phase a forward transition departs FROM (for "specify→build" phrasing). */
const PHASE_BEFORE_TRANSITION: Record<Transition, Phase> = {
  specify: 'draft',
  build: 'specify',
  verify: 'build',
  done: 'verify',
};

/** A human sentence for the circumstance a target attaches to. `buttonLabel`,
 *  when supplied, renders the button's visible label instead of its slug. */
export function describeTarget(target: GuidanceTarget, buttonLabel?: string): string {
  if (target.button !== undefined) {
    return `the "${buttonLabel ?? target.button}" prompt button`;
  }
  if (target.transition !== undefined) {
    const from = PHASE_BEFORE_TRANSITION[target.transition];
    return `at the ${from} → ${target.transition} gate`;
  }
  if (target.tool !== undefined && target.phase !== undefined) {
    return `when ${target.tool} runs during ${target.phase}`;
  }
  if (target.tool !== undefined) {
    return `when ${target.tool} runs, in every phase`;
  }
  if (target.phase !== undefined) {
    return `during ${target.phase} (every tool)`;
  }
  return 'every agent response (always applies)';
}

/** True when this target is org-global — broad enough to dilute every nudge,
 *  so the editor flags it (spec-68 D-1 / dec-3). */
export function isBroadTarget(target: GuidanceTarget): boolean {
  return (
    target.phase === undefined &&
    target.tool === undefined &&
    target.transition === undefined &&
    target.button === undefined
  );
}

export interface BroadenOption {
  label: string;
  target: GuidanceTarget;
  /** True when the broadened target is org-global (UI flags it as broad). */
  broad: boolean;
}

/** The one-click broaden choices for a derived target — each relaxes exactly
 *  one dimension. Returns [] when there's nothing sensible to broaden to
 *  (gates, buttons, and already-global targets stay put). */
export function broadenOptions(target: GuidanceTarget): BroadenOption[] {
  // A tool-in-phase nudge can broaden along either axis.
  if (target.tool !== undefined && target.phase !== undefined) {
    return [
      { label: `${target.tool} in every phase`, target: { tool: target.tool }, broad: false },
      { label: `every tool during ${target.phase}`, target: { phase: target.phase }, broad: false },
    ];
  }
  // A tool-everywhere block can only broaden to org-global.
  if (target.tool !== undefined) {
    return [{ label: 'every agent response (org-global)', target: {}, broad: true }];
  }
  // A phase-wide block can only broaden to org-global.
  if (target.phase !== undefined) {
    return [{ label: 'every agent response (org-global)', target: {}, broad: true }];
  }
  // Gates, buttons, and org-global have no broader rung.
  return [];
}
