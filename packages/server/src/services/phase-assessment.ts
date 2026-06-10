import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, decisions, tasks, docComments, docSections, issues } from "../db/schema.js";
import type { Decision, Task, DocSection } from "../db/schema.js";
import {
  listResolvedDecisionImplAcCoverage,
  listAcsForBriefWithVerification,
  STALE_THRESHOLD_DAYS,
} from "./acs.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { getReadyTasks } from "./tasks.js";
import { parsePhaseDescriptions } from "../mcp/phase-descriptions.js";
import { listOrgScaffoldAdditionsCached } from "./scaffold-additions-cache.js";
import { filterOrgBlocksForMemex } from "./scaffold-additions.js";
import { orgIdForMemex } from "./shared/memex-ownership.js";
import {
  BASE_SCAFFOLD,
  SPEC_SHAPE_MISSING_LENS_WARNING,
  blockerLines,
  computeSpecReadiness,
  isForwardTransition,
  toRubric,
  type SpecPhase,
  type SpecReadiness,
  type GuidanceBlock,
  type Transition,
} from "@memex/shared";

// Doc-12 t-3 — deterministic readiness assessment for a Spec phase transition.
//
// The agent calls assess_phase_transition before driving update_doc_status forward
// on a Spec. The server returns a fact sheet (no LLM) and the rubric markdown
// for the target phase; the agent walks the rubric against the facts and tells
// the human whether to proceed.

export type PhaseTarget = "specify" | "build" | "verify" | "done";

const PHASE_TARGETS: readonly PhaseTarget[] = ["specify", "build", "verify", "done"] as const;

export function isPhaseTarget(value: unknown): value is PhaseTarget {
  return typeof value === "string" && (PHASE_TARGETS as readonly string[]).includes(value);
}

/**
 * Agent's self-classification of code-grounding for the Spec's resolved
 * decisions, applicable only to the specify→build transition (doc-27).
 *
 * - `not_applicable`: Spec's scope is not code-touching.
 * - `verified`: Resolved decisions have been verified against current source.
 * - `not_verified`: Either code-touching but not verified, or unsure.
 */
export type CodeGrounding = "not_applicable" | "verified" | "not_verified";

const CODE_GROUNDING_VALUES: readonly CodeGrounding[] = [
  "not_applicable",
  "verified",
  "not_verified",
] as const;

export function isCodeGrounding(value: unknown): value is CodeGrounding {
  return typeof value === "string" && (CODE_GROUNDING_VALUES as readonly string[]).includes(value);
}

// Loaded once at module init — mirrors the path-resolution pattern in
// `mcp/formatters.ts` and `agent/system-prompt.ts`.
const __phaseAssessmentDirname = dirname(fileURLToPath(import.meta.url));
const PHASES_DIR = resolve(__phaseAssessmentDirname, "..", "agent", "phases");

// b-33 follow-up: cross-phase code-grounding prompts (doc-27) live in
// `phases/_base/code-grounding.md`. One file, four sections, parsed via the
// shared `parsePhaseDescriptions` helper (`## key` headers). Exported symbol
// names `CODE_GROUNDING_PROMPT` / `CODE_GROUNDING_NUDGE` are preserved so
// downstream importers and tests keep working.
const CODE_GROUNDING_SECTIONS = parsePhaseDescriptions(
  readFileSync(resolve(PHASES_DIR, "_base", "code-grounding.md"), "utf8"),
);

/**
 * Verbatim prompt the agent reads on its first `assess_brief({target:'build'})`
 * call. Surfaced under a `## Code grounding` section in `formatPhaseAssessment`
 * when `codeGrounding` is undefined. The agent calls assess_brief a second
 * time with one of the three classifications.
 */
export const CODE_GROUNDING_PROMPT = CODE_GROUNDING_SECTIONS["prompt"];

const CODE_GROUNDING_NUDGE: Record<CodeGrounding, string> = {
  not_applicable: CODE_GROUNDING_SECTIONS["nudge:not_applicable"],
  verified: CODE_GROUNDING_SECTIONS["nudge:verified"],
  not_verified: CODE_GROUNDING_SECTIONS["nudge:not_verified"],
};

// spec-106 t-4 — specify→build missing-core-lens soft nudge (dec-1).
//
// The warning PROSE lives in `@memex/shared`'s `scaffold-data.ts`
// (`SPEC_SHAPE_MISSING_LENS_WARNING`) — the single owner of scaffold prompt
// prose per b-68 dec-6. The legacy `phases/<src>/transitions.md` home is
// retired and the drift-guard (ac-20a) rejects new `.md` under `phases/`. The
// detection LOGIC (below) stays in code; the `{lens}` placeholder is
// substituted with the human-readable name(s) of the missing lens.

/**
 * The CORE lenses std-18 says every Spec should carry. Overview is assumed
 * present (every Spec is created with one) and Operations is *adaptive* (added
 * only when the work earns it) — so neither is detected here. We check only the
 * two core lenses that under-shaped Specs routinely skip.
 *
 * Section types are free-text (dec-2), so detection is a SOFT, heuristic match:
 * case-insensitive substring against a label set drawn from (a) the canonical
 * section types a spec-shaped doc is born with (`approach`,
 * `implementation-surface`), and (b) the human-readable lens names and their
 * obvious synonyms. A hit on EITHER the section `type` or its `title` counts —
 * authors label sections however they like.
 */
const CORE_LENSES: readonly { name: string; matchers: readonly string[] }[] = [
  {
    name: "Design & UX",
    // Canonical type: `approach`. Synonyms cover the human labels and the
    // UI/UX surface words.
    matchers: ["design", "ux", "user experience", "approach"],
  },
  {
    name: "Architecture & Security",
    // Canonical type: `implementation-surface`. Synonyms cover the human
    // labels and the architecture/security surface words.
    matchers: ["architecture", "security", "implementation surface", "implementation-surface"],
  },
] as const;

/**
 * Heuristically detect which CORE lenses have no matching section. A lens is
 * "present" when any section's type or title (lower-cased) contains one of the
 * lens's matcher substrings. Returns the human-readable names of the lenses
 * with no matching section, in CORE_LENSES order. SOFT signal only — drives a
 * proceed-with-caveats warning (dec-1), never a hold.
 */
export function detectMissingCoreLenses(
  sections: readonly { sectionType: string; title: string | null }[],
): string[] {
  const haystacks = sections.map(
    (s) => `${s.sectionType} ${s.title ?? ""}`.toLowerCase(),
  );
  return CORE_LENSES.filter(
    (lens) => !haystacks.some((h) => lens.matchers.some((m) => h.includes(m))),
  ).map((lens) => lens.name);
}

// b-68 t-7: the legacy `RUBRIC_BY_TARGET` (which read
// `phases/<src>/transitions.md` at module init) is retired. The full transition
// rubric prose now lives as `TransitionRubric` records on
// `BASE_SCAFFOLD.transitions`, composed alongside any Org `{transition}`-targeted
// additions by `toRubric` and surfaced through the `rubricProse` field below.
// Per dec-8 of doc-12, draft→specify still carries no rubric; that's encoded as
// the absence of a `specify` `TransitionRubric` in BASE_SCAFFOLD (the projection
// emits an empty string when no base rubric is found).

// Recent-call cache for t-7's "no recent readiness review" nudge. Keyed by
// `${briefId}:${targetPhase}` → epoch-ms timestamp of the last assessment call.
//
// Module-level Map: this is process-local — fine for a single Cloud Run instance,
// and the soft-nudge degrades gracefully across instances (worst case: a nudge
// fires that didn't need to). If we ever need cross-instance recency we can swap
// for Redis or a DB column on documents.
const recentAssessments = new Map<string, number>();

function recencyKey(briefId: string, targetPhase: PhaseTarget): string {
  return `${briefId}:${targetPhase}`;
}

/** Returns true if assess_phase_transition was called for this (briefId, targetPhase) within the window. */
export function wasRecentlyAssessed(
  briefId: string,
  targetPhase: PhaseTarget,
  withinMs: number = 5 * 60 * 1000,
): boolean {
  const ts = recentAssessments.get(recencyKey(briefId, targetPhase));
  if (ts === undefined) return false;
  return Date.now() - ts < withinMs;
}

// Test-only escape hatch — clears the recency cache. Service tests need this
// so cross-test state doesn't leak; production never calls it.
export function _clearRecentAssessments(): void {
  recentAssessments.clear();
}

export interface DecisionFact {
  handle: string;
  title: string;
}

export interface ConsequenceCoverageFact {
  decisionHandle: string;
  decisionTitle: string;
  /** True when at least one section either references the decision (`dec-N`) or was updated after the decision was resolved. Best-effort. */
  hasConsequenceSection: boolean;
}

/**
 * Per-resolved-decision: does the decision have ≥1 child implementation AC
 * via `ac_parent_links` (parent_kind='decision', parent_id=this decision)?
 * Counts only implementation ACs whose own status is `active` — proposed /
 * rejected / superseded ACs don't satisfy the rule.
 *
 * Surfaced as a fact on the build-readiness rubric and as a `hold`-flavoured
 * nudge when any resolved decisions lack implementation ACs. A resolved
 * decision without an AC is a commitment without a verification path; see
 * `get_information(topic='decisions-need-acs')`.
 */
export interface DecisionAcCoverageFact {
  decisionHandle: string;
  decisionTitle: string;
  /** Count of `active` implementation ACs linked to this decision via `ac_parent_links`. */
  implementationAcCount: number;
}

/**
 * spec-120 ac-1 — AC verification roll-up for the fact sheet. Drawn from the
 * SAME `test_events` derivation `list_acs` uses (`listAcsForBriefWithVerification`
 * → `deriveVerificationState`), so the deterministic gate and `list_acs` can
 * never silently disagree. Counts cover only `active` ACs (matching the
 * `list_acs` default), and the `failing` / `stale` handles are surfaced inline
 * so the done-rubric hold signal can name them without a second tool call.
 */
export interface AcVerificationFact {
  /** Active ACs on this Spec (matches `list_acs` default scope). */
  totalActive: number;
  /** Active ACs with ≥1 tagged test event (any status). */
  covered: number;
  verified: number;
  failing: number;
  stale: number;
  untested: number;
  /** Manually accepted (spec-188) with no failing evidence. */
  accepted: number;
  /** Handles (`ac-N`) of every `failing` AC — the hold signals. */
  failingHandles: string[];
  /** Handles (`ac-N`) of every `stale` AC — also a hold signal at `done`. */
  staleHandles: string[];
}

export interface PhaseAssessment {
  briefId: string;
  specHandle: string;
  specTitle: string;
  currentPhase: string;
  targetPhase: PhaseTarget;
  /** Human-readable transition descriptor, e.g. "build → verify". */
  transition: string;
  /** When the transition has no rubric (draft→specify per dec-8), a friendly
   *  note explaining why. */
  rubricNote: string | null;
  /**
   * b-68 t-5 / t-7: the composed rubric prose for this forward transition —
   * `toRubric({dataset:BASE_SCAFFOLD, transition:target, orgBlocks})` output.
   * Base scaffold rubric first, then any Org `{transition}`-targeted enabled
   * blocks in `order`. Empty string when no base rubric exists (e.g. an
   * unsupported transition) and no Org blocks apply. Rendered as the
   * `## Rubric prose` section AFTER the deterministic fact sheet. b-68 t-7
   * retired the legacy `phases/<src>/transitions.md` files and the
   * `rubric: string | null` field that surfaced them — this composed prose
   * is now the single rubric source.
   */
  rubricProse: string;
  facts: {
    openDecisionsCount: number;
    openDecisions: DecisionFact[];
    incompleteTasksCount: number;
    readyTasksCount: number;
    blockedTasksCount: number;
    incompleteTasks: { handle: string; title: string; status: string; blocked: boolean }[];
    unresolvedDriftCount: number;
    unresolvedPlanRevisionCount: number;
    /**
     * spec-120 ac-3: total open (unresolved) comments whose target lives on
     * this Spec, plus the same figure broken down by `commentType`. The
     * breakdown lets a verifier distinguish hold-signals (review / question /
     * drift / plan_revision) from benign provenance notes (progress / plan)
     * inline, without a separate `list_comments` call. `openCommentsCount` is
     * the sum of `openCommentsByType` values.
     */
    openCommentsCount: number;
    openCommentsByType: Record<string, number>;
    /**
     * spec-120 ac-1: AC verification roll-up, derived from the same
     * `test_events` path `list_acs` uses so the gate and `list_acs` speak with
     * one voice. See `AcVerificationFact`.
     */
    acVerification: AcVerificationFact;
    /**
     * spec-112 t-8: count of Issues still in flight on this Spec (`open` +
     * `converted`). Drives the SOFT verify→done warning (ac-17). 0 when the Spec
     * has no open/converted Issues — every Issue resolved / wont_fix.
     */
    openIssuesCount: number;
    sections: { sectionType: string; title: string | null; updatedAt: Date }[];
    /** Per-resolved-decision: best-effort check that the narrative was updated since resolution. */
    resolvedDecisionCoverage: ConsequenceCoverageFact[];
    /** Per-resolved-decision: count of `active` child implementation ACs.
     *  Drives the "every resolved decision must have ≥1 implementation AC"
     *  rule at the specify→build gate. See guidance topic `decisions-need-acs`. */
    resolvedDecisionAcCoverage: DecisionAcCoverageFact[];
  };
  /**
   * Cross-surface "outstanding work" view — same data the React UI uses to
   * gate the phase dropdown. Sourced from `@memex/shared/spec-readiness`
   * so MCP nudges and React UI dialogs speak with one voice.
   */
  readiness: SpecReadiness;
  nudges: string[];
  /**
   * Code-grounding self-classification provided by the agent for the
   * specify→build transition (doc-27). `undefined` means the agent has not yet
   * answered the prompt; `formatPhaseAssessment` renders the prompt in a
   * dedicated `## Code grounding` section in that case. Always `undefined`
   * for targets other than `build`.
   */
  codeGrounding?: CodeGrounding;
  /**
   * True when `target === 'build'` and the agent has not yet supplied a
   * `codeGrounding` value. `formatPhaseAssessment` uses this to render the
   * verbatim prompt under `## Code grounding`.
   */
  codeGroundingPromptPending?: boolean;
}

// spec-120 ac-3: open-comments on a Spec, both as a total AND broken down by
// `commentType`. Counts every unresolved comment whose target (section /
// decision / task) lives on this Spec. One query; the by-type map lets the
// fact sheet distinguish hold-signals from provenance notes inline.
async function breakdownOpenCommentsOnSpec(
  memexId: string,
  sectionIdSet: Set<string>,
  decisionIdSet: Set<string>,
  taskIdSet: Set<string>,
): Promise<{ total: number; byType: Record<string, number> }> {
  const open = await db.query.docComments.findMany({
    where: and(
      eq(docComments.memexId, memexId),
      isNull(docComments.resolvedAt),
    ),
  });
  const onSpec = open.filter(
    (c) =>
      (c.sectionId !== null && sectionIdSet.has(c.sectionId)) ||
      (c.decisionId !== null && decisionIdSet.has(c.decisionId)) ||
      (c.taskId !== null && taskIdSet.has(c.taskId)),
  );
  const byType: Record<string, number> = {};
  for (const c of onSpec) {
    byType[c.commentType] = (byType[c.commentType] ?? 0) + 1;
  }
  return { total: onSpec.length, byType };
}

// Open-comments count used by the shared readiness computation. Counts every
// unresolved comment whose target lives on the Spec, regardless of type — a
// thin wrapper over `breakdownOpenCommentsOnSpec` so the total and the by-type
// view derive from a single query path.
async function countOpenCommentsOnSpec(
  memexId: string,
  sectionIdSet: Set<string>,
  decisionIdSet: Set<string>,
  taskIdSet: Set<string>,
): Promise<number> {
  const { total } = await breakdownOpenCommentsOnSpec(
    memexId,
    sectionIdSet,
    decisionIdSet,
    taskIdSet,
  );
  return total;
}

// spec-120 ac-1: AC verification roll-up for a single Spec, computed through
// `listAcsForBriefWithVerification` — the EXACT path `list_acs` uses — so the
// gate's counts and `list_acs` derive from one `deriveVerificationState` call
// and can never silently disagree. Scoped to `active` ACs to match the
// `list_acs` default; failing / stale handles are collected for the hold signal.
async function summarizeAcVerification(
  memexId: string,
  briefId: string,
): Promise<AcVerificationFact> {
  const rows = (await listAcsForBriefWithVerification(memexId, briefId)).filter(
    (r) => r.ac.status === "active",
  );
  const fact: AcVerificationFact = {
    totalActive: rows.length,
    covered: 0,
    verified: 0,
    failing: 0,
    stale: 0,
    untested: 0,
    accepted: 0,
    failingHandles: [],
    staleHandles: [],
  };
  for (const r of rows) {
    if (r.tests.length > 0) fact.covered += 1;
    const handle = `ac-${r.ac.seq}`;
    switch (r.verificationState) {
      case "verified":
        fact.verified += 1;
        break;
      case "failing":
        fact.failing += 1;
        fact.failingHandles.push(handle);
        break;
      case "stale":
        fact.stale += 1;
        fact.staleHandles.push(handle);
        break;
      case "untested":
        fact.untested += 1;
        break;
      case "accepted":
        fact.accepted += 1;
        break;
    }
  }
  return fact;
}

// spec-112 t-8 — count the Issues that are still in flight on a Spec:
// `open` (the bug/todo isn't fixed) + `converted` (its satisfying Task hasn't
// proven green). `resolved` / `wont_fix` Issues are settled and don't count.
// Drives the SOFT verify→done warning (ac-17) on both the phase-assessment
// fact sheet and the shared readiness computation (ac-5). Tenancy-scoped by
// memexId + docId so a stranger's Issues never leak in (std-7).
async function countOpenIssuesOnSpec(memexId: string, docId: string): Promise<number> {
  const rows = await db
    .select({ status: issues.status })
    .from(issues)
    .where(and(eq(issues.memexId, memexId), eq(issues.docId, docId)));
  return rows.filter((r) => r.status === "open" || r.status === "converted").length;
}

/**
 * Cross-surface readiness helper — shapes the inputs `update_doc_status` /
 * `publish_brief` need from the shared module without duplicating the rule
 * itself. Returns the same `BriefReadiness` shape consumed by the React
 * UI's PhaseDropdown.
 */
export async function computeReadinessForSpec(
  memexId: string,
  briefId: string,
  currentPhase: SpecPhase,
): Promise<SpecReadiness> {
  const allDecisions: Decision[] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.docId, briefId), eq(decisions.memexId, memexId)));

  const allSections: DocSection[] = await db
    .select()
    .from(docSections)
    .where(eq(docSections.docId, briefId));
  const allTasks: Task[] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.docId, briefId), eq(tasks.memexId, memexId)));

  const sectionIdSet = new Set(allSections.map((s) => s.id));
  const decisionIdSet = new Set(allDecisions.map((d) => d.id));
  const taskIdSet = new Set(allTasks.map((t) => t.id));

  const openCommentCount = await countOpenCommentsOnSpec(
    memexId,
    sectionIdSet,
    decisionIdSet,
    taskIdSet,
  );

  const spec = await db.query.documents.findFirst({
    where: and(eq(documents.id, briefId), eq(documents.memexId, memexId)),
  });

  const openIssueCount = await countOpenIssuesOnSpec(memexId, briefId);

  return computeSpecReadiness({
    currentPhase,
    decisions: allDecisions.map((d) => ({
      id: d.id,
      createdAt: d.createdAt,
      resolvedAt: d.resolvedAt,
      status: d.status as 'open' | 'resolved' | 'candidate' | 'rejected',
    })),
    openCommentCount,
    narrativeLastConsolidatedAt: spec?.narrativeLastConsolidatedAt ?? null,
    openIssueCount,
  });
}

/**
 * Assess readiness to transition a Spec into `targetPhase`.
 *
 * Deterministic: NO LLM is called. The handler returns the rubric markdown
 * (loaded from `phases/{source}/transitions.md`) plus a fact sheet drawn
 * from the DB. The agent walks the rubric against the facts and produces the
 * verdict for the human.
 *
 * Side-effect: stamps the (briefId, targetPhase) recency cache so t-7's
 * status-change nudge knows the agent recently looked. (`briefId` here is the
 * wire-format Spec id preserved under the b-105 allowlist — see std-1.)
 */
export async function assessPhaseTransition(
  memexId: string,
  briefId: string,
  targetPhase: PhaseTarget,
  codeGrounding?: CodeGrounding,
): Promise<PhaseAssessment> {
  if (!isPhaseTarget(targetPhase)) {
    throw new ValidationError(
      `Invalid targetPhase '${targetPhase}'. Must be one of: ${PHASE_TARGETS.join(", ")}`,
    );
  }

  const spec = await db.query.documents.findFirst({
    where: and(eq(documents.id, briefId), eq(documents.memexId, memexId)),
  });
  if (!spec) {
    throw new NotFoundError(`Spec ${briefId} not found`);
  }
  // Spec-only — non-Spec docTypes don't have a phase pipeline (per b-105:
  // canonical docType is `spec`, legacy aliases are gone).
  if (spec.docType !== "spec") {
    throw new ValidationError(
      `assess_phase_transition is Spec-only (docType='${spec.docType}').`,
    );
  }

  // Decisions
  const allDecisions: Decision[] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.docId, briefId), eq(decisions.memexId, memexId)));
  const openDecisions = allDecisions.filter((d) => d.status === "open");
  const resolvedDecisions = allDecisions.filter((d) => d.status === "resolved");

  // Tasks (with blocker info via getReadyTasks helpers)
  const ready = await getReadyTasks(memexId, briefId);
  const readyIds = new Set(ready.map((t) => t.id));
  const allTasks: Task[] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.docId, briefId), eq(tasks.memexId, memexId)));
  const incomplete = allTasks.filter((t) => t.status !== "complete");
  const blockedTasks = incomplete.filter(
    (t) => t.status === "not_started" && !readyIds.has(t.id),
  );

  // Comments (drift / plan_revision) — open only
  const driftComments = await db.query.docComments.findMany({
    where: and(
      eq(docComments.memexId, memexId),
      eq(docComments.commentType, "drift"),
      isNull(docComments.resolvedAt),
    ),
  });
  const planRevisionComments = await db.query.docComments.findMany({
    where: and(
      eq(docComments.memexId, memexId),
      eq(docComments.commentType, "plan_revision"),
      isNull(docComments.resolvedAt),
    ),
  });

  // Filter drift / plan_revision to comments whose target lives on this Spec.
  // Comments are XOR-targeted (sectionId | decisionId | taskId), so we resolve
  // the parent docId for each.
  const sectionRows: DocSection[] = await db
    .select()
    .from(docSections)
    .where(eq(docSections.docId, briefId));
  const sectionIdSet = new Set(sectionRows.map((s) => s.id));
  const decisionIdSet = new Set(allDecisions.map((d) => d.id));
  const taskIdSet = new Set(allTasks.map((t) => t.id));

  const isOnSpec = (c: { sectionId: string | null; decisionId: string | null; taskId: string | null }): boolean =>
    (c.sectionId !== null && sectionIdSet.has(c.sectionId)) ||
    (c.decisionId !== null && decisionIdSet.has(c.decisionId)) ||
    (c.taskId !== null && taskIdSet.has(c.taskId));

  const specDrift = driftComments.filter(isOnSpec);
  const specPlanRevisions = planRevisionComments.filter(isOnSpec);

  // Best-effort resolved-decision coverage check. For each resolved decision,
  // is there at least one section that either mentions `dec-N` or was updated
  // after the decision was resolved? Cheap signal — surfaces "did the narrative
  // get updated to capture this consequence" without an LLM.
  const resolvedDecisionCoverage: ConsequenceCoverageFact[] = resolvedDecisions.map((d) => {
    const handle = `dec-${d.seq}`;
    const referenced = sectionRows.some((s) => s.content.includes(handle));
    const updatedAfter = d.resolvedAt
      ? sectionRows.some((s) => s.updatedAt && s.updatedAt > d.resolvedAt!)
      : false;
    return {
      decisionHandle: handle,
      decisionTitle: d.title,
      hasConsequenceSection: referenced || updatedAfter,
    };
  });

  // Per-resolved-decision implementation-AC coverage — sourced from the
  // shared helper so list_acs and the rubric speak with one voice.
  const resolvedDecisionAcCoverage: DecisionAcCoverageFact[] = (
    await listResolvedDecisionImplAcCoverage(memexId, briefId)
  ).map((c) => ({
    decisionHandle: c.decisionHandle,
    decisionTitle: c.decisionTitle,
    implementationAcCount: c.implementationAcCount,
  }));

  // spec-112 t-8: in-flight Issues (open + converted) on this Spec — drives the
  // SOFT verify→done warning below and the matching fact.
  const openIssuesCount = await countOpenIssuesOnSpec(memexId, briefId);

  // spec-120 ac-3: open comments on this Spec, total + by-type. Computed once
  // here; `.total` feeds the shared readiness view below (same figure as
  // before) and `.byType` rides the fact sheet so hold-signals are
  // distinguishable from provenance notes inline.
  const openComments = await breakdownOpenCommentsOnSpec(
    memexId,
    sectionIdSet,
    decisionIdSet,
    taskIdSet,
  );

  // spec-120 ac-1: AC verification roll-up drawn from the same `test_events`
  // derivation `list_acs` uses, so the gate and `list_acs` can never silently
  // disagree. Drives the `done` hold signal below (ac-2) and the fact sheet.
  const acVerification = await summarizeAcVerification(memexId, briefId);

  // b-68 t-7: the legacy per-target `.md`-sourced rubric is retired. Only the
  // friendly note for the rubric-less draft→specify transition remains; the
  // composed `rubricProse` below carries the full rubric prose.
  let rubricNote: string | null = null;
  if (targetPhase === "specify") {
    rubricNote =
      "draft→specify has no readiness review — moving into specify is encouraged early and often. Just ensure the Overview captures the gist of the work.";
  }

  // b-68 t-5: composed rubric prose. `toRubric` returns the base
  // TransitionRubric text first, then any enabled Org `{transition}`-targeted
  // blocks in `order`. The Org blocks ride `org_scaffold_additions` (t-3) and
  // are filtered server-side to the principal's owning Org. Personal memexes
  // (ns.kind === 'user') have no Org context, so `orgIdForMemex` returns null
  // and we project against base data only — keeps the projection contract
  // working uniformly across surfaces.
  const orgId = await orgIdForMemex(memexId);
  // spec-193 t-5: filter the Org overlay to this memex's view (account-wide +
  // rows scoped to THIS memex) so a per-memex override never bleeds into a
  // sibling memex's transition rubric.
  const orgBlocks: readonly GuidanceBlock[] = orgId
    ? filterOrgBlocksForMemex(
        await listOrgScaffoldAdditionsCached(orgId, { enabledOnly: true }),
        memexId,
      )
    : [];
  const rubricProse = toRubric({
    dataset: BASE_SCAFFOLD,
    transition: targetPhase as Transition,
    orgBlocks,
  });

  // Rule-based nudges
  const nudges: string[] = [];
  if (openDecisions.length > 0 && targetPhase !== "specify") {
    nudges.push(
      `There are ${openDecisions.length} open decision${openDecisions.length === 1 ? "" : "s"}. Forward transition is risky.`,
    );
  }
  if (incomplete.length > 0 && targetPhase === "verify") {
    nudges.push(
      `There are ${incomplete.length} incomplete task${incomplete.length === 1 ? "" : "s"}; verify usually waits until all tasks are complete.`,
    );
  }
  if (specDrift.length > 0 && targetPhase === "verify") {
    nudges.push(
      `Unresolved drift comment${specDrift.length === 1 ? "" : "s"} — consider resolving them in the verify pass.`,
    );
  }

  // spec-112 t-8: verify→done soft warning for in-flight Issues (ac-17). Closing
  // a Spec while Issues are still `open` (the bug/todo isn't fixed) or
  // `converted` (its satisfying Task hasn't proven green) means the Spec claims
  // done while work it owns is unresolved. SOFT only — it adds a nudge that NAMES
  // the count but never holds the transition (update_doc({status:'done'}) still
  // succeeds, ac-18). When every Issue is resolved / wont_fix (or there are none)
  // openIssuesCount is 0 and no warning fires.
  if (openIssuesCount > 0 && targetPhase === "done") {
    nudges.push(
      `There ${openIssuesCount === 1 ? "is" : "are"} ${openIssuesCount} open or converted Issue${openIssuesCount === 1 ? "" : "s"} on this Spec. ` +
        `Closing it to 'done' leaves that work unresolved — resolve, convert, or mark them wont_fix first, or close anyway if intentional.`,
    );
  }

  // spec-120 ac-2: failing / stale AC hold signal on the verify→done gate.
  // Mirrors how open drift is surfaced — an explicit warning line that NAMES
  // the offending AC handles, drawn from the same `test_events` derivation
  // `list_acs` uses (acVerification above). Closing a Spec to 'done' while a
  // tagged test is emitting `fail`, or while a once-passing AC has gone `stale`
  // (>7d), means the gate would otherwise read clean while an acceptance
  // criterion is unmet — exactly the gap spec-116's dry-runs surfaced. SOFT
  // (a nudge, not a hard gate), consistent with the other done-phase warnings.
  if (targetPhase === "done") {
    const { failing, stale, failingHandles, staleHandles } = acVerification;
    if (failing > 0) {
      nudges.push(
        `${failing} acceptance criteri${failing === 1 ? "on is" : "a are"} FAILING (${failingHandles.join(", ")}). ` +
          `A clean done gate would otherwise hide this — fix the code or the test so the tagged test passes before closing to 'done'.`,
      );
    }
    if (stale > 0) {
      nudges.push(
        `${stale} acceptance criteri${stale === 1 ? "on is" : "a are"} STALE (${staleHandles.join(", ")}) — last passing run is older than ${STALE_THRESHOLD_DAYS} days. ` +
          `Re-run the tagged tests to refresh verification before closing to 'done', or close anyway if intentional.`,
      );
    }
  }

  // Decisions-need-ACs gate: any resolved decision on the specify→build path that
  // lacks an active implementation AC is a hold-flavoured signal. Lists the
  // offending decisions inline so the agent can author the missing ACs without
  // a second tool call. Same firmness as open-decisions check above — the
  // resulting nudge feeds the rubric's hold-on-naked-decisions verdict.
  if (targetPhase === "build") {
    const naked = resolvedDecisionAcCoverage.filter(
      (c) => c.implementationAcCount === 0,
    );
    if (naked.length > 0) {
      const handles = naked.map((c) => c.decisionHandle).join(", ");
      nudges.push(
        `Resolved decisions without implementation ACs: ${handles}. ` +
          `Specify→build is a hold until each has ≥1 active implementation AC linked via ` +
          `\`create_ac({ kind: 'implementation', parent_decision_ref: '<dec-ref>', ... })\`. ` +
          `See \`get_information(topic='decisions-need-acs')\`.`,
      );
    }
  }

  // spec-106 t-4: missing-core-lens soft nudge (dec-1). On the specify→build
  // transition only, inspect the Spec's section types/titles; if a CORE lens
  // (Design & UX, Architecture & Security) has no matching section, surface a
  // warning that NAMES the missing lens. This is a SOFT signal — it adds a
  // warning to the fact sheet/nudges but does NOT introduce a transition block.
  // The verdict for a missing-lens-only Spec stays proceed-with-caveats, never
  // 'hold' (update_doc({status:'build'}) still succeeds — see updateDocStatus,
  // which gates on nothing here).
  if (targetPhase === "build") {
    const missingLenses = detectMissingCoreLenses(sectionRows);
    if (missingLenses.length > 0) {
      nudges.push(
        SPEC_SHAPE_MISSING_LENS_WARNING.replace(
          "{lens}",
          missingLenses.join(", "),
        ),
      );
    }
  }

  // Code-grounding self-classification (doc-27). Only applies on the
  // specify→build transition (`target === 'build'`). On other targets the
  // parameter is silently ignored — no prompt, no nudge, no behaviour change.
  let effectiveCodeGrounding: CodeGrounding | undefined;
  let codeGroundingPromptPending = false;
  if (targetPhase === "build") {
    if (codeGrounding === undefined) {
      codeGroundingPromptPending = true;
    } else {
      effectiveCodeGrounding = codeGrounding;
      nudges.push(CODE_GROUNDING_NUDGE[codeGrounding]);
    }
  }

  // Stamp recency cache (t-7).
  recentAssessments.set(recencyKey(briefId, targetPhase), Date.now());

  // Cross-surface readiness — same shape consumed by the React UI's
  // PhaseDropdown, computed via @memex/shared so behaviour stays in lockstep.
  // spec-120 ac-3: the total open-comment figure reuses the by-type breakdown
  // computed above — one query path, no double count.
  const readiness = computeSpecReadiness({
    currentPhase: spec.status as SpecPhase,
    decisions: allDecisions.map((d) => ({
      id: d.id,
      createdAt: d.createdAt,
      resolvedAt: d.resolvedAt,
      status: d.status as 'open' | 'resolved' | 'candidate' | 'rejected',
    })),
    openCommentCount: openComments.total,
    narrativeLastConsolidatedAt: spec.narrativeLastConsolidatedAt ?? null,
    // spec-112 t-8: same in-flight Issue count feeds the shared readiness view
    // so the React UI's PhaseDropdown and the MCP fact sheet speak with one
    // voice (ac-5). The shared computation only surfaces it in `verify`.
    openIssueCount: openIssuesCount,
  });

  return {
    // `briefId` field name is wire-format — preserved under the b-105 allowlist.
    briefId: spec.id,
    specHandle: spec.handle,
    specTitle: spec.title,
    currentPhase: spec.status,
    targetPhase,
    transition: `${spec.status} → ${targetPhase}`,
    rubricNote,
    rubricProse,
    readiness,
    facts: {
      openDecisionsCount: openDecisions.length,
      openDecisions: openDecisions.map((d) => ({ handle: `dec-${d.seq}`, title: d.title })),
      incompleteTasksCount: incomplete.length,
      readyTasksCount: ready.length,
      blockedTasksCount: blockedTasks.length,
      incompleteTasks: incomplete.map((t) => ({
        handle: `t-${t.seq}`,
        title: t.title,
        status: t.status,
        blocked: t.status === "not_started" && !readyIds.has(t.id),
      })),
      unresolvedDriftCount: specDrift.length,
      unresolvedPlanRevisionCount: specPlanRevisions.length,
      openCommentsCount: openComments.total,
      openCommentsByType: openComments.byType,
      acVerification,
      openIssuesCount,
      sections: sectionRows.map((s) => ({
        sectionType: s.sectionType,
        title: s.title,
        updatedAt: s.updatedAt,
      })),
      resolvedDecisionCoverage,
      resolvedDecisionAcCoverage,
    },
    nudges,
    codeGrounding: effectiveCodeGrounding,
    codeGroundingPromptPending: codeGroundingPromptPending || undefined,
  };
}

/**
 * Format a phase assessment as a single agent-readable string.
 *
 * Designed for the agent's tool result — keep the rubric verbatim (the agent is
 * walking it against the facts) and the fact sheet compact and grep-able.
 */
export function formatPhaseAssessment(assessment: PhaseAssessment): string {
  const lines: string[] = [];
  lines.push(`# Readiness assessment: ${assessment.transition}`);
  lines.push(
    `Spec ${assessment.specHandle} "${assessment.specTitle}" (current phase: ${assessment.currentPhase})`,
  );
  lines.push("");

  // Fact sheet first — grep-able for the agent.
  lines.push("## Spec facts");
  const f = assessment.facts;
  lines.push(`- Open decisions: ${f.openDecisionsCount}`);
  if (f.openDecisions.length > 0) {
    for (const d of f.openDecisions) {
      lines.push(`  - ${d.handle} "${d.title}"`);
    }
  }
  lines.push(
    `- Incomplete tasks: ${f.incompleteTasksCount} (${f.readyTasksCount} ready, ${f.blockedTasksCount} blocked)`,
  );
  if (f.incompleteTasks.length > 0) {
    for (const t of f.incompleteTasks) {
      lines.push(
        `  - ${t.handle} "${t.title}" — status=${t.status}${t.blocked ? ", blocked" : ""}`,
      );
    }
  }
  lines.push(`- Unresolved drift comments: ${f.unresolvedDriftCount}`);
  lines.push(`- Unresolved plan_revision comments: ${f.unresolvedPlanRevisionCount}`);
  // spec-120 ac-3: open comments broken down by type so hold-signals
  // (review / question / drift / plan_revision) are distinguishable from
  // provenance notes (progress / plan) without a separate list_comments call.
  lines.push(`- Open comments: ${f.openCommentsCount}`);
  if (f.openCommentsCount > 0) {
    const byType = Object.entries(f.openCommentsByType).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [type, count] of byType) {
      lines.push(`  - ${type}: ${count}`);
    }
  }
  lines.push(`- Open/converted Issues: ${f.openIssuesCount}`);
  // spec-120 ac-1: AC verification state, from the same test_events derivation
  // list_acs uses — the gate and list_acs can never silently disagree. Failing
  // / stale handles are named inline so a verifier never needs a second call.
  const acv = f.acVerification;
  lines.push(
    `- AC verification: ${acv.totalActive} active — ${acv.verified} verified, ${acv.failing} failing, ${acv.stale} stale, ${acv.untested} untested${acv.accepted > 0 ? `, ${acv.accepted} accepted` : ""}`,
  );
  if (acv.failingHandles.length > 0) {
    lines.push(`  - FAILING: ${acv.failingHandles.join(", ")}`);
  }
  if (acv.staleHandles.length > 0) {
    lines.push(`  - STALE: ${acv.staleHandles.join(", ")}`);
  }
  lines.push(`- Sections: ${f.sections.length}`);
  if (f.resolvedDecisionCoverage.length > 0) {
    lines.push("- Resolved-decision narrative coverage (best-effort):");
    for (const c of f.resolvedDecisionCoverage) {
      lines.push(
        `  - ${c.decisionHandle} "${c.decisionTitle}" — narrative ${c.hasConsequenceSection ? "looks updated" : "may not capture consequence"}`,
      );
    }
  }
  if (f.resolvedDecisionAcCoverage.length > 0) {
    const nakedCount = f.resolvedDecisionAcCoverage.filter(
      (c) => c.implementationAcCount === 0,
    ).length;
    lines.push(
      `- Resolved-decision implementation-AC coverage: ${f.resolvedDecisionAcCoverage.length - nakedCount}/${f.resolvedDecisionAcCoverage.length} have ≥1 active implementation AC${nakedCount > 0 ? ` (${nakedCount} naked)` : ""}`,
    );
    for (const c of f.resolvedDecisionAcCoverage) {
      const label =
        c.implementationAcCount === 0
          ? "NAKED — no implementation AC"
          : `${c.implementationAcCount} implementation AC${c.implementationAcCount === 1 ? "" : "s"}`;
      lines.push(`  - ${c.decisionHandle} "${c.decisionTitle}" — ${label}`);
    }
  }
  lines.push("");

  // Code grounding (doc-27) — only rendered on the specify→build transition
  // when the agent hasn't yet supplied a `codeGrounding` value. Once the
  // agent answers, the classification is surfaced via the `## Nudges`
  // section below instead.
  if (assessment.codeGroundingPromptPending) {
    lines.push("## Code grounding");
    lines.push(CODE_GROUNDING_PROMPT);
    lines.push("");
  }

  // Outstanding work — same shared computation the React UI uses to gate the
  // PhaseDropdown. Only meaningful for forward transitions (the readiness rubric
  // exists for specify→build / build→verify / verify→done).
  const isForward = isForwardTransition(
    assessment.currentPhase as SpecPhase,
    assessment.targetPhase as SpecPhase,
  );
  if (isForward) {
    const lines2 = blockerLines(assessment.readiness);
    if (lines2.length > 0) {
      lines.push("## Outstanding work");
      for (const l of lines2) {
        lines.push(`- ${l}`);
      }
      lines.push("");
    }
  }

  if (assessment.nudges.length > 0) {
    lines.push("## Nudges");
    for (const n of assessment.nudges) {
      lines.push(`- ${n}`);
    }
    lines.push("");
  }

  // b-68 t-5 / t-7: composed rubric prose. Sits between the deterministic
  // sections above (facts, outstanding work, nudges) and the rubric-less
  // draft→specify note below. The `---` separator + dedicated heading make
  // the deterministic-data vs prose-rubric boundary unambiguous for the
  // agent and for downstream readers (ac-35). Emitted only when `toRubric`
  // returned non-empty content — keeps the section silent for transitions
  // that have neither base rubric nor Org additions (draft→specify today).
  if (assessment.rubricProse.length > 0) {
    lines.push("---");
    lines.push("## Rubric prose");
    lines.push(assessment.rubricProse.trim());
    lines.push("");
  }

  // Friendly note for the rubric-less draft→specify transition.
  if (assessment.rubricProse.length === 0 && assessment.rubricNote) {
    lines.push("## Rubric");
    lines.push(assessment.rubricNote);
  }

  return lines.join("\n");
}
