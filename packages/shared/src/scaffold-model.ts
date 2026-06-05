// b-68 t-1: the scaffold model.
//
// One model, many projections (b-68 D-6). All prompt-related content — the
// per-phase system prompt, the tool catalogue, the per-tool / per-phase
// nudges, the transition-gate rubrics, the Init Prompt tool reference — is
// constructed from records in this module. Both surfaces (the React/LangGraph
// agent and the MCP agent) consume the same projections, so what the agents
// receive can never drift from what the Inspect UI displays.
//
// House style (matches `spec-readiness.ts` and `tool-manifest.ts`): plain
// data, pure functions, no I/O, no globals. The base scaffold DATA lives in
// `scaffold-data.ts` (b-68 T-2). Org additions are loaded from
// `org_scaffold_additions` (b-68 T-3) and merged in at projection time.
//
// The model is a discriminated union keyed by `kind`. Structural typing
// replaces nominal classes because every node must serialize cleanly across
// the server↔React boundary — the same constraint that shaped
// `spec-readiness.ts` and b-67's `tool-manifest.ts`.

import type { ToolManifestEntry } from './tool-manifest.js';

// ──────────────────────────────────────────────────────────────────────────
// Phase + transition vocabulary. Mirrors `SpecPhase` in spec-readiness.ts.
// ──────────────────────────────────────────────────────────────────────────

export type Phase = 'draft' | 'plan' | 'build' | 'verify' | 'done';

/** Forward transitions only. Backward moves don't carry rubric prose. */
export type Transition = 'plan' | 'build' | 'verify' | 'done';

// ──────────────────────────────────────────────────────────────────────────
// Discriminator + common shape.
// ──────────────────────────────────────────────────────────────────────────

export type ScaffoldNodeKind =
  | 'phase'
  | 'prompt_block'
  | 'tool'
  | 'transition_rubric'
  | 'guidance_block'
  | 'prompt_button';

// Per b-68 D-5 every node carries two text dimensions: `text` (what the agent
// reads, when applicable) and `rationale` (what a human reads in Inspect).
// `rationale` is never sent to the agent — the projections below strip it,
// and the drift-guard test (b-68 T-16) enforces that no projection output
// includes rationale strings.
interface BaseNodeShape {
  kind: ScaffoldNodeKind;
  rationale: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Node variants.
// ──────────────────────────────────────────────────────────────────────────

/** One per phase. Owns the phase's intent, its allowance set (what tools are
 *  "Allowed now" / "Blocked now"), and the ordered ids of the React-only
 *  prompt blocks that compose its system prompt. Phase-targeted GuidanceBlocks
 *  ride the nudge channel; they're stored separately. */
export interface PhaseNode extends BaseNodeShape {
  kind: 'phase';
  phase: Phase;
  intent: string;
  allowance: PhaseAllowance;
  promptBlockIds: readonly string[];
}

export interface PhaseAllowance {
  /** Tool names the phase explicitly opens up (e.g. `create_task` in `build`). */
  allowed: readonly string[];
  /** Tool names the phase explicitly blocks (e.g. `create_task` in `plan`). */
  blocked: readonly string[];
}

/** A unit of prompt prose. `surface` decides whether this block ships in the
 *  React-only system prompt (`react_only`) or rides the shared nudge channel
 *  to both agents (`shared_nudge`). Per b-68 D-9 the React-only set is small
 *  (role/orientation, MDX components, render_* UI tools, UI context-awareness);
 *  everything behavioural is `shared_nudge`. */
export interface PromptBlockNode extends BaseNodeShape {
  kind: 'prompt_block';
  id: string;
  text: string;
  surface: PromptBlockSurface;
}

export type PromptBlockSurface = 'react_only' | 'shared_nudge';

/** A UI-triggered prompt button (spec-103 D-7). A surface passes `buttonId` +
 *  `context`; `toButtonPrompt` composes the base text + enabled Org appends,
 *  then interpolates `${context}` placeholders. The composed `text` may be
 *  DELIVERED two ways — delivery is the consumer's choice, not a property of the
 *  node (spec-123 t-8): either copied to a human's CLIPBOARD for a separate
 *  coding session (spec-103's verify-spec handoff), or seeded straight into the
 *  in-app agent as the user's message (spec-123's opening-turn triggers). `label`
 *  is template metadata (drives the visible button label, tooltip and aria-label)
 *  — never a per-surface prop. `rationale` (inherited from BaseNodeShape) is
 *  Inspect-only and never copied. */
export interface PromptButtonNode extends BaseNodeShape {
  kind: 'prompt_button';
  id: string;
  label: string;
  text: string;
  surfaces: readonly string[];
}

/** Tool node — extends b-67's `ToolManifestEntry` without forking it. Shared
 *  fields keep their original names and types; only `kind`, `rationale`, and
 *  optional `annotations` are added. */
export interface ToolNode extends ToolManifestEntry, BaseNodeShape {
  kind: 'tool';
  annotations?: ToolAnnotations;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** One per forward transition (→plan / →build / →verify / →done). Carries the
 *  rubric prose the agent walks at the gate. The deterministic fact sheet
 *  (open decisions, incomplete tasks, narrative freshness…) stays in code at
 *  `spec-readiness.ts`; only the rubric *prose* is scaffold content. */
export interface TransitionRubric extends BaseNodeShape {
  kind: 'transition_rubric';
  transition: Transition;
  text: string;
}

/** The unit of nudge / guidance. SAME shape for base content and Org additions
 *  — distinguished only by `source` (b-68 D-2). `target` picks where the block
 *  attaches; an absent dimension matches every value of that dimension. */
export interface GuidanceBlock extends BaseNodeShape {
  kind: 'guidance_block';
  source: GuidanceSource;
  target: GuidanceTarget;
  text: string;
  emphasis?: GuidanceEmphasis;
  enabled: boolean;
  order: number;
  // Org rows only — undefined on `source: 'base'` records.
  orgId?: string;
  authorId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type GuidanceSource = 'base' | 'org';

export type GuidanceEmphasis = 'do' | 'dont';

export interface GuidanceTarget {
  phase?: Phase;
  tool?: string;
  transition?: Transition;
  /** Append guidance to a specific Prompt Button (spec-103 D-7). */
  button?: string;
}

export type ScaffoldNode =
  | PhaseNode
  | PromptBlockNode
  | ToolNode
  | TransitionRubric
  | GuidanceBlock
  | PromptButtonNode;

// ──────────────────────────────────────────────────────────────────────────
// Dataset shape. The base scaffold content lives in scaffold-data.ts
// (b-68 T-2). Org additions arrive at projection time via the `orgBlocks`
// argument; they are fetched server-side from `org_scaffold_additions` and
// already filtered to `source: 'org'` + the authenticated principal's Org.
// ──────────────────────────────────────────────────────────────────────────

export interface ScaffoldDataset {
  phases: readonly PhaseNode[];
  promptBlocks: readonly PromptBlockNode[];
  tools: readonly ToolNode[];
  transitions: readonly TransitionRubric[];
  /** Base GuidanceBlocks — every entry has `source: 'base'`. */
  baseGuidance: readonly GuidanceBlock[];
  /** Base Prompt Buttons (spec-103 D-7) — UI-triggered clipboard prompts. */
  promptButtons: readonly PromptButtonNode[];
}

// ──────────────────────────────────────────────────────────────────────────
// Projection output shapes. Downstream consumers in `packages/server` and
// `packages/admin` import these directly.
// ──────────────────────────────────────────────────────────────────────────

/** Anthropic system-block shape (matches the existing
 *  `packages/server/src/agent/types.ts` SystemBlock). */
export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** Minimal tool registration shape consumed by both the MCP server and the
 *  React/LangGraph agent's tool list. The handler stays in code (it has
 *  closures over services); the model only carries metadata. */
export interface ToolDefinition {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
}

/** Init Prompt tool reference shape — what the React UI's
 *  `specInitPrompt.ts` renders into `MEMEX_MCP_TOOLS_REFERENCE`. Matches
 *  b-67's `ToolManifestEntry` because that's exactly the contract callers
 *  rely on. */
export type InitPromptRefEntry = ToolManifestEntry;

// ──────────────────────────────────────────────────────────────────────────
// Projection function inputs.
// ──────────────────────────────────────────────────────────────────────────

export interface ToNudgeInput {
  dataset: ScaffoldDataset;
  /** The tool emitting the nudge. Undefined when no tool context (e.g. an
   *  orient response that isn't tool-scoped) — only `target.tool === undefined`
   *  base blocks contribute. */
  tool?: string;
  /** The Spec phase at call time. Undefined for tools that resolve no Spec
   *  (e.g. `list_memexes`) — falls through to phase-agnostic content per
   *  b-68 D-7. */
  phase?: Phase;
  /** Org additions already filtered to `source: 'org'` + the principal's Org. */
  orgBlocks?: readonly GuidanceBlock[];
}

export interface ToRubricInput {
  dataset: ScaffoldDataset;
  transition: Transition;
  orgBlocks?: readonly GuidanceBlock[];
}

export interface ToButtonPromptInput {
  dataset: ScaffoldDataset;
  buttonId: string;
  context: Record<string, unknown>;
  /** Org additions already filtered to `source: 'org'` + the principal's Org. */
  orgBlocks?: readonly GuidanceBlock[];
}

// ──────────────────────────────────────────────────────────────────────────
// Projections — pure functions, base-first composition, no precedence hedge.
//
// Per b-68 D-3 the composed output has NO "base wins" / "never overrides the
// above" preamble. The projection guarantees order (base before Org) but the
// rendered text reads as one coherent set of guidance, not a layered one.
// ──────────────────────────────────────────────────────────────────────────

/** Returns the React-only system-prompt blocks for a phase, in the order the
 *  PhaseNode declares them. Filters out `shared_nudge` blocks — those ride
 *  the nudge channel via `toNudge`. */
export function toPromptBlocks(
  dataset: ScaffoldDataset,
  phase: Phase,
): SystemBlock[] {
  const phaseNode = dataset.phases.find((p) => p.phase === phase);
  if (!phaseNode) return [];
  const byId = new Map(dataset.promptBlocks.map((b) => [b.id, b]));
  const blocks: SystemBlock[] = [];
  for (const id of phaseNode.promptBlockIds) {
    const block = byId.get(id);
    if (!block) continue;
    if (block.surface !== 'react_only') continue;
    blocks.push({ type: 'text', text: block.text });
  }
  return blocks;
}

/** Returns the per-phase behavioural guidance for the in-app / React agent
 *  system prompt (spec-123 dec-8, Move 2).
 *
 *  Before spec-123 the React agent was phase-BLIND: `toPromptBlocks` ships only
 *  `react_only` blocks, so the per-phase `shared_nudge` behavioural prose (how
 *  to resolve decisions, run a build handoff, verify) reached the MCP agent via
 *  the `toNudge` channel but never the React agent — which forced bespoke
 *  opening-turn button prompts to carry the "how". dec-8 closes that gap by
 *  feeding the React agent the SAME scaffold nodes.
 *
 *  Single-source: this projects the BASE phase-targeted `GuidanceBlock`s — the
 *  exact records the MCP agent's `toNudge({ phase })` composes (PHASE_*_INTENT /
 *  DISCIPLINE / DOC_MANIPULATION / SEARCH …) — for `phase`, base-first by
 *  `order`. It deliberately matches ONLY `target.phase === phase` blocks: the
 *  cross-phase global blocks (`target: {}` — about-spec, mutation-protocol, …)
 *  and Org additions (`source: 'org'`) are NOT included, so the React system
 *  prompt keeps its narrow shape and Org overlays never bleed into it (b-68
 *  ac-31's org-isolation guarantee is preserved). Returns "" when the phase has
 *  no behavioural blocks. */
export function toPhaseGuidance(dataset: ScaffoldDataset, phase: Phase): string {
  const blocks = filterAndSort(
    dataset.baseGuidance,
    (b) =>
      b.source === 'base' &&
      b.target.phase === phase &&
      b.target.tool === undefined &&
      b.target.transition === undefined &&
      b.target.button === undefined,
  );
  return blocks.map((b) => b.text).join('\n\n');
}

/** Returns the minimal tool-registration shape for a ToolNode. Strips
 *  `rationale` — never sent to the agent. */
export function toToolDefinition(tool: ToolNode): ToolDefinition {
  return {
    name: tool.name,
    description: tool.summary,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

/** Returns the (tool × phase) nudge text the agent receives appended to a
 *  tool response. Composes base + enabled Org blocks whose `target` matches
 *  the (tool, phase) context. Base first, Org second, each set ordered by
 *  `order`. `target.transition !== undefined` blocks are excluded — those
 *  ride `toRubric`. */
export function toNudge(input: ToNudgeInput): string {
  const { dataset, tool, phase, orgBlocks } = input;
  const matches = (block: GuidanceBlock): boolean => matchesNudgeTarget(block.target, { tool, phase });

  const base = filterAndSort(dataset.baseGuidance, (b) => b.source === 'base' && matches(b));
  const org = filterAndSort(orgBlocks ?? [], (b) => b.source === 'org' && b.enabled && matches(b));

  return [...base, ...org].map((b) => b.text).join('\n\n');
}

/** Returns the composed gate rubric the agent walks at a forward transition.
 *  Base rubric prose first, then enabled Org `{transition}` blocks, ordered
 *  by `order`. Tool-targeted or phase-targeted blocks are excluded — they
 *  belong on the nudge channel, not the gate. */
export function toRubric(input: ToRubricInput): string {
  const { dataset, transition, orgBlocks } = input;
  const baseRubric = dataset.transitions.find((t) => t.transition === transition);

  const orgChecks = filterAndSort(
    orgBlocks ?? [],
    (b) =>
      b.source === 'org' &&
      b.enabled &&
      b.target.transition === transition &&
      b.target.phase === undefined &&
      b.target.tool === undefined,
  );

  const parts: string[] = [];
  if (baseRubric) parts.push(baseRubric.text);
  for (const o of orgChecks) parts.push(o.text);
  return parts.join('\n\n');
}

/** Returns the composed clipboard prompt for a Prompt Button (spec-103 D-7),
 *  or `null` when no base `PromptButtonNode` matches `buttonId`. Returning null
 *  (rather than throwing) keeps this projection pure and total; the React
 *  component applies the env-aware dev-throw / prod-null policy (spec-103 D-4).
 *
 *  Composition mirrors `toNudge`: base `text` first, then enabled Org blocks
 *  whose `target` is button-only (`button === buttonId`, other dimensions
 *  absent), ordered by `order`, joined base-first with no precedence preamble
 *  (spec-68 D-3). Interpolation runs AFTER composition, so Org appends may use
 *  the same `${...}` placeholders. Unresolved placeholders are left intact
 *  (`${key}`) for the caller to detect — never throws here. `rationale` is
 *  Inspect-only and never included. */
export function toButtonPrompt(input: ToButtonPromptInput): string | null {
  const { dataset, buttonId, context, orgBlocks } = input;
  const button = dataset.promptButtons.find((b) => b.id === buttonId);
  if (!button) return null;

  const orgAppends = filterAndSort(
    orgBlocks ?? [],
    (b) =>
      b.source === 'org' &&
      b.enabled &&
      b.target.button === buttonId &&
      b.target.phase === undefined &&
      b.target.tool === undefined &&
      b.target.transition === undefined,
  );

  const composed = [button.text, ...orgAppends.map((b) => b.text)].join('\n\n');
  return interpolateContext(composed, context);
}

/** Returns the Init Prompt tool reference entry. Same shape as b-67's
 *  `ToolManifestEntry` — the Init Prompt rendering doesn't change its
 *  contract; the source migrates from a hand-maintained array to the
 *  unified model. */
export function toInitPromptRef(tool: ToolNode): InitPromptRefEntry {
  return {
    name: tool.name,
    summary: tool.summary,
    args: tool.args,
    group: tool.group,
    readOnlyHint: tool.readOnlyHint,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Internal helpers.
// ──────────────────────────────────────────────────────────────────────────

/**
 * A nudge target matches a (tool, phase) context when every dimension present
 * on the target equals the context's value for that dimension. Absent target
 * dimensions match every value (b-68 D-1).
 *
 * `target.transition` is a non-fit on the nudge channel — those blocks belong
 * on the gate rubric and are filtered out here. `target.button` blocks
 * likewise ride `toButtonPrompt` (clipboard), not the agent nudge channel, so
 * they are excluded too (spec-103 D-7) — otherwise a button-only block (phase
 * and tool absent) would match every nudge.
 */
function matchesNudgeTarget(
  target: GuidanceTarget,
  context: { tool?: string; phase?: Phase },
): boolean {
  if (target.transition !== undefined) return false;
  if (target.button !== undefined) return false;
  if (target.phase !== undefined && target.phase !== context.phase) return false;
  if (target.tool !== undefined && target.tool !== context.tool) return false;
  return true;
}

/**
 * Replaces `{key}` (or `${key}`) placeholders in a button template with values
 * from `context`. Both brace styles are accepted so prompt authors can write
 * either. Unknown keys are left intact (the original `{key}` / `${key}` token)
 * so the caller can detect incomplete context (spec-103 runbook) — interpolation
 * never throws. Only `{word}` runs of word-characters match, so JS-object
 * snippets like `{ ref: '...' }` (with spaces) are left untouched.
 */
function interpolateContext(
  template: string,
  context: Record<string, unknown>,
): string {
  return template.replace(/\$?\{(\w+)\}/g, (match, key: string) => {
    if (!(key in context)) return match;
    const value = context[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function filterAndSort(
  blocks: readonly GuidanceBlock[],
  predicate: (b: GuidanceBlock) => boolean,
): GuidanceBlock[] {
  return blocks
    .filter(predicate)
    .slice()
    .sort((a, b) => a.order - b.order);
}
