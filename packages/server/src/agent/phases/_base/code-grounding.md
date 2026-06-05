<!--
  Cross-phase agent-facing prompts for the doc-27 code-grounding self-classification.
  Loaded once at module init by `services/phase-assessment.ts` via the shared
  `parsePhaseDescriptions` helper. Section keys are `## <key>` where key is one of:
    - prompt
    - nudge:not_applicable
    - nudge:verified
    - nudge:not_verified
  Bodies are trimmed by the parser, so leading/trailing blank lines inside a
  section are fine.
-->

## prompt

Is this Spec's scope code-touching (does any resolved decision name code shape — files, symbols, schema, routes)? If yes, have the resolved decisions been verified against current source? Call assess_spec again with `codeGrounding` set to one of: `not_applicable`, `verified`, or `not_verified`.

## nudge:not_applicable

Spec classified as not code-touching; no grounding check applied.

## nudge:verified

Code-grounding affirmed by agent.

## nudge:not_verified

⚠ No code-grounding on this Spec. If you're driving from a coding agent, walk the resolved decisions against current source before transitioning. Build transition is not blocked.
