// spec-336 — Home Onboarding v2: the onboarding journey's step metadata.
// (Supersedes spec-305's MCP-first arc.) The six steps mirror the v2 design's six-node
// rail one-for-one; the Home Canvas renders the rail from these mapLabel/mapSubLabel
// pairs and shows the selected step's content in a side panel. Every step's content is
// a bespoke component (triangle, connect+create card, paste-a-prompt cards, product
// shots, go-build handoff), so these view entries are primarily the rail's labels — the
// headline/body fields are a presentational fallback, never the primary surface.
import type { JourneyStepView } from '../types';

// The server-derived steps a user can land on, in order (mirrors the server's
// journeys/onboarding.ts). The last two are builder-only — the Home Canvas hides them
// for non-builder personas (spec-336 dec-3) — but the engine still emits all six.
export const ONBOARDING_MILESTONE_STEP_IDS = [
  'identity',
  'create-spec',
  'resolve-decision',
  'add-ac',
  'specs-match-reality',
  'agents-build',
] as const;

// spec-336 dec-3: the two trailing "Build from your codebase" steps a non-builder never
// sees. The Home Canvas filters the visible step set + the progress-% denominator by
// removing these for non-builder personas.
export const BUILDER_ONLY_STEP_IDS = ['specs-match-reality', 'agents-build'] as const;

export const ONBOARDING_STEP_VIEWS: Record<string, JourneyStepView> = {
  // Step 0 — About you. Rendered by IdentityStep (the role triangle) in HomeCanvas, so
  // the headline/primary here are a fallback only; the rail uses the labels.
  identity: {
    id: 'identity',
    mapLabel: 'About you',
    mapSubLabel: 'A quick read on you and your stack',
    headline: 'Built around how you work.',
    primary: { label: 'Continue', kind: 'navigate', target: 'create-spec' },
  },

  // Step 1 — Create your spec. Rendered by CreateSpecStep (Stage 1 connect MCP + Stage 2
  // create the spec) in HomeCanvas; ticks on hasSpec.
  'create-spec': {
    id: 'create-spec',
    mapLabel: 'Build exactly what you decided',
    mapSubLabel: 'Connect to MCP and create your first spec',
    headline: 'Build exactly what you decided.',
    primary: { label: 'Create your first spec', kind: 'action', target: 'create_spec' },
  },

  // Step 2 — Decisions raised. Rendered by AgentPromptStep; ticks on hasResolvedDecision.
  'resolve-decision': {
    id: 'resolve-decision',
    mapLabel: 'No agent decides for you',
    mapSubLabel: 'Hidden calls surface before a line is written',
    headline: 'No agent decides for you.',
    primary: { label: 'Open your spec', kind: 'action', target: 'open_specs' },
  },

  // Step 3 — Acceptance criteria raised. Rendered by AgentPromptStep; ticks on hasAc.
  // For non-builders this is the TERMINAL step — HomeCanvas shows the handoff message.
  'add-ac': {
    id: 'add-ac',
    mapLabel: 'Done becomes a fact',
    mapSubLabel: 'Testable criteria, set before the build starts',
    headline: 'Done becomes a fact.',
    primary: { label: 'Open your spec', kind: 'action', target: 'open_specs' },
  },

  // Step 4 — Improved from your code (BUILDER-ONLY). Rendered by SpecsMatchRealityStep
  // (4 product shots + the improve-from-code prompt); ticks on planGrounded (spec-337).
  'specs-match-reality': {
    id: 'specs-match-reality',
    mapLabel: 'Specs that match reality',
    mapSubLabel: 'Refined against your actual codebase',
    headline: 'Specs that match reality.',
    primary: { label: 'Open your spec', kind: 'action', target: 'open_specs' },
  },

  // Step 5 — Go build (BUILDER-ONLY, terminal). Rendered by AgentsBuildStep (the go-build
  // handoff prompt). Terminal: no further waiting/advance.
  'agents-build': {
    id: 'agents-build',
    mapLabel: 'Agents build in lockstep',
    // Reworded from the design's "One coordinated team on your tasks" — std-1 forbids the
    // reserved noun "team" in user-visible copy (see AgentsBuildStep).
    mapSubLabel: 'One coordinated effort across your tasks',
    headline: 'Agents build in lockstep.',
    primary: { label: 'Open your Specs', kind: 'action', target: 'open_specs' },
  },
};
