export {
  computeSpecReadiness,
  blockerLines,
  countStaleDecisions,
  countUnresolvedDecisions,
  isSpecNarrativeStale,
  isForwardTransition,
  isBackwardTransition,
  shouldBlockForwardTransition,
  // spec-189: the traffic-driven phase-advancement matrix (the single place
  // the gated transition rules live — ac-3).
  nextPhaseForTraffic,
  // spec-355 dry-1/dry-2: the canonical ordered phase array — single source of
  // `['draft','specify','build','verify','done']` for server + UI.
  PHASE_ORDER,
} from './spec-readiness.js';
export type {
  SpecPhase,
  DecisionForReadiness,
  DecisionStatusForReadiness,
  CommentTypeBreakdown,
  ReadinessInput,
  OutstandingItem,
  SpecReadiness,
  TrafficClass,
} from './spec-readiness.js';
export { toolManifest } from './tool-manifest.js';
export type { ToolManifestEntry } from './tool-manifest.js';

// spec-201 dec-3: the per-language AC-emitter adapter catalogue (single source
// for the Integrations install matrix).
export { acEmitterManifest, AC_EMITTER_STATUSES } from './ac-emitter-manifest.js';
export type { AcEmitterEntry, AcEmitterStatus } from './ac-emitter-manifest.js';

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
  toHandoffEssence,
  HANDOFF_BUTTON_BY_PHASE,
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
  GET_PROMPT_PROSE,
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
export { WHATS_NEW_SYSTEM_PROMPT } from './scaffold-data.js';
// spec-143 t-4 (dec-6) — drift-agent mode block, injected by buildSystemBlocks
// when the per-request driftMode flag is set (the React UI's Drift Inbox sets
// mode "drift"). Lives in the scaffold model (one home, std-15/std-16), not as a
// phases/*.md file. Portable per std-22.
export { DRIFT_AGENT_GUIDANCE } from './scaffold-data.js';
// spec-360 t-1 (dec-1/dec-6) — scaffold-agent mode block + opening-turn seed,
// injected by buildSystemBlocks when the per-request scaffoldMode flag is set
// (the React UI's Scaffold Inspect surface sets mode "scaffold"). Lives in the
// scaffold model (one home, std-15/std-16). Portable per std-22.
export { SCAFFOLD_AGENT_GUIDANCE, SCAFFOLD_OPENING_TURN_SEED, scaffoldReviewEditSeed } from './scaffold-data.js';
// spec-389 t-4 (dec-3): the shared cross-agent handoff contract (canonical map),
// injected into every scoped in-app agent so it hands off rather than overreach.
export { SHARED_HANDOFF_GUIDANCE } from './scaffold-data.js';
// spec-300 t-7 (dec-7 / dec-20 / dec-2): the in-app agent skills-awareness block
// (injected by buildSystemBlocks) + the agent-assisted SKILL.md authoring system
// prompt (dec-9). Prose has one home here (std-15).
export { SKILLS_AGENT_GUIDANCE, SKILL_AUTHOR_INSTRUCTION } from './scaffold-data.js';
// spec-300 t-15 (dec-23, std-38): the dedicated skills-agent MODE block, injected
// by buildSystemBlocks when the per-request mode is 'skills' (the Skills surface
// sets it). Distinct from SKILLS_AGENT_GUIDANCE (the cross-agent awareness block).
export { SKILLS_AGENT_MODE_GUIDANCE } from './scaffold-data.js';
// spec-389 t-5 (dec-2): the standards + issues agent mode blocks, injected by
// buildSystemBlocks when the per-request mode is standards / issues. (Per dec-1
// the scoped agents open with a static intro, not an LLM turn — no opening seed.)
export {
  STANDARDS_AGENT_GUIDANCE,
  ISSUES_AGENT_GUIDANCE,
} from './scaffold-data.js';
// spec-360 t-2/t-3 (dec-5/dec-9/dec-10) — the scaffold assistant's grounding
// composer and its propose-time change validator. Pure + shared so the server
// (authoritative) and the React UI (instant feedback) agree on what the
// scaffold means and what changes are coherent.
export {
  toScaffoldGrounding,
  validateScaffoldChange,
  describeScaffoldTarget,
  encodeScaffoldProposal,
  parseScaffoldProposal,
  SCAFFOLD_PROPOSAL_MARKER,
} from './scaffold-grounding.js';
export type {
  ProposalValidation,
  ScaffoldProposal,
  ScaffoldOperation,
} from './scaffold-grounding.js';

// spec-190 t-4 (dec-3): the screen-element registry — canonical screen keys,
// route→screenKey mapping, and per-screen highlightable elements. Imported by the
// guide graph (screenKey in state), the highlight/navigate tools (t-5), and the
// server's guide-content import-time validation (t-7).
export {
  resolveScreenKey,
  GUIDE_SCREENS,
  GUIDE_SCREEN_KEYS,
  REGISTERED_SCREEN_KEYS,
  isKnownScreenKey,
  guideElementsForScreen,
  isKnownGuideElement,
  allGuideElementIds,
} from './guide-registry.js';
export type { GuideScreenKey, GuideElement, GuideScreen } from './guide-registry.js';

// spec-190 t-5 (dec-4): the guide's canonical toolset (one source) + navigation
// helpers. The load-bearing boundary lives here — NO product-data tools.
export {
  GUIDE_TOOLS,
  GUIDE_TOOL_NAMES,
  isNavigableScreen,
  screenKeyToPath,
} from './guide-tools.js';
export type { GuideToolDefinition } from './guide-tools.js';

// spec-244 (dec-5): the usage-event registry — the typed allowlist both the
// client (track()) and the server (POST /telemetry + the dec-8 back-end
// whitelist) import. The machine half of the event contract; the public event
// Standard is the human half, kept in sync by a CI parity check (t-7).
export {
  USAGE_EVENT_REGISTRY,
  isRegisteredEvent,
  getUsageEventDef,
  isFrontendEvent,
  BACKEND_EVENT_NAMES,
  sanitizeUsageProps,
} from './usage-events-registry.js';
export type { UsageEventDef, UsageEventSource, RegisteredEventName } from './usage-events-registry.js';

// spec-260: the QA-report section-type vocabulary (qa_report / qa_report-N) —
// one grammar shared by the server write/read paths and the UI render seats.
export {
  QA_REPORT_SECTION_PREFIX,
  isQaReportSectionType,
  qaReportVersion,
} from './qa-report.js';

// spec-259 dec-5: the one canonical relative-age helper (server MCP/agent surfaces
// + UI), injectable `now` for deterministic output. Wire forms keep absolute ISO.
export { timeAgo } from './relative-time.js';
// spec-380 dec-1: the one canonical docType → ref-path-segment mapping (std-10 §2),
// imported by the UI init-prompt renderers; was byte-identical per call site.
export { docTypePath } from './doc-type-path.js';
// spec-259 dec-4: conservative display-name capitalization, render-layer only.
export { capitalizeDisplayName } from './display-name.js';
