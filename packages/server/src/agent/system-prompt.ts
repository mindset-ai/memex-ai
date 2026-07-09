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
  SKILLS_AGENT_GUIDANCE,
  SKILLS_AGENT_MODE_GUIDANCE,
  toPromptBlocks,
  toPhaseGuidance,
  type SpecPhase,
} from "@memex/shared";
import type { SystemBlock } from "./types.js";
import type { IntegrationState } from "./integration-state.js";
import type { VocabFacet } from "../services/facet-vocab.js";
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
// spec-300 t-15 (dec-23) — the dedicated SKILLS-agent mode block (distinct from the
// SKILLS_BLOCK awareness overlay below). Injected by buildSystemBlocks when the
// per-request mode is 'skills', like the standards / issues overlays, followed by
// the shared handoff map so the agent hands off anything outside skill authoring.
const SKILLS_MODE_BLOCK = SKILLS_AGENT_MODE_GUIDANCE.text;
if (!STANDARDS_BLOCK || !ISSUES_BLOCK || !HANDOFF_BLOCK || !SKILLS_MODE_BLOCK) {
  throw new Error(
    "STANDARDS_/ISSUES_/SKILLS_AGENT mode guidance or SHARED_HANDOFF_GUIDANCE text is empty — the scoped agent blocks cannot be assembled",
  );
}

// spec-300 t-7 (dec-7 / dec-20 / dec-2) — the skills-awareness block. Prose lives
// in the scaffold model (SKILLS_AGENT_GUIDANCE in @memex/shared — std-15/std-16),
// never inline here. Appended by buildSystemBlocks to EVERY in-app agent prompt so
// the agent knows how to discover skills (catalogue on the early list_docs
// response, ac-29), follow the ones it can satisfy, and hand off (render_handoff)
// the ones whose capability flags exceed it — never executing code (dec-2). The
// block is phrased conditionally, so it's inert when the Memex has no skills.
const SKILLS_BLOCK = SKILLS_AGENT_GUIDANCE.text;
if (!SKILLS_BLOCK) {
  throw new Error(
    "SKILLS_AGENT_GUIDANCE.text is empty — the skills-awareness block cannot be assembled",
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
  // spec-300 t-15 (dec-23): 'skills' is the fifth scoped mode — the dedicated
  // skills authoring / curation agent on the Skills page.
  scopedMode?: "standards" | "issues" | "skills",
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
  // spec-300 t-15 (dec-23): the skills posture overlays like standards / issues —
  // its authoring/curation behaviour block + the shared handoff map, so the skills
  // agent stays in its lane and hands off anything outside skill authoring.
  const withScoped =
    scopedMode === "standards"
      ? `${withDrift}\n\n${STANDARDS_BLOCK}\n\n${HANDOFF_BLOCK}`
      : scopedMode === "issues"
      ? `${withDrift}\n\n${ISSUES_BLOCK}\n\n${HANDOFF_BLOCK}`
      : scopedMode === "skills"
      ? `${withDrift}\n\n${SKILLS_MODE_BLOCK}\n\n${HANDOFF_BLOCK}`
      : withDrift;
  // spec-300 t-7 (dec-7 / dec-20 / dec-2): the PRIMARY in-app agent — the doc/spec
  // agent, no scoped mode — is the one that dispatches skills; append the
  // skills-awareness block for it. The scoped agents (drift / standards / issues)
  // and the scaffold assistant have narrow, non-skills jobs and already hand off
  // code, so they don't carry it. The block is inert when the Memex has no skills.
  const isPrimaryAgent = !scaffoldMode && !driftMode && !scopedMode;
  const withSkills = isPrimaryAgent
    ? `${withScoped}\n\n${SKILLS_BLOCK}`
    : withScoped;
  // spec-360 t-1 (dec-1/dec-6): the scaffold identity now LEADS the instruction
  // block (prepended into baseContent above) instead of trailing it — appending
  // it after the doc-bound "document assistant" role let that role dominate a
  // cold turn. The doc-bound base blocks + phase guidance are suppressed in
  // scaffold mode, so the scaffold posture is the agent's primary identity. The
  // factual grounding rides the cached context block (buildScaffoldContext).
  const instructions: SystemBlock = {
    type: "text",
    text: readOnly ? `${withSkills}\n\n${READ_ONLY_BLOCK}` : withSkills,
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
export function buildCreationSystemBlocks(vocab: VocabFacet[] = []): SystemBlock[] {
  const role: SystemBlock = {
    type: "text",
    text: CREATION_SYSTEM,
  };

  const skill: SystemBlock = {
    type: "text",
    text: loadSkill("spec-document"),
    cache_control: { type: "ephemeral" },
  };

  const blocks = [role, skill];

  // spec-473: when this Memex has a facet vocabulary, `create_decision` HARD-REQUIRES
  // a complete facet ballot (spec-423 dec-5, enforced in handlers/decisions.ts via
  // requireBallotForMemex) — an absent/incomplete ballot is rejected and the decision
  // is NOT created. The creation surface deliberately omits the `facets` tool to keep
  // step-4 authoring a single batched turn, so we inject the live vocabulary here and
  // instruct the agent to cast the ballot inline. Appended AFTER the cached prefix
  // (role + skill) since the vocabulary is per-Memex. Empty vocab → no block, unchanged.
  if (vocab.length > 0) {
    blocks.push({ type: "text", text: renderFacetBallotBlock(vocab) });
  }

  return blocks;
}

// Render the per-Memex facet-ballot instruction injected into the creation prompt.
// Mirrors the create_decision schema's `facetBallot` contract + the `facets` list
// verb's vocabulary readout, so the agent can cast a COMPLETE ballot without a
// separate round-trip.
function renderFacetBallotBlock(vocab: VocabFacet[]): string {
  const keys = vocab.map((f) => f.key);
  const lines = vocab.map((f) => `- \`${f.key}\` — ${f.description}`).join("\n");
  return [
    "## Facet ballot — REQUIRED on every create_decision (this Memex has a facet vocabulary)",
    "",
    "Each decision you create MUST carry a complete `facetBallot` naming which governance",
    "facets the decision touches. A create_decision with an absent, incomplete, or",
    "contradictory ballot is REJECTED and the decision is NOT created — so cast the ballot",
    "inline, in the SAME batched step-4 turn, on every `create_decision` block.",
    "",
    "Ballot shape (pass as the `facetBallot` argument):",
    "```json",
    '{ "verdict": { ' + keys.map((k) => `"${k}": <true|false>`).join(", ") + ' }, "none": false }',
    "```",
    "",
    "Rules:",
    "- `verdict` must include an explicit true/false for EVERY facet key below — no omissions.",
    "- Set a facet `true` only when the decision genuinely governs that concern; otherwise `false`.",
    "- For a decision that legitimately touches NO facet, set every verdict `false` AND `none: true`.",
    "- `none` must be `false` whenever any facet is `true` (never both).",
    "- These facets are a work-side routing hook (they surface the governing Standards), not",
    "  binding precedent (spec-423 dec-6) — classify the decision's own scope, honestly.",
    "",
    "Facet vocabulary for this Memex:",
    lines,
  ].join("\n");
}
