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

<!--
  spec-409: the human→agent grounding HANDOFF ("ground this Spec in the code,
  then call ground_spec") + the late-specify timing guidance live in the
  Specify Prompt Button (`plan-handoff` in packages/shared/src/scaffold-data.ts,
  STEP 2), NOT here — that is the surface a user copies into their coding agent.
  Keeping a second copy here would be the spec-33/dec-4 duplication. This file
  stays scoped to the assess_spec self-classification nudges above.
-->

