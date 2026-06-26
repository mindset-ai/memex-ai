// spec-336 — Home Onboarding v2: the onboarding journey's step metadata.
// spec-421 — v4: condenses to 3 visible steps (About you / Connect to the Memex MCP /
// Create your first spec). Steps 2–5 are hidden from the rail (code kept for later).
// The rail reads mapLabel/mapSubLabel; headline/primary are fallbacks only.
import type { JourneyStepView } from '../types';

// The server-derived steps a user can land on, in order (mirrors the server's
// journeys/onboarding.ts). Steps 2–5 are hidden from the rail by spec-421 but kept
// here so the server milestone engine still tracks them.
export const ONBOARDING_MILESTONE_STEP_IDS = [
  'identity',
  'create-spec',
  'create-first-spec',
  'resolve-decision',
  'add-ac',
  'specs-match-reality',
  'agents-build',
] as const;

// spec-336 dec-3: builder-only steps. spec-421: steps hidden from the rail entirely
// (kept in code for future reintroduction).
export const BUILDER_ONLY_STEP_IDS = ['specs-match-reality', 'agents-build'] as const;

// spec-421 — steps hidden from the rail. Their components are never mounted while hidden
// so no telemetry, done-state badges, or completion machinery fires.
export const HIDDEN_STEP_IDS = ['resolve-decision', 'add-ac', 'specs-match-reality', 'agents-build'] as const;

export const ONBOARDING_STEP_VIEWS: Record<string, JourneyStepView> = {
  // Step 0 — About you. Rendered by IdentityStep (the role triangle) in HomeCanvas.
  identity: {
    id: 'identity',
    mapLabel: 'About you',
    mapSubLabel: 'A quick read on you and your stack',
    headline: 'Built around how you work.',
    primary: { label: 'Continue', kind: 'navigate', target: 'create-spec' },
  },

  // Step 1 — Connect to the Memex MCP. Rendered by CreateSpecStep (MCP install only).
  // spec-421: renamed from "Build exactly what you decided"; Stage 2 moved to step 2.
  'create-spec': {
    id: 'create-spec',
    mapLabel: 'Connect to the Memex MCP',
    mapSubLabel: 'Connect to MCP to get the full magic of Memex',
    headline: 'Connect to the Memex MCP.',
    primary: { label: 'Continue', kind: 'navigate', target: 'create-first-spec' },
  },

  // Step 2 — Create your first spec. Rendered by CreateFirstSpecStep; ticks on hasSpec.
  // spec-421: split out from the old Stage 2 of CreateSpecStep.
  'create-first-spec': {
    id: 'create-first-spec',
    mapLabel: 'Create your first spec',
    mapSubLabel: 'Draft your first spec',
    headline: 'Create your first spec.',
    primary: { label: 'Create your first spec', kind: 'action', target: 'create_spec' },
  },

  // Steps below are hidden from the rail (spec-421) — code kept for future reintroduction.

  // Step 3 — Decisions raised. Rendered by AgentPromptStep; ticks on hasResolvedDecision.
  'resolve-decision': {
    id: 'resolve-decision',
    mapLabel: 'No agent decides for you',
    mapSubLabel: 'Hidden calls surface before a line is written',
    headline: 'No agent decides for you.',
    primary: { label: 'Open your spec', kind: 'action', target: 'open_specs' },
  },

  // Step 4 — Acceptance criteria raised. Rendered by AgentPromptStep; ticks on hasAc.
  'add-ac': {
    id: 'add-ac',
    mapLabel: 'Done becomes a fact',
    mapSubLabel: 'Testable criteria, set before the build starts',
    headline: 'Done becomes a fact.',
    primary: { label: 'Open your spec', kind: 'action', target: 'open_specs' },
  },

  // Step 5 — Improved from your code (BUILDER-ONLY). Rendered by SpecsMatchRealityStep.
  'specs-match-reality': {
    id: 'specs-match-reality',
    mapLabel: 'Specs that match reality',
    mapSubLabel: 'Refined against your actual codebase',
    headline: 'Specs that match reality.',
    primary: { label: 'Open your spec', kind: 'action', target: 'open_specs' },
  },

  // Step 6 — Go build (BUILDER-ONLY, terminal). Rendered by AgentsBuildStep.
  'agents-build': {
    id: 'agents-build',
    mapLabel: 'Agents build in lockstep',
    // Reworded from the design's "One coordinated team on your tasks" — std-1 forbids
    // the reserved noun "team" in user-visible copy (see AgentsBuildStep).
    mapSubLabel: 'One coordinated effort across your tasks',
    headline: 'Agents build in lockstep.',
    primary: { label: 'Open your Specs', kind: 'action', target: 'open_specs' },
  },
};
