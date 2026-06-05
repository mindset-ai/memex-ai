export {
  computeSpecReadiness,
  blockerLines,
  countStaleDecisions,
  countUnresolvedDecisions,
  isSpecNarrativeStale,
  isForwardTransition,
  isBackwardTransition,
  shouldBlockForwardTransition,
} from './spec-readiness.js';
export type {
  SpecPhase,
  DecisionForReadiness,
  DecisionStatusForReadiness,
  CommentTypeBreakdown,
  ReadinessInput,
  OutstandingItem,
  SpecReadiness,
} from './spec-readiness.js';
export { toolManifest } from './tool-manifest.js';
export type { ToolManifestEntry } from './tool-manifest.js';

// b-68 t-1: the scaffold model. The base scaffold DATA (records) will be
// added in t-2 as `scaffold-data.ts`; this export surface is the shape +
// projection contract everything else builds against.
export {
  toPromptBlocks,
  toPhaseGuidance,
  toToolDefinition,
  toNudge,
  toRubric,
  toInitPromptRef,
  toButtonPrompt,
} from './scaffold-model.js';
export type {
  Phase,
  Transition,
  ScaffoldNodeKind,
  ScaffoldNode,
  PhaseNode,
  PhaseAllowance,
  PromptBlockNode,
  PromptBlockSurface,
  PromptButtonNode,
  ToolNode,
  ToolAnnotations,
  TransitionRubric,
  GuidanceBlock,
  GuidanceSource,
  GuidanceEmphasis,
  GuidanceTarget,
  ScaffoldDataset,
  SystemBlock,
  ToolDefinition,
  InitPromptRefEntry,
  ToNudgeInput,
  ToRubricInput,
  ToButtonPromptInput,
} from './scaffold-model.js';

// b-68 t-2: the BASE scaffold dataset (typed records mirroring the existing
// `_base/*.md` + `phases/<phase>/*.md` content and the `phaseIntentLine` /
// `phaseAllowanceLine` in mcp/formatters.ts). t-6 and t-7 will swap the
// server's prompt + nudge composition over to projections of this dataset.
export {
  BASE_SCAFFOLD,
  SPEC_SHAPE_MISSING_LENS_WARNING,
  BUILD_AC_NAG_PROSE,
} from './scaffold-data.js';
// spec-111 t-9 — read-only agent block, injected by buildSystemBlocks when the
// per-request readOnly flag is set. Lives in the scaffold model (b-68 dec-6),
// not as a phases/*.md file.
export { BASE_READ_ONLY } from './scaffold-data.js';
// spec-126 dec-4 — reviewer-mode agent block, injected by buildSystemBlocks when
// the per-request resolved role is reviewer. Lives in the scaffold model (one
// home, std-15/std-16), not as a phases/*.md file.
export { BASE_REVIEW } from './scaffold-data.js';
// spec-150 dec-6: the clause-translator system prompt (std-15 — one home; shared by
// the server migration and spec-142's admin standards agent).
export { CLAUSE_TRANSLATOR_PROMPT } from './scaffold-data.js';
// spec-143 t-4 (dec-6) — drift-agent mode block, injected by buildSystemBlocks
// when the per-request driftMode flag is set (the React UI's Drift Inbox sets
// mode "drift"). Lives in the scaffold model (one home, std-15/std-16), not as a
// phases/*.md file. Portable per std-22.
export { DRIFT_AGENT_GUIDANCE } from './scaffold-data.js';
// spec-143 t-4 (dec-6): the drift agent's on-mount opening-turn seed (std-15 —
// one home). The Drift Inbox fires it once on mount.
export { DRIFT_OPENING_TURN_SEED } from './scaffold-data.js';
