import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_SCAFFOLD,
  BASE_READ_ONLY,
  BASE_REVIEW,
  DRIFT_AGENT_GUIDANCE,
  SCAFFOLD_AGENT_GUIDANCE,
  STANDARDS_AGENT_GUIDANCE,
  ISSUES_AGENT_GUIDANCE,
  SHARED_HANDOFF_GUIDANCE,
  toPromptBlocks,
  toPhaseGuidance,
  type SpecPhase,
} from "@memex/shared";
import type { SystemBlock } from "./types.js";
import type { IntegrationState } from "./integration-state.js";
import { loadSkill } from "./skills.js";

// ──────────────────────────────────────────────
// Prompt assembly: the React system prompt is now
// composed entirely from `BASE_SCAFFOLD` via the
// `toPromptBlocks(dataset, phase)` projection
// (b-68 t-6). Per b-68 dec-9 only `surface:
// 'react_only'` PromptBlockNodes ride the React
// surface — `shared_nudge` content (about-spec,
// mutation-protocol, code-grounding,
// standards-protocol, per-phase behavioural
// guidance) reaches the agent via the nudge /
// rubric channels, not as system-prompt blocks.
//
// The `creation` surface still loads its prompt
// from `phases/creation/system.md` + the
// `spec-document` skill — creation is out of
// scope for b-68 (see t-2 progress note).
//
// `draft` and `specify` share the `specify` projection
// (b-33: draftAgent removed; the two statuses
// are functionally identical for the agent).
// ──────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHASES_DIR = resolve(__dirname, "phases");

function read(relativePath: string): string {
  return readFileSync(resolve(PHASES_DIR, relativePath), "utf8");
}

// Creation prompt still loads from disk — out of scope for b-68.
const CREATION_SYSTEM = read("creation/system.md");

// spec-111 t-9: read-only agent prompt block. Per b-68 dec-6 the prose lives
// in the scaffold model (`BASE_READ_ONLY` in @memex/shared), NOT as a
// `phases/*.md` file — the drift guard (b-68 ac-20 (a)) forbids new prompt-
// prose markdown under phases/. Injected into the system prompt only when the
// per-request `readOnly` flag is set (signed-in non-member on a public Memex —
// spec-111 dec-2).
const READ_ONLY_BLOCK = BASE_READ_ONLY.text;
if (!READ_ONLY_BLOCK) {
  throw new Error(
    "BASE_READ_ONLY.text is empty — the read-only agent block cannot be assembled",
  );
}

// spec-126 dec-4 — reviewer-mode block. Like READ_ONLY_BLOCK the prose lives in
// the scaffold model (`BASE_REVIEW` in @memex/shared — std-15/std-16), never as
// a phases/*.md file. Appended by buildSystemBlocks only when the per-request
// resolved role is `reviewer` (dec-1, dec-2). It follows the phase blocks +
// phase guidance, so the assembled reviewer prompt is phase-composed (dec-5).
const REVIEW_BLOCK = BASE_REVIEW.text;
if (!REVIEW_BLOCK) {
  throw new Error(
    "BASE_REVIEW.text is empty — the reviewer agent block cannot be assembled",
  );
}

// spec-143 t-4 (dec-6) — drift-agent mode block. Like READ_ONLY_BLOCK and
// REVIEW_BLOCK the prose lives in the scaffold model (`DRIFT_AGENT_GUIDANCE` in
// @memex/shared — std-15/std-16), never inline here. Appended by
// buildSystemBlocks only when the per-request `driftMode` flag is set (the React
// UI's Drift Inbox sets mode 'drift'). It follows the phase blocks + phase
// guidance, so the drift posture is composed on top of the agent's general Memex
// orientation.
const DRIFT_BLOCK = DRIFT_AGENT_GUIDANCE.text;
if (!DRIFT_BLOCK) {
  throw new Error(
    "DRIFT_AGENT_GUIDANCE.text is empty — the drift agent block cannot be assembled",
  );
}

// spec-360 t-1 (dec-1/dec-6) — scaffold-agent mode block. Like DRIFT_BLOCK the
// prose lives in the scaffold model (`SCAFFOLD_AGENT_GUIDANCE` in @memex/shared —
// std-15/std-16), never inline here. Appended by buildSystemBlocks only when the
// per-request `scaffoldMode` flag is set (the React UI's Scaffold Inspect surface
// sets mode 'scaffold'). This is the BEHAVIOUR; the factual scaffold GROUNDING is
// composed per-request by `toScaffoldGrounding` and carried in the cached context
// block (dec-5/dec-10), assembled by the route's buildScaffoldContext.
const SCAFFOLD_BLOCK = SCAFFOLD_AGENT_GUIDANCE.text;
if (!SCAFFOLD_BLOCK) {
  throw new Error(
    "SCAFFOLD_AGENT_GUIDANCE.text is empty — the scaffold agent block cannot be assembled",
  );
}

// spec-389 t-5 (dec-2) — the standards / issues agent mode blocks, injected by
// buildSystemBlocks when the per-request mode is 'standards' / 'issues' (the
// React UI's Standards / Issues surfaces set it). Behaviour only; the factual
// grounding (the corpus / the parking lot) is composed per-request by
// buildStandardsContext / buildIssuesContext. spec-389 t-4 (dec-3) — the shared
// cross-agent handoff map is appended to each scoped agent so it hands off rather
// than overreach.
const STANDARDS_BLOCK = STANDARDS_AGENT_GUIDANCE.text;
const ISSUES_BLOCK = ISSUES_AGENT_GUIDANCE.text;
const HANDOFF_BLOCK = SHARED_HANDOFF_GUIDANCE.text;
if (!STANDARDS_BLOCK || !ISSUES_BLOCK || !HANDOFF_BLOCK) {
  throw new Error(
    "STANDARDS_/ISSUES_AGENT_GUIDANCE or SHARED_HANDOFF_GUIDANCE text is empty — the scoped agent blocks cannot be assembled",
  );
}

/**
 * Returns system prompt as structured blocks for the Anthropic API.
 *
 * Composition: `toPromptBlocks(BASE_SCAFFOLD, phase)` projects the React-only
 * PromptBlockNodes for the phase in declaration order, then a final
 * `## Document Context` block is appended carrying `cache_control: ephemeral`
 * (the cache breakpoint for prompt caching). `draft` is projected through the
 * `specify` PhaseNode — draft + specify share the React prompt set.
 *
 * Per b-68 dec-9 the React surface receives orientation-style content: role,
 * MDX components, UI tools, context-awareness + cross-phase invariants. The
 * cross-phase shared guidance (about-spec, mutation-protocol, code-grounding,
 * standards-protocol) is `shared_nudge` and still rides the nudge / rubric
 * channels only.
 *
 * spec-123 dec-8 (Move 2): the PER-PHASE behavioural guidance now ALSO ships on
 * the React surface — appended here via `toPhaseGuidance(BASE_SCAFFOLD, phase)`,
 * which projects the same base phase-targeted GuidanceBlocks the MCP agent
 * composes through `toNudge`. This closes the gap that left the in-app agent
 * phase-blind. Org additions are excluded (they ride the nudge channel only).
 *
 * spec-111 t-9: when `readOnly` is true (signed-in non-member chatting on a
 * public Memex — dec-2), the read-only prompt block (`BASE_READ_ONLY` in the
 * @memex/shared scaffold model — b-68 dec-6) is appended to the instruction
 * block so the agent explains it can answer/search but cannot mutate. Server-side
 * enforcement still lives in the MCP read/write gate (t-4); this is the
 * prompt-level counterpart. Org members (the default `readOnly = false`)
 * are unaffected.
 */
// spec-360: in scaffold mode the agent binds NO document — these base
// `react_only` blocks each assert a DOC-bound "document assistant" identity that
// directly conflicts with the scaffold assistant's job, and they lead the
// prompt, so a cold question gets answered as the doc agent. Dropped in scaffold
// mode (the scaffold identity leads instead); drift keeps them — it's the proven
// shipped shape and fronts its own identity via the on-mount opening seed.
const DOC_BOUND_REACT_BLOCK_IDS: ReadonlySet<string> = new Set([
  "role",
  "context-awareness",
  "create-from-doc",
]);

export function buildSystemBlocks(
  documentContext: string,
  phase: SpecPhase,
  readOnly = false,
  reviewer = false,
  driftMode = false,
  integrationState?: IntegrationState,
  scaffoldMode = false,
  // spec-389 t-5 (dec-2): the new scoped agent modes. Each appends its behaviour
  // block + the shared handoff map over the same phase-composed base, like the
  // drift overlay; their factual grounding rides the cached context block.
  scopedMode?: "standards" | "issues",
): SystemBlock[] {
  const projectedPhase: SpecPhase = phase === "draft" ? "specify" : phase;
  // spec-360: scaffold mode leads with its OWN identity — the doc-bound base
  // blocks are suppressed so the generic "document assistant" role can't
  // dominate, and SCAFFOLD_BLOCK is prepended (not just appended) below.
  const instructionBlocks = toPromptBlocks(
    BASE_SCAFFOLD,
    projectedPhase,
    scaffoldMode ? DOC_BOUND_REACT_BLOCK_IDS : undefined,
  );
  const remainingBase = instructionBlocks.map((b) => b.text).join("\n\n");
  const baseContent = scaffoldMode
    ? remainingBase
      ? `${SCAFFOLD_BLOCK}\n\n${remainingBase}`
      : SCAFFOLD_BLOCK
    : remainingBase;

  // spec-123 dec-8 (Move 2): the in-app/React agent receives the SAME per-phase
  // behavioural `shared_nudge` guidance the MCP agent gets — single-sourced from
  // the scaffold via `toPhaseGuidance` (the base phase-targeted GuidanceBlocks).
  // Before this, the React agent was phase-blind (toPromptBlocks ships only
  // `react_only` blocks), which forced bespoke opening-turn button prompts to
  // carry the "how". Now the phase guidance reaches both surfaces from one
  // source. Org overlays still ride the nudge channel only — they're excluded
  // here (b-68 ac-31), so this stays a pure projection of BASE_SCAFFOLD.
  // spec-360: scaffold mode skips the per-phase behavioural guidance — it's the
  // projected-`specify` decision-resolution "how" for the doc agent, irrelevant
  // to the scaffold explainer (whose facts ride the composed grounding context).
  const phaseGuidance = scaffoldMode ? "" : toPhaseGuidance(BASE_SCAFFOLD, projectedPhase);
  const withGuidance =
    phaseGuidance.length > 0 ? `${baseContent}\n\n${phaseGuidance}` : baseContent;

  // spec-126 dec-4/dec-5: append the reviewer block AFTER the phase blocks +
  // phase guidance, so the reviewer's posture is composed with the phase the
  // server already derived — the assembled prompt differs by phase for free.
  // Read-only (spec-111) is an independent overlay appended after it. Both are
  // conditional posture modifiers over the same phase-composed base.
  const withReview = reviewer ? `${withGuidance}\n\n${REVIEW_BLOCK}` : withGuidance;
  // spec-143 t-4 (dec-6): drift mode is an independent posture overlay over the
  // same phase-composed base — appended like the reviewer / read-only overlays.
  // It gives the agent its drift-specific job on top of the general Memex
  // orientation.
  const withDrift = driftMode ? `${withReview}\n\n${DRIFT_BLOCK}` : withReview;
  // spec-389 t-5 (dec-2): the standards / issues posture overlays — each appends
  // its behaviour block plus the shared cross-agent handoff map (spec-389 t-4) so
  // the agent stays in its lane and hands off (render_handoff) for anything else.
  const withScoped =
    scopedMode === "standards"
      ? `${withDrift}\n\n${STANDARDS_BLOCK}\n\n${HANDOFF_BLOCK}`
      : scopedMode === "issues"
      ? `${withDrift}\n\n${ISSUES_BLOCK}\n\n${HANDOFF_BLOCK}`
      : withDrift;
  // spec-360 t-1 (dec-1/dec-6): the scaffold identity now LEADS the instruction
  // block (prepended into baseContent above) instead of trailing it — appending
  // it after the doc-bound "document assistant" role let that role dominate a
  // cold turn. The doc-bound base blocks + phase guidance are suppressed in
  // scaffold mode, so the scaffold posture is the agent's primary identity. The
  // factual grounding rides the cached context block (buildScaffoldContext).
  const instructions: SystemBlock = {
    type: "text",
    text: readOnly ? `${withScoped}\n\n${READ_ONLY_BLOCK}` : withScoped,
  };

  const context: SystemBlock = {
    type: "text",
    text: `## Document Context\n${documentContext}`,
    cache_control: { type: "ephemeral" },
  };

  // spec-180 (dec-2): always inject the integration state block — both integrations
  // stated explicitly so the agent never infers availability from silence.
  // (dec-1): separate block with no cache_control so it resolves fresh per request
  // without busting the tool-definition cache carried by `context`.
  const slackLine = integrationState?.slackConnected
    ? "- Slack: connected — memex__send_slack_message is ready"
    : "- Slack: not connected (no token) — memex__send_slack_message will fail";

  let discordLine: string;
  if (integrationState?.discordAmbiguous) {
    discordLine =
      "- Discord: configured in multiple orgs — pass the `memex` parameter to target the right one";
  } else if (integrationState?.discordConnected) {
    const channel = integrationState.discordChannelName
      ? ` (#${integrationState.discordChannelName})`
      : "";
    discordLine = `- Discord: webhook configured${channel} — memex__send_discord_message is ready`;
  } else {
    discordLine = "- Discord: no webhook configured — memex__send_discord_message will fail";
  }

  const integration: SystemBlock = {
    type: "text",
    text: `## Active integrations\n${slackLine}\n${discordLine}`,
  };

  return [instructions, context, integration];
}

/**
 * Returns system prompt blocks for the document creation phase.
 *
 * Focused prompt with no document context — just shaping a new Spec from the
 * user's input (free-form description and/or pasted source material).
 *
 * The prescriptive guidance about what a Spec document IS and IS NOT lives in
 * the `spec-document` skill, loaded as its own block so it can be reused in
 * other prompts (e.g. evaluation, refactoring) without duplication. The two
 * blocks mirror the role + skill shape from before the phases/ refactor —
 * `creation/system.md` does NOT inline the skill.
 *
 * Creation is out of scope for b-68: it keeps reading from disk via the
 * existing `phases/creation/system.md` + skill-loader path.
 */
export function buildCreationSystemBlocks(): SystemBlock[] {
  const role: SystemBlock = {
    type: "text",
    text: CREATION_SYSTEM,
  };

  const skill: SystemBlock = {
    type: "text",
    text: loadSkill("spec-document"),
    cache_control: { type: "ephemeral" },
  };

  return [role, skill];
}
