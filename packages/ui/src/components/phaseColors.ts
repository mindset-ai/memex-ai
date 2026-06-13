import type { SpecStatus } from '../api/types';

/**
 * Spec-view header phase palette (spec-252 dec-1).
 *
 * A DEDICATED phase-colour set, deliberately decoupled from `statusVariant`:
 * `specify`/`review`/`open` all share the `warning` variant, so recolouring
 * `warning` to make specify purple would also recolour open-decision / issue
 * badges and review docs. Instead, specify gets its own purple tokens here.
 *
 * Header-only scope (confirmed 2026-06-12): this drives the phase-bar current
 * pill (PhaseTabBar) and the coloured header container (DocDocument). Board /
 * list surfaces that colour specify via `statusVariant` stay amber — see
 * spec-252 issue-1 for the follow-up.
 *
 * specify / build / verify each use the dedicated phase tokens (exact Figma
 * hue @ 80% pill + @ 10% container). draft has no Figma hue yet, so it keeps the
 * neutral status token for the pill.
 */
export interface PhaseColor {
  /** Current-phase pill fill — bg + text + border classes. */
  pill: string;
  /** Pale container-bg wash for the coloured header container. */
  container: string;
}

const PALETTE: Record<'draft' | 'specify' | 'build' | 'verify', PhaseColor> = {
  draft: {
    pill: 'bg-status-neutral-bg text-status-neutral-text border-status-neutral-border',
    container: 'bg-phase-draft-container',
  },
  specify: {
    pill: 'bg-phase-specify-bg text-phase-specify-text border-phase-specify-border',
    container: 'bg-phase-specify-container',
  },
  build: {
    pill: 'bg-phase-build-bg text-phase-build-text border-phase-build-border',
    container: 'bg-phase-build-container',
  },
  verify: {
    pill: 'bg-phase-verify-bg text-phase-verify-text border-phase-verify-border',
    container: 'bg-phase-verify-container',
  },
};

/**
 * The phase's pill + container colours, or `null` for `done` — which keeps its
 * current treatment (the phase bar is hidden at done; DoneSummary takes over).
 */
export function phaseColors(phase: SpecStatus): PhaseColor | null {
  return PALETTE[phase as keyof typeof PALETTE] ?? null;
}
