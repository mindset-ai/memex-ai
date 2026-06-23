// spec-366 (sol-1 of audit spec-345, umbrella spec-354): shared handler
// infrastructure extracted from agent/tool-specs.ts. Holds the ToolCtx/ToolSpec
// types, the request-context bridge, and the rendering + guidance-envelope
// helpers every per-domain handler module leans on. tool-specs.ts re-exports the
// externally-imported symbols so no import site moved (std-12 bounded
// components; std-16 tool contract unchanged).

// doc-2 t-1: Single-source tool catalogue used by both surfaces.
//
// Today the MCP server (`mcp/tools.ts`) and the React-UI agent (`agent/tools.ts`)
// each carry their own switch dispatch over the same `services/*` layer. This
// file lifts the shared 30 tools to one canonical spec list, with a per-call
// `verbose` flag deciding whether to assemble full markdown (MCP) or a terse
// status string (the in-app agent loop). Both adapters wrap these specs.
//
// Tool count breakdown (per dec-4 of doc-14):
//   - This file: 30 specs (the shared surface).
//   - MCP-only: `list_memexes` (registered inline in mcp/tools.ts).
//   - Agent-only: 6 `render_*` UI tools (defined in agent/tools.ts).
//
// Adding/changing a tool:
//   - Edit the spec here — both surfaces inherit it.
//   - Update the regression test in `__regression__/tools-coverage.regression.test.ts`
//     if the catalogue shape changes (e.g. a new MCP-only tool).

import { z, type ZodRawShape } from "zod";
import { eq, } from "drizzle-orm";
import { db } from "../../db/connection.js";
import { documents, docSections, taskDeps } from "../../db/schema.js";
import {
  assertRefNotUuid,
  buildChildRef,
  memexSlugsById,
} from "../../mcp/refs.js";
import type { ResolvedEntity } from "../../services/resolver.js";
import {
  getDoc,
} from "../../services/documents.js";
import {
  listCommentsForDoc,
} from "../../services/comments.js";
import {
  COMMENT_TYPES,
  isCommentType,
  type CommentType,
} from "../../types/roles.js";
import {
  listDecisions,
} from "../../services/decisions.js";
import {
  listAcsForBriefWithVerification,
  type AcKind,
  type AcWithVerification,
} from "../../services/acs.js";
import {
  listTasks,
  getTask,
} from "../../services/tasks.js";
import type { RequestCtx } from "../../services/mutate.js";
import { listActivityView } from "../../services/activity-view.js";
import { resolveTestEventActors } from "../../services/who-resolver.js";
import { stripUuids, containsUuid } from "../../services/shared/identifiers.js";
import { listPresent } from "../../services/presence.js";
import { getUserByEmail, getUserById } from "../../services/users.js";
import {
  listDocTags,
} from "../../services/tags.js";
import { ValidationError } from "../../types/errors.js";
import {
  formatFullDocState,
  formatSpecGuidanceBody,
  type InjectedBlock,
} from "../../mcp/formatters.js";
import { buildSketchBlock, type SketchAc } from "../../mcp/ac-test-sketch.js";
import { getOrgIdForMemex } from "../../services/memexes.js";
import { listOrgScaffoldAdditionsCached } from "../../services/scaffold-additions-cache.js";
import { filterOrgBlocksForMemex } from "../../services/scaffold-additions.js";
import {
  searchMemex,
} from "../../services/memex-search.js";
import {
  BASE_SCAFFOLD,
  HANDOFF_BUTTON_BY_PHASE,
  toButtonPrompt,
  toHandoffEssence,
  GET_PROMPT_PROSE,
  type Phase,
  type GuidanceBlock,
} from "@memex/shared";
import { claimFullHandoffDelivery } from "../../services/handoff-delivery.js";
// Codebase-intelligence service + formatter imports removed per doc-24 dec-1
// alongside the commented-out tool block below. Restore from
// `../mcp/codebase-formatters.js`, `../services/{code-search,repos,files,symbols,endpoints,imports,calls,repo-meta}.js`
// when the tools come back.

// ══════════════════════════════════════
// Tool context
// ══════════════════════════════════════
//
// Both surfaces inject a ctx so the spec can be agnostic about *how* a
// memex is resolved (membership checks for MCP, bound-and-validated for
// the in-app agent) and *what* shape the response should take (full
// markdown vs. terse status string).

export type EntityKind = "doc" | "section" | "decision" | "task" | "comment";

/**
 * b-36 T-6: an entity resolved from a canonical ref, packaged together with
 * the parent doc + namespace/memex slugs so a tool handler can both mutate
 * via the service layer (memexId + entity id) and emit a `ref:` line on the
 * way out (slugs + doc + child seq) without re-querying the DB.
 */
export interface ResolvedRef {
  /** Full entity discriminated union from the resolver. */
  entity: ResolvedEntity;
  /** The owning memex's UUID — same as `entity.row.memexId`, surfaced for ergonomics. */
  memexId: string;
  /** The parent doc — same row as `entity.row` for doc-level kinds. */
  doc: import("../../db/schema.js").Doc;
  /** Namespace + memex slugs, ready to feed into `buildDocRef` / `buildChildRef`. */
  slugs: { namespace: string; memex: string };
}

/**
 * spec-219 Phase 2 (sole-author): the structured signal a handler parks in
 * `ctx.footerSlot` to tell `composeGuidanceEnvelope` WHAT just happened. The
 * handler passes DATA only; `composeGuidanceEnvelope` (via `renderFooterSignal`)
 * owns every WORD. New event shapes get a new variant here — never prose in a
 * handler.
 */
export type FooterSignal =
  | {
      kind: "decision_resolved";
      decRef: string;
      linkedAcs: SketchAc[];
      issueHits: Awaited<ReturnType<typeof relatedIssuesForDecision>>;
    }
  | { kind: "task_completed"; allComplete: boolean; remaining: number }
  | { kind: "doc_transition"; beforeStatus: string; target: string; docType: string }
  | { kind: "doc_created"; docRef: string; docType: string }
  | { kind: "decision_created"; issueHits: Awaited<ReturnType<typeof relatedIssuesForDecision>> }
  | {
      kind: "ac_created";
      acKind: AcKind;
      sameKindCount: number;
      // implementation-kind only: the build-gate picture, so the footer can push
      // toward build the moment every resolved decision is covered (and name the
      // remaining gaps until then). open/uncovered are dec-N handles.
      coverage?: { phase: string; resolvedCount: number; uncovered: string[]; open: string[] };
    };

/** The single channel from a handler to `composeGuidanceEnvelope`: a structured
 *  `signal` carrying the DATA of what just happened. composeGuidanceEnvelope
 *  (renderFooterSignal) owns the words. A handler never puts prose here. */
export interface FooterSlot {
  signal?: FooterSignal;
}

export interface ToolCtx {
  userId: string;
  /**
   * spec-203 Layer 2 (dec-2): the MCP `Mcp-Session-Id` for this call, threaded
   * from the dispatch layer (`createMcpServer`). The centralized footer machine
   * (`formatState`) keys its once-per-(user, session, spec, phase) full-handoff
   * delivery on it. Present only on the MCP surface; undefined for the in-app
   * agent (which is primed via the shared_nudge channel, spec-123 dec-8) and for
   * hand-rolled test ctxes — both keep the compressed-essence footer path.
   */
  sessionId?: string;
  /**
   * spec-156 ac-19: the surface invoking this handler — `mcp` for the MCP
   * server wrap (`mcp/tools.ts`), `in_app_agent` for the React agent loop
   * (`agent/tools.ts` → `buildAgentCtx`). Handlers that thread a channel into a
   * downstream `mutate()`/`RequestCtx` (e.g. update_doc's tag writes) MUST read
   * it here instead of hardcoding — otherwise Pulse misattributes agent-driven
   * activity as MCP. Optional + defaults to `mcp` at the call site so the many
   * hand-rolled test ctxes (which never set it) keep their historic behaviour.
   */
  channel?: "mcp" | "in_app_agent";
  /**
   * Display name of the acting user, set ONLY on the in-app agent path (the
   * agent acts on behalf of the signed-in human). When present, user-authored
   * artifacts like comments are attributed to this name with source='human'
   * (spec-126 change-10). The MCP path leaves it undefined and keeps the
   * historic 'Memex agent' / source='agent' attribution.
   */
  userName?: string;
  /**
   * MCP: resolveMemexFromEntity-bound — looks up the entity and asserts
   * the user is an active member of its memex.
   * Agent: validates the entity belongs to the pre-bound memexId; throws
   * NotFoundError otherwise (defence-in-depth against tenant cross-talk).
   *
   * Legacy — used only by callers that haven't migrated to ref-based
   * resolution. New code calls `resolveRef` instead.
   */
  resolveMemexFromEntity: (kind: EntityKind, id: string) => Promise<string>;
  /**
   * MCP: resolveWorkspace-bound — picks the user's memex by namespace slug.
   * Agent: returns the pre-bound memexId, ignoring the `memex` arg.
   */
  resolveMemex: (memex?: string) => Promise<string>;
  /**
   * b-36 T-6: resolve a canonical ref (`<ns>/<mx>/<doc-type>/<handle>[/...]`)
   * to its entity row, parent doc, and namespace/memex slugs — and assert
   * the caller has membership on the owning memex. Throws on parse error,
   * missing entity, or membership denial.
   */
  resolveRef: (ref: string) => Promise<ResolvedRef>;
  /**
   * Build a tenant URL (`${origin(APP_BASE_URL)}/${namespace}/${memex}`) for
   * verbose output. Path-based per std-2, host-agnostic. Agent passes a no-op
   * (returns empty string) since terse output never renders URLs.
   */
  workspaceUrl: (memexId: string) => Promise<string>;
  /**
   * Selects response shape:
   *   true  → assemble full doc state and format via the existing
   *           formatters (MCP).
   *   false → return a terse status string compatible with the agent's
   *           current `executeServerTool` returns (UI agent loop).
   */
  verbose: boolean;
  /**
   * The doc UUID the agent is currently editing, if any. Set by the in-app
   * agent when the chat is bound to a specific doc; unset for the creation
   * phase (no doc yet) and for the MCP surface (no bound doc). Used by
   * `search_memex` to exclude self-hits by default — the agent already has
   * the current doc in its Document Context system block, so search
   * regurgitating it adds noise without signal.
   */
  currentDocId?: string;
  /**
   * b-68 t-8 / ac-29: name of the tool currently dispatching this handler.
   * Threaded into the nudge channel so `toNudge({ tool, ... })` picks up
   * per-tool Org additions targeting this exact tool. Both surfaces (the
   * MCP server in `mcp/tools.ts` and the React agent in `agent/tools.ts`)
   * MUST populate this — it's the load-bearing signal that keeps both
   * surfaces composing identical nudge text for the same (tool, phase)
   * pair.
   */
  toolName?: string;
  /**
   * b-68 t-8 / ac-29: lazy fetcher for the principal's Org's enabled
   * `org_scaffold_additions`, threaded into the nudge channel so
   * `toNudge({ orgBlocks, ... })` can merge Org overlay blocks with the
   * base `BASE_SCAFFOLD` content. Both surfaces populate this with the
   * cached `listOrgScaffoldAdditionsCached` reader (per b-68 t-11) so the
   * hot path stays O(1) inside the 30s TTL.
   *
   * Lazy — only invoked when a handler reaches a spec doc state
   * formatter. Most tool calls (search, list, comments) don't need it, so
   * we don't pay the lookup cost up front. Returns `[]` when the bound
   * memex has no Org context (personal namespaces).
   */
  getOrgBlocksForNudge?: () => Promise<readonly GuidanceBlock[]>;
  /**
   * spec-219 dec-3 (t-3): the stable slot a handler parks its dynamic footer
   * nugget in — the result-reporting / steering text it used to inject as a
   * `{ zone: "footer" }` block on its own `formatState` call. The single seat
   * (`composeGuidanceEnvelope`) reads it and folds it into the footer, so the
   * choke point lands it AFTER `FOOTER_DELIMITER` and the telemetry split
   * persists it to `mcp_tool_calls.footer_text` (it never was while the nugget
   * rode the body, before the delimiter). A shared mutable holder: the choke
   * point (`runToolWithSpecTraffic`) creates one, threads it into the handler's
   * ctx, and reads it back when it composes the envelope. Absent on hand-rolled
   * test ctxes that bypass the choke — there the nugget is simply not delivered,
   * exactly as any footer needs the choke to attach it.
   */
  footerSlot?: FooterSlot;
  /**
   * spec-219 Phase 2: a creating tool (e.g. `create_doc`) records the doc it
   * just made so the choke point runs `composeGuidanceEnvelope` for it — the
   * tool resolved no ref, so the normal `resolveRef` target capture never fired.
   * The choke sets this; handlers call it.
   */
  recordCreatedDoc?: (memexId: string, docId: string) => void;
}

/**
 * spec-122 dec-5 — turn a ToolCtx into the RequestCtx the source-table services
 * thread into mutate() and stamp onto the activity contract columns. Carries WHO
 * (actorUserId; actorName when the surface knows it — the in-app agent does, the
 * MCP surface leaves it for the service to resolve) and HOW (channel defaults to
 * 'mcp' for the same reason the dispatch layer does — a hand-rolled test ctx
 * without a channel is the MCP server) plus the per-client session id.
 */
export function reqCtx(ctx: ToolCtx): RequestCtx {
  return {
    actorUserId: ctx.userId,
    ...(ctx.userName !== undefined ? { actorName: ctx.userName } : {}),
    channel: ctx.channel ?? "mcp",
    ...(ctx.sessionId !== undefined ? { clientId: ctx.sessionId } : {}),
  };
}

/**
 * b-68 t-8 / ac-29: lazy fetcher for the principal Org's enabled
 * `org_scaffold_additions`, used by both surfaces (MCP + React) to populate
 * `ToolCtx.getOrgBlocksForNudge`. Pulling this helper through one shared
 * function keeps the merge contract identical across surfaces — both call
 * `listOrgScaffoldAdditionsCached(orgId, { enabledOnly: true })` exactly
 * the way the runtime nudge composer expects.
 *
 * Personal namespaces (memexes with no owning Org) return `[]` — the nudge
 * composer is shaped to accept an empty Org-blocks list (per ac-25), so the
 * caller doesn't need to special-case "no org" anywhere downstream.
 *
 * `getMemexId` is a thunk so the fetcher resolves the memexId at call time
 * (after the spec handler has resolved a ref / memex). On surfaces where
 * the memexId isn't known until a resolveMemex/resolveRef hop fires, this
 * lets us bind the getter into the ctx up-front without depending on the
 * resolution order.
 */
export function buildNudgeOrgBlocksGetter(
  getMemexId: () => string | undefined,
): () => Promise<readonly GuidanceBlock[]> {
  return async () => {
    const memexId = getMemexId();
    if (!memexId) return [];
    const orgId = await getOrgIdForMemex(memexId);
    if (!orgId) return [];
    // spec-193 t-5: the cache holds every enabled row for the Org (account-wide
    // + per-memex). Filter to this memex's view — account-wide rows plus the
    // rows scoped to THIS memex — so a per-memex override never bleeds into a
    // sibling memex under the same namespace.
    const all = await listOrgScaffoldAdditionsCached(orgId, { enabledOnly: true });
    return filterOrgBlocksForMemex(all, memexId);
  };
}

// MCP `ToolAnnotations` hints — surfaced to clients (Claude) so they can vary
// behaviour (e.g. ask the user to confirm before calling a destructive tool).
// Required by the Anthropic Connectors Directory (b-31 W2): every tool must
// carry `title`, `readOnlyHint`, and `destructiveHint`. Misclassifying a
// destructive tool as readOnly means Claude calls it without confirmation, so
// these are kept verbatim in `__regression__/tools-annotations.regression.test.ts`.
export interface ToolAnnotations {
  /** Human-readable display name shown in tool pickers. */
  title: string;
  /** True if the tool does not modify any state. */
  readOnlyHint: boolean;
  /**
   * True if the tool performs an irreversible mutation (delete, hard drop, etc.).
   * False for reversible mutations (update_*, create_* — all can be reverted by
   * a follow-up tool call).
   */
  destructiveHint: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: ZodRawShape;
  /** MCP tool annotations (b-31 W2). */
  annotations: ToolAnnotations;
  /** Returns the response text. Adapters wrap into MCP/agent shapes. */
  handler: (input: Record<string, unknown>, ctx: ToolCtx) => Promise<string>;
}

// ══════════════════════════════════════
// Shared description fragments
// ══════════════════════════════════════

export const MEMEX_DESC =
  'Memex identifier in `<namespace>/<memex>` form (e.g. "mindset/website-rewrite") — same string the user types in the browser. ' +
  "Optional if you have only one Memex; required otherwise. " +
  "Always confirm with the user which Memex to operate in before any mutating call — don't assume the only one when there are multiple, and don't assume the personal one is the right default. " +
  "Use list_memexes() to discover the values.";

/**
 * Per dec-1 of doc-20: every shared tool spec accepts an optional `verbose`
 * input flag. Default (unset / false) returns a terse confirmation; true
 * routes through the existing markdown formatters to return the full doc
 * state. Exported as a single shared zod fragment so naming + description
 * stay consistent across all 30 specs (per §4 Risks R1) — every
 * `spec.schema.verbose` references THIS instance by identity, enforced by
 * the audit suite.
 */
export const VERBOSE_FIELD = z
  .boolean()
  .optional()
  .describe(
    "When true, return the full markdown response (doc state + formatters). " +
      "Default false returns a terse confirmation.",
  );

export const COMMENT_TYPE_DESC =
  `Comment taxonomy. Pick one of: ${COMMENT_TYPES.join(", ")}. ` +
  "Use `plan` before coding, `progress` for in-flight notes, `issue` for blockers, `deferred` for skipped work, " +
  "`question` when you need a human, `cross_reference` for observations whose action lives elsewhere (combine with exactly one of referenceBriefId / referenceStandardId / referenceDecisionId / referenceTaskId), " +
  "`readiness_check` for execution-plan READY/NOT READY assessments, `plan_revision` after re-submitting a plan, `drift` for standard drift findings.";

export const TASK_STATUS = ["not_started", "in_progress", "complete"] as const;

export const COMPLETION_NUDGE =
  "Leave a `progress` comment for whoever picks this up next: what landed, the contract it honours, any surprises, and what is left for downstream.";

// ══════════════════════════════════════
// Helpers
// ══════════════════════════════════════

export interface FullDocState {
  doc: Awaited<ReturnType<typeof getDoc>>;
  decs: Awaited<ReturnType<typeof listDecisions>>;
  tasks: Awaited<ReturnType<typeof listTasks>>;
  comments: Awaited<ReturnType<typeof listCommentsForDoc>>;
  // spec-136 t-4: the Spec's tags, rendered inline by formatFullDocState so any
  // doc-state response (get_doc, every mutation) carries them.
  tags: Awaited<ReturnType<typeof listDocTags>>;
}

/**
 * Build the canonical ref for a comment that landed on a standard SECTION
 * (flag_drift / propose_standard_change). The tools take a canonical section
 * ref and resolve it to the section UUID server-side (see
 * resolveStandardSectionRef, spec-143 ac-14); the resulting comment lives under
 * the standard's `std-N` handle and so also has a canonical ref. Returns null
 * only if the section/standard or memex slugs can't be resolved (in which case
 * the handler omits the `ref:` line entirely rather than leaking a raw UUID).
 */
export async function buildStandardCommentRef(
  memexId: string,
  standardSectionId: string,
  commentSeq: number,
): Promise<string | null> {
  const section = await db.query.docSections.findFirst({
    where: eq(docSections.id, standardSectionId),
  });
  if (!section) return null;
  const standard = await db.query.documents.findFirst({
    where: eq(documents.id, section.docId),
  });
  if (!standard) return null;
  const slugs = await memexSlugsById(memexId);
  if (!slugs) return null;
  return buildChildRef(slugs, standard, { type: "comments", seq: commentSeq });
}

/**
 * Resolve a standard-section `ref` arg (e.g.
 * `<ns>/<mx>/standards/std-N/sections/s-M`) to its owning memex + raw section
 * UUID, for the standards-drift verbs (`flag_drift` / `propose_standard_change`).
 *
 * spec-143 ac-14: these verbs used to take a raw section UUID via
 * `resolveMemexFromEntity("section", …)`, but the read surface only ever emits
 * `s-N` section refs (see `formatStandard` — `Section #N | ref: …/sections/s-N`),
 * never a section UUID, so the UUID-only contract made them uncallable from MCP
 * and contradicted the "UUIDs are not accepted on the MCP boundary" invariant.
 * They now take the canonical ref and resolve it server-side, exactly like
 * `update_section` / `edit_clause`. `resolveRefArg` rejects a raw UUID up front
 * via `assertRefNotUuid`.
 */
export async function resolveStandardSectionRef(
  ctx: ToolCtx,
  ref: string,
): Promise<{ memexId: string; sectionId: string }> {
  const resolved = await resolveRefArg(ctx, ref);
  if (resolved.entity.kind !== "section") {
    throw new ValidationError(
      `Expected a standard section ref (e.g. \`<ns>/<mx>/standards/std-N/sections/s-M\`); got ${resolved.entity.kind}.`,
    );
  }
  if (resolved.doc.docType !== "standard") {
    throw new ValidationError(
      `\`${ref}\` is a section on a ${resolved.doc.docType}, not a standard. flag_drift / propose_standard_change only operate on standard sections.`,
    );
  }
  return { memexId: resolved.memexId, sectionId: resolved.entity.row.id };
}

/**
 * Resolve the current verification state of one AC (spec-127) so the
 * discontinue/restore write tools can report the badge result inline — the
 * agent sees immediately whether the retire cleared the red. Best-effort: any
 * lookup miss reports "unknown" rather than failing the (already-committed)
 * mutation.
 */
export async function verificationStateForAc(
  memexId: string,
  briefId: string,
  acId: string,
): Promise<string> {
  try {
    const rows = await listAcsForBriefWithVerification(memexId, briefId);
    return rows.find((r) => r.ac.id === acId)?.verificationState ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function fullDocState(memexId: string, docIdOrHandle: string): Promise<FullDocState> {
  const doc = await getDoc(memexId, docIdOrHandle);
  const [decs, tasksList, comments, docTags] = await Promise.all([
    listDecisions(memexId, doc.id),
    listTasks(memexId, doc.id),
    listCommentsForDoc(memexId, doc.id),
    listDocTags(memexId, doc.id),
  ]);
  return { doc, decs, tasks: tasksList, comments, tags: docTags };
}

/**
 * Format the full doc state for a tool response. Pass `ctx` so the
 * spec phase footer (composed by `toNudge` inside
 * `formatBriefGuidance`) picks up the per-call tool name and the
 * principal's Org-overlay blocks — both surfaces (MCP + React) thread the
 * same context here, which keeps the nudge channel a single composer per
 * b-68 dec-9 (ac-29).
 *
 * `ctx` is optional only for backwards-compatible callers (tests, ad-hoc
 * usage) — production tool dispatch ALWAYS supplies it. When absent, the
 * nudge composes against base data only (tool + orgBlocks are undefined).
 */
export async function formatState(
  baseUrl: string,
  state: FullDocState,
  ctx?: ToolCtx,
  // spec-203 dec-3 (t-3): tool-injected guidance blocks (coverage header, tag
  // summary, nudges). Tools report these instead of concatenating around the
  // call; the composer places them by zone. Absent for the many bare callers.
  blocks?: readonly InjectedBlock[],
): Promise<string> {
  // spec-203 ac-15: formatState renders only the doc BODY (+ tool-injected
  // header/footer blocks). The machine footer is no longer composed here — the
  // single seat `decideFooter` composes and attaches it at the one choke point
  // (`runToolWithSpecTraffic`) on EVERY Spec-resolving call. `ctx` is retained
  // for signature stability (callers pass it); the footer no longer reads it.
  void ctx;
  return formatFullDocState(
    state.doc,
    state.decs,
    state.tasks,
    baseUrl,
    state.comments,
    undefined,
    undefined,
    undefined,
    // spec-136 t-4: the Spec's tags, rendered as a one-line strip in the header.
    state.tags,
    // spec-203 dec-3 (t-3): tool-injected guidance, placed by the composer.
    blocks,
  );
}

/**
 * THE single seat that composes the platform guidance ENVELOPE — header + footer
 * (spec-203 ac-15 / ac-16; spec-219 ac-6).
 *
 * A tool call — any tool call — is the client phoning home; we return the real
 * tool result, then take that one opening to STEER the client.
 * `composeGuidanceEnvelope` is invoked at the single choke point
 * (`runToolWithSpecTraffic`) on EVERY Spec-resolving call (ac-14), and is the
 * only place a header or footer is composed (`formatFullDocState` composes
 * neither). It returns `{ header?, footer? }` where BOTH are DELIMITER-LESS
 * content: the choke point owns the single `FOOTER_DELIMITER` and writes it
 * exactly once when it assembles `header + body + FOOTER_DELIMITER + footer`
 * (spec-219 ac-7); the telemetry wrap then splits + persists the footer (ac-17).
 * An empty envelope `{}` means "nothing to add this time".
 *
 * Starting policy (deterministic; the SITUATIONAL logic — onboarding a first
 * Spec, a reprimand when an agent is drifting — evolves HERE, behind this one
 * function, with no caller change):
 *   - verbose reads → the FULL phase footer (toNudge prose + Org overlays +
 *     once-per-session full handoff + dynamic state) — today's content,
 *     preserved, including spec-193's tripwire vocabulary.
 *   - terse calls (the build loop) → the COMPACT footer (handoff essence +
 *     dynamic state incl. the AC nag), steering without flooding the agent.
 * One composer for both (`formatSpecGuidanceBody`).
 *
 * Best-effort: never throws — a guidance-policy failure must not cost the tool
 * its result.
 */
export interface GuidanceEnvelope {
  header?: string;
  footer?: string;
}

/**
 * spec-219 dec-5 (t-4): the per-tool STEERING registry — the ONE place the
 * transition map (tool T → the move we want next, T+1) lives. Keyed by the
 * dispatching tool, it is the seam that makes the footer TRANSITION-keyed rather
 * than purely phase-keyed (ac-11): two tools resolving the same Spec in the same
 * phase can get different footers.
 *
 * Division of labour (dec-5): handlers own RESULT-REPORTING (the footer slot,
 * t-3 — what the tool just did); the seat owns STEERING (this registry + the
 * phase guidance — where to go next). A steer here MUST COMPLEMENT, never echo,
 * the handler's slot nugget (ac-12) — so a tool that already parks a slot steer
 * (update_task's completion nudge, update_doc / publish_spec transition nudges)
 * deliberately has NO entry here. Phase 2 migrates the remaining scattered
 * per-tool steers (create_doc's scope-AC push, resolve_decision's impl-AC push,
 * …) into this one map; this is the seam they land on.
 */
export const STEER_BY_TOOL: Partial<Record<string, (phase: Phase) => string | undefined>> = {
  // After editing a section while shaping the plan, the surgical next move is to
  // keep the narrative honest against the decisions. No other surface says this
  // per-tool, and update_section parks no slot nugget — so no echo.
  update_section: (phase) =>
    phase === "specify" || phase === "draft"
      ? "Steer: if this edit captures a resolved decision, confirm the decision's consequence now reads in the prose; if a new fork surfaced while writing, capture it with create_decision before it gets buried."
      : undefined,
};

/**
 * Compose the per-tool steer for this (tool, phase). Undefined when the tool has
 * no registered steer — the footer then carries only the phase guidance (+ any
 * handler slot). This is the single read of the transition map (ac-5: the
 * per-tool nudge notion has exactly one author, the seat).
 */
export function composeToolSteer(toolName: string | undefined, phase: Phase): string | undefined {
  if (!toolName) return undefined;
  return STEER_BY_TOOL[toolName]?.(phase);
}

/**
 * spec-219 Phase 2 (sole-author): `composeGuidanceEnvelope` is the ONLY place
 * footer prose is authored. Handlers park a structured `FooterSignal` (data);
 * this turns it into words. Keep-and-relocate: the copy below is the handlers'
 * former copy verbatim — only its AUTHOR and PLACEMENT (now the footer) change.
 */
export async function renderFooterSignal(
  signal: FooterSignal,
  memexId: string,
  docId: string,
): Promise<string | undefined> {
  switch (signal.kind) {
    case "decision_resolved": {
      const sketchBlock = buildSketchBlock(signal.linkedAcs);
      const acNudge =
        sketchBlock.length > 0
          ? sketchBlock
          : `Next: create the implementation acceptance criteria this decision will be verified by, ` +
            `usually several, one for each distinct behavioural claim the resolution makes:\n` +
            `  create_ac({ ref: '<this-spec>', kind: 'implementation', parent_decision_ref: '${signal.decRef}', statement: '...' })\n` +
            `See get_information(topic='decisions-need-acs') for the discipline. ` +
            `Until this decision has them, the spec can't move into build.`;
      const issuesNudge = relatedIssuesNudge(signal.issueHits);
      const out = [acNudge, issuesNudge]
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .join("\n\n");
      return out.length > 0 ? out : undefined;
    }
    case "task_completed": {
      if (signal.allComplete) {
        return (
          `${COMPLETION_NUDGE}\n\n` +
          `That was the last task. Once the tests are green, move the spec to verify with update_doc({status:'verify'}).`
        );
      }
      const r = signal.remaining;
      return `${COMPLETION_NUDGE}\n\n${r} task${r === 1 ? "" : "s"} still open in build; keep going.`;
    }
    case "doc_transition": {
      // spec-219 comb-through: the transition footer's job is to ORIENT the agent
      // to the phase it just entered, not to nag (too late) about the one it left.
      // Deliver the target phase's essence; `done` is terminal and carries none.
      void docId;
      const target = signal.target as Phase;
      const essence = toHandoffEssence(BASE_SCAFFOLD, target);
      // spec-263 dec-4 (ac-11): landing in the new phase is exactly when the
      // new phase's full handoff becomes relevant — the one-line get_prompt
      // pointer rides the essence (prose lives in scaffold-data, std-15).
      if (essence) return `${essence}\n${GET_PROMPT_PROSE.pointer}`;
      if (target === "done") {
        return (
          `This spec is now done: closed and read-only for normal work. ` +
          `Reopen it (update_doc) only if something genuinely needs to change.`
        );
      }
      return undefined;
    }
    case "doc_created": {
      if (signal.docType === "spec") {
        return (
          `You have just taken the first step to advance this work along the Memex path. ` +
          `Why Memex and not loose markdown files: a markdown spec rots silently; Memex binds every promise to a test, so the spec stays honest about whether the code still delivers it. ` +
          `It also makes you faster: human and AI work from one shared source of truth, so you always have the context and the next move in hand, and the rails catch drift before it turns into rework. You move quickly, and the work still lands right the first time. ` +
          `If the human asks why Memex, get_information(topic='why-memex') is the full case.\n\n` +
          `This spec moves through five stages, one at a time, advancing only when each is genuinely complete: ` +
          `draft (set out what "done" means) → specify (settle the decisions and give each its implementation acceptance criterion) → ` +
          `build (create and complete tasks until every acceptance criterion is backed by a passing test) → ` +
          `verify (confirm it against the running system, harnesses green, before the PR) → done (a human signs off).\n\n` +
          `You are in the first stage, draft. Here you create this spec's scope-type acceptance criteria: the plain-English statements of what "done" looks like for this spec. Call create_ac for each:\n` +
          `  create_ac({ ref: "${signal.docRef}", kind: "scope", statement: "..." })\n` +
          `Best practice is as many as genuinely capture what "done" means, usually three to six. The decisions, tasks, and tests belong to the later stages; do not jump ahead. get_information(topic='phases') has the full detail.`
        );
      }
      if (signal.docType === "standard") {
        return (
          `This standard is born with no body section — standards are authored as clauses, not prose. BEFORE adding content, read get_information(topic='authoring-standards') for what makes a good standard and a good clause, plus the full add_section(clauses) / add_clause / edit_clause / delete_clause flow. Then author the first section via:\n` +
          `  add_section({ ref: "${signal.docRef}", sectionType: "rule", clauses: ["<one aspect>", "<one aspect>"] })`
        );
      }
      return undefined;
    }
    case "decision_created": {
      const cta =
        `That's an open decision: a fork the work hinges on, now waiting to be settled. ` +
        `Resolve it with resolve_decision once you have grounded the choice in the current source ` +
        `and any prior resolutions or standards (search_memex, kind 'decision' or 'standard'). ` +
        `If it is a load-bearing call only the user should make, leave it open and put the choice ` +
        `to them rather than deciding for them.`;
      const issues = relatedIssuesNudge(signal.issueHits).trim();
      return [cta, issues].filter((s) => s.length > 0).join("\n\n");
    }
    case "ac_created": {
      if (signal.acKind === "implementation") {
        const cov = signal.coverage;
        if (!cov || cov.phase === "build") {
          return `Implementation acceptance criterion created; it earns a tagged, passing test here in build.`;
        }
        const covered = cov.resolvedCount - cov.uncovered.length;
        const gaps = [
          ...cov.open.map((h) => `${h} (still open)`),
          ...cov.uncovered.map((h) => `${h} (no implementation ACs yet)`),
        ];
        if (gaps.length > 0) {
          return (
            `Implementation acceptance criterion created. Decision coverage: ${covered} of ${cov.resolvedCount} ` +
            `resolved decisions now have implementation ACs. Still to close before build: ${gaps.join(", ")}. ` +
            `Stay in specify and fill those; don't start writing code yet.`
          );
        }
        return (
          `That closes the last gap: all ${cov.resolvedCount} resolved decisions now have implementation ACs and ` +
          `nothing is open. This is the moment to move to build, before you write any code, so the spec's phase ` +
          `matches what you are about to do. Run assess_spec({mode:'phase', target:'build'}); unless it flags ` +
          `something, advance now with update_doc({status:'build'}).`
        );
      }
      const n = signal.sameKindCount;
      const noun = n === 1 ? "scope acceptance criterion" : "scope acceptance criteria";
      if (n < 6) {
        return (
          `That makes ${n} ${noun} so far. Write one for each distinct part of what "done" means ` +
          `for this spec, to fit the spec rather than to reach a number; there is usually more to ` +
          `"done" than a first pass catches. Keep going while it has more to capture.`
        );
      }
      return (
        `That makes ${n} ${noun}, a full set that likely captures what "done" means. If it does, ` +
        `check with the user that the success criteria are complete, then move on to the decisions ` +
        `the work hinges on (create_decision). If "done" still has more to it, keep going.`
      );
    }
  }
}

export async function composeGuidanceEnvelope(
  memexId: string,
  docId: string,
  ctx: ToolCtx,
): Promise<GuidanceEnvelope> {
  // spec-219 dec-3 (t-3): a handler may have parked a dynamic footer nugget in
  // the slot (the result-reporting / steering it used to inject as a footer
  // block). `compose` folds it into the footer — BEFORE the seat's phase
  // guidance, matching the order it had on the body side — so the choke point
  // lands it past the delimiter and the telemetry split persists it (ac-9). The
  // handler kept its own DB read; the seat only composes (ac-8).
  // spec-219 Phase 2 (sole-author): a handler hands us a structured signal (the
  // DATA of what just happened); composeGuidanceEnvelope owns the words, via
  // renderFooterSignal. No handler authors footer text.
  let slot: string | undefined;
  try {
    slot = ctx.footerSlot?.signal
      ? await renderFooterSignal(ctx.footerSlot.signal, memexId, docId)
      : undefined;
  } catch {
    slot = undefined;
  }
  const compose = (
    header: string | undefined,
    footer: string | undefined,
  ): GuidanceEnvelope => {
    const footerBody =
      [slot, footer].filter((s): s is string => Boolean(s)).join("\n\n") || undefined;
    const env: GuidanceEnvelope = {};
    if (header) env.header = header;
    if (footerBody) env.footer = footerBody;
    return env;
  };
  try {
    const state = await fullDocState(memexId, docId);
    if (state.doc.docType !== "spec") return compose(undefined, undefined);
    const phase = state.doc.status as Phase;
    // spec-219 dec-5 (t-4): the seat's per-tool steer for this (tool, phase) — the
    // transition-keyed element of the footer. Folded BEFORE the general phase
    // guidance (surgical steer first); complements, never echoes, the handler's
    // slot result-reporting (ac-12).
    const toolSteer = composeToolSteer(ctx.toolName, phase);
    const withSteer = (footer: string | undefined): string | undefined =>
      [toolSteer, footer].filter((s): s is string => Boolean(s)).join("\n\n") || undefined;

    // spec-249 — the live spec-status overview. Emitted for EVERY orientation read
    // (get_doc / list_acs / assess_spec), independent of the verbose flag, and led
    // into the footer below on BOTH branches (ac-2: the cold agent can be depended
    // on neither to set verbose nor to read through one tool). Read-path only — a
    // tool not in ORIENT_READ_TOOLS (every mutation) gets null and an untouched
    // footer (ac-7).
    const orientOverview =
      ctx.toolName && ORIENT_READ_TOOLS.has(ctx.toolName)
        ? await craftStatusOverview(memexId, docId, state, phase)
        : null;

    // VERBOSE reads — the agent asked for the whole document, so author the FULL
    // phase footer via the shared composer (a pure helper; the seat still owns
    // the decision to return it).
    if (ctx.verbose) {
      const baseUrl = await ctx.workspaceUrl(memexId);
      const orgBlocks = ctx.getOrgBlocksForNudge
        ? await ctx.getOrgBlocksForNudge()
        : undefined;
      let fullHandoff: string | undefined;
      if (ctx.sessionId) {
        const handoffButtonId = HANDOFF_BUTTON_BY_PHASE[phase];
        const handoffContext = handoffButtonId
          ? handoffInterpolationContext(baseUrl, state.doc)
          : undefined;
        if (
          handoffButtonId &&
          handoffContext &&
          claimFullHandoffDelivery(ctx.userId, ctx.sessionId, state.doc.id, state.doc.status)
        ) {
          // spec-263 dec-2 (ac-9): compose WITH the Org appends already fetched
          // above — the same composition the UI button and get_prompt use, so
          // there is exactly one server-side behaviour for the handoff prompt.
          fullHandoff =
            toButtonPrompt({
              dataset: BASE_SCAFFOLD,
              buttonId: handoffButtonId,
              context: handoffContext,
              orgBlocks,
            }) ?? undefined;
        }
      }
      const nudge =
        ctx.toolName || orgBlocks || fullHandoff
          ? { tool: ctx.toolName, orgBlocks, fullHandoff }
          : undefined;
      let acVerifications: AcWithVerification[] | undefined;
      if (phase === "build") {
        try {
          const rows = await listAcsForBriefWithVerification(memexId, docId);
          acVerifications = rows.filter((r) => r.ac.status === "active");
        } catch {
          acVerifications = undefined;
        }
      }
      const footer = formatSpecGuidanceBody(
        state.doc,
        state.decs,
        state.tasks,
        nudge,
        acVerifications,
      );
      // spec-219 ac-10 / dec-4: the AC-coverage HEADER is composed HERE (the one
      // seat), not in the get_doc handler. It is the get_doc-verbose-only surface
      // — emitted only when this is a `get_doc` call (the coverage summary above
      // the doc body), with NO header delimiter (the `**AC coverage:**` line is
      // self-labelling and re-derivable, so it is not persisted). The choke point
      // prepends it above the body, byte-identical to the former header block.
      const header =
        ctx.toolName === "get_doc"
          ? (await formatCoverageHeader(memexId, docId, state.doc.docType)) || undefined
          : undefined;
      // spec-122 dec-7 — the ACTIVITY/collision block rides this same footer seat
      // (ac-23: no new MCP tool). Scoped to the get_doc ORIENT call agents make
      // before picking up a task (dec-7), so a mutation's output contract is
      // untouched. Appended to the guidance body so it flows through the one seat.
      const activity =
        ctx.toolName === "get_doc" ? await craftActivityBlock(memexId, docId, ctx.userId) : null;
      const body = activity ? `${footer ?? ""}${footer ? "\n\n" : ""}${activity}` : footer;
      // spec-249 — the status overview LEADS the verbose footer too (flag-agnostic).
      const bodyWithOverview =
        [orientOverview, body].filter((s): s is string => Boolean(s)).join("\n\n") ||
        undefined;
      return compose(header, withSteer(bodyWithOverview));
    }

    // TERSE build-loop calls — author a LEAN, situational footer here. This is
    // the seat where the steering logic lives and grows (per tool, per user, per
    // signal). Starting policy: the phase essence ("what's my job this phase")
    // plus, in build, the AC nag — the highest-value methodology steer. The body
    // is DELIMITER-LESS (spec-219 ac-7): the choke point frames it.
    const lines: string[] = [];
    // spec-249 — the status overview LEADS the terse footer (most prominent point
    // of the guidance channel), on every orientation read. Flag-agnostic: the same
    // overview the verbose branch leads with.
    if (orientOverview) lines.push(orientOverview);
    // spec-219 Phase 2b (comb-through): a surgical per-(tool, transition) steer —
    // a slot signal or a STEER_BY_TOOL entry — REPLACES the generic phase essence.
    // The agent gets told its NEXT MOVE, not re-lectured on the whole phase on
    // every call. The essence remains as the FALLBACK only when this (tool, phase)
    // has no surgical steer of its own.
    const hasSurgicalSteer = Boolean(slot) || Boolean(toolSteer);
    if (!hasSurgicalSteer) {
      const essence = toHandoffEssence(BASE_SCAFFOLD, phase);
      if (essence) {
        lines.push(essence);
        // spec-263 dec-4 (ac-11): the get_prompt pointer rides the essence
        // line — this terse seat covers the get_doc orient call AND the
        // assess_spec phase-mode response (neither has a surgical steer).
        // Suppressed on get_prompt's own responses: the body IS the prompt.
        if (ctx.toolName !== "get_prompt") lines.push(GET_PROMPT_PROSE.pointer);
      }
    }
    if (phase === "build") {
      const nag = await craftUntestedAcNag(memexId, docId);
      if (nag) lines.push(nag);
    }
    // spec-122 dec-7 — the ACTIVITY/collision block (ac-23/ac-24), scoped to the
    // get_doc orient call so mutation tools' terse footers are unchanged.
    const activity =
      ctx.toolName === "get_doc" ? await craftActivityBlock(memexId, docId, ctx.userId) : null;
    if (activity) lines.push(activity);
    return compose(undefined, withSteer(lines.length > 0 ? lines.join("\n") : undefined));
  } catch {
    return compose(undefined, undefined);
  }
}

// spec-122 dec-7 (ac-23 / ac-24) — compose the get_doc ACTIVITY/presence block:
// the most recent MATERIAL change + who, who is live in the spec right now, and
// an ADVISORY collision line when another session is materially advancing the
// spec (an AC delta, a phase move, or task churn by a DIFFERENT actor recently).
// Advisory only — never blocks, never aborts; best-effort, never throws.
export const ACTIVITY_RECENT_LIMIT = 8;
export const MATERIAL_WINDOW_MS = 10 * 60 * 1000; // "recently" for the collision predicate
// Kinds whose appearance is MATERIAL advancement (vs. a comment / read). A phase
// move shows up as an activity_log status_changed row (kind 'activity_log').
export const MATERIAL_KINDS: ReadonlySet<string> = new Set([
  "ac",
  "task",
  "decision",
  "activity_log",
  "test_event",
]);

// The b-36 hard cut — canonical refs in, NO raw UUIDs out — is a live smoke
// invariant (authed.smoke.test.ts). The ACTIVITY footer is composed from
// activity_view, whose activity_log arm replays IMMUTABLE historical narratives:
// a row written before the spec-122 narrative fix can still read "created
// doc_member <uuid>", which a forward-only narrative fix can't rewrite. So the
// footer guards itself via the shared stripUuids (below) and never lets a
// UUID-bearing actor name through. Belt-and-suspenders for the invariant.
//
// A resolved actor name that contains a raw UUID (an unattributed actor_raw,
// say) is not a name — drop it so the caller falls back to "someone".
export function sanitizeActorName(name: string | null): string | null {
  if (!name) return null;
  return containsUuid(name) ? null : name;
}

export function agoLabel(at: Date, now: number): string {
  const ms = Math.max(0, now - at.getTime());
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export async function craftActivityBlock(
  memexId: string,
  docId: string,
  currentUserId: string,
): Promise<string | null> {
  try {
    const [rows, present] = await Promise.all([
      listActivityView(memexId, { specRef: docId, limit: ACTIVITY_RECENT_LIMIT }),
      listPresent(memexId, docId),
    ]);
    const now = Date.now();
    const lines: string[] = [];

    // spec-122 ac-25/26 — resolve each row's free-form test_events actor
    // (actor_raw) to a display WHO + unifying user_id. Batched (one query) over
    // the page; non-test arms already carry a write-time actor_name and skip the
    // resolver. A match renders the user's display name and carries their user_id
    // (ac-25); a miss renders the raw string verbatim, never collapsed (ac-26).
    const whoByRaw = await resolveTestEventActors(rows.map((r) => r.actorRaw));
    const whoOf = (
      r: (typeof rows)[number],
    ): { name: string | null; userId: string | null } => {
      if (r.actorName) return { name: r.actorName, userId: r.actorUserId };
      const w = r.actorRaw ? whoByRaw.get(r.actorRaw.trim()) : undefined;
      return { name: w?.display ?? r.actorRaw ?? null, userId: w?.userId ?? r.actorUserId };
    };

    // Most recent material change + who.
    const recent = rows.find((r) => MATERIAL_KINDS.has(r.kind));
    if (recent) {
      const who = sanitizeActorName(whoOf(recent).name) ?? "someone";
      const what = recent.narrative ?? `${recent.action ?? "changed"} ${recent.kind}`;
      lines.push(`recent: ${what} — ${who} ${agoLabel(recent.at, now)}`);
    }

    // Live presence, excluding the caller.
    const others = present.filter((p) => p.actorUserId !== currentUserId);
    if (others.length > 0) {
      const names = [
        ...new Set(others.map((p) => sanitizeActorName(p.actorName) ?? "someone")),
      ].join(", ");
      lines.push(`present now: ${names}`);
    }

    // The advisory collision line: a DIFFERENT actor materially advancing recently.
    // A test_events flip carries no actor_user_id on the row, so resolve WHO first
    // (ac-25): that both names the actor and lets a CI identity resolving to the
    // CALLER be correctly excluded rather than mislabelled as "another session".
    const advancing = rows.find((r) => {
      if (!MATERIAL_KINDS.has(r.kind)) return false;
      if (now - r.at.getTime() > MATERIAL_WINDOW_MS) return false;
      const { userId } = whoOf(r);
      return userId !== null && userId !== currentUserId;
    });
    if (advancing) {
      const who = sanitizeActorName(whoOf(advancing).name) ?? "another session";
      lines.push(
        `⚠ ${who} is actively advancing this spec right now — coordinate before you pick it up. ` +
          `(Advisory only; proceed if you mean to.)`,
      );
    }

    if (lines.length === 0) return null;
    // Final guarantee for the b-36 invariant: a historical activity_log narrative
    // replayed here can still carry a raw UUID ("created doc_member <uuid>") that
    // the per-field guards above don't own — strip any surviving UUID token from
    // the composed block so get_doc never emits one (the authed smoke's hard cut).
    return stripUuids(["── ACTIVITY ──", ...lines].join("\n"));
  } catch {
    return null;
  }
}

/**
 * Lean steering line for the terse footer: how many active ACs have no passing
 * test yet, named, with the methodology push. Returns null when there are none
 * (nothing worth saying → no footer). Best-effort; never throws.
 */
export async function craftUntestedAcNag(
  memexId: string,
  docId: string,
): Promise<string | null> {
  try {
    const rows = await listAcsForBriefWithVerification(memexId, docId);
    const untested = rows.filter(
      (r) => r.ac.status === "active" && r.verificationState !== "verified",
    );
    if (untested.length === 0) return null;
    const handles = untested
      .map((r) => `ac-${r.ac.seq}`)
      .join(", ");
    return `\n⚠ ${untested.length} untested acceptance criteri${untested.length === 1 ? "on" : "a"} (${handles}). Write the tagged test before you move on — don't go dark.`;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// spec-249 — the live spec-status overview that orients a cold picker-upper.
//
// One synthesized line — phase + a FULL state census + the single next action —
// pushed onto EVERY orientation read (get_doc / list_acs / assess_spec), on both
// terse and verbose reads (ORIENT_READ_TOOLS, below). It is PUSHED, not pulled:
// the cold agent never opts in, and (the lesson that reopened this spec) cannot
// be depended on to set `verbose` or to read through any one tool. Pure data,
// read from current state, so the line is LIVE — it changes every call as
// decisions resolve, tasks complete, and ACs pass or fail (ac-3). No phase prose
// lives here; the phase essence in the same footer is the single source (ac-6).
// ──────────────────────────────────────────────────────────────────────────

/** The orientation READ surfaces the overview rides (ac-2). Every one of these
 *  resolves a single Spec, so each already flows through this seat at the choke
 *  point — the overview just needs to be emitted for them, on terse AND verbose.
 *  A named set so the surface is one edit to widen. Mutations are deliberately
 *  excluded: the overview is read-path only and never touches a mutation footer. */
export const ORIENT_READ_TOOLS: ReadonlySet<string> = new Set([
  "get_doc",
  "list_acs",
  "assess_spec",
]);

export interface StatusFacts {
  handle: string; // "spec-249"
  phase: Phase;
  decisionsTotal: number; // non-deleted decisions
  decisionsUnresolved: number; // open + candidate
  openDecisions: string[]; // dec-N handles, status open
  /** resolved decisions with no active implementation AC hanging off them. */
  resolvedDecisionsWithoutImplAc: string[]; // dec-N handles
  scopeAcsActive: number;
  tasksTotal: number;
  incompleteTasks: string[]; // t-N handles, status !== complete
  acsTotal: number; // active ACs
  untestedAcs: string[]; // ac-N handles, verificationState 'untested' (no test)
  failingAcs: string[]; // ac-N handles, verificationState 'failing' (red test)
}

/**
 * spec-249 ac-5 — the single next ACTION, phase-aware and concrete. Derived from
 * the most pressing GAP in state: a FAILING ac (a red test) is the loudest signal
 * in any phase and outranks everything; then phase-shaped progression. When the
 * spec is done it offers no forward action.
 */
export function statusNextAction(f: StatusFacts): string {
  // ac-4 — a regression reads louder than an absence: failing wins everywhere.
  if (f.failingAcs.length > 0) {
    return `fix the failing test for ${f.failingAcs[0]}`;
  }
  switch (f.phase) {
    case "draft":
    case "specify": {
      if (f.openDecisions.length > 0) {
        return `resolve ${f.openDecisions[0]}, then give it an implementation AC`;
      }
      if (f.resolvedDecisionsWithoutImplAc.length > 0) {
        return `give ${f.resolvedDecisionsWithoutImplAc[0]} an implementation AC (create_ac kind:implementation)`;
      }
      if (f.scopeAcsActive === 0) {
        return `pin down what "done" means as scope ACs (create_ac kind:scope)`;
      }
      return "move to build (update_doc status:build)";
    }
    case "build": {
      if (f.tasksTotal === 0) {
        return "break the narrative into tasks (create_task)";
      }
      if (f.incompleteTasks.length > 0) {
        return `complete ${f.incompleteTasks[0]}`;
      }
      if (f.untestedAcs.length > 0) {
        return `write the tagged test for ${f.untestedAcs[0]}`;
      }
      return "move to verify (update_doc status:verify)";
    }
    case "verify": {
      if (f.untestedAcs.length > 0) {
        return `write or run the tagged test for ${f.untestedAcs[0]}`;
      }
      return "run assess_spec target:done, then hand to a human to sign off";
    }
    case "done":
      return "none — spec is done (reopen with update_doc only if something must change)";
  }
}

/**
 * spec-249 ac-1/ac-3/ac-4/ac-5 — synthesize the status overview line from the
 * fact sheet. Pure (no DB, no clock): a deterministic projection of state, so it
 * is unit-tested directly and is LIVE by construction. The census is FULL — every
 * dimension every call (decisions total/unresolved, tasks total/incomplete, ACs
 * total/untested/failing) — never a phase-narrowed subset (ac-1), with failing
 * surfaced distinctly from untested (ac-4).
 */
export function composeStatusOverview(f: StatusFacts): string {
  const census =
    `decisions: ${f.decisionsTotal} (${f.decisionsUnresolved} unresolved)` +
    ` · tasks: ${f.tasksTotal} (${f.incompleteTasks.length} incomplete)` +
    ` · ACs: ${f.acsTotal} (${f.untestedAcs.length} untested, ${f.failingAcs.length} failing)`;
  return `${f.handle} · ${f.phase} · ${census} · Next: ${statusNextAction(f)}.`;
}

/**
 * spec-249 — gather the full census from current state and render the overview.
 * Best-effort: any lookup miss returns null (the read simply omits the overview)
 * rather than costing the tool its result. Called ONLY from
 * composeGuidanceEnvelope (ac-6: the single seat).
 */
export async function craftStatusOverview(
  memexId: string,
  docId: string,
  state: FullDocState,
  phase: Phase,
): Promise<string | null> {
  try {
    const acRows = await listAcsForBriefWithVerification(memexId, docId);
    const activeAcs = acRows.filter((r) => r.ac.status === "active");
    const implAcs = activeAcs.filter((r) => r.ac.kind === "implementation");
    const scopeAcs = activeAcs.filter((r) => r.ac.kind === "scope");
    // ac-4 — 'untested' (no test yet) and 'failing' (a red test) are distinct
    // census buckets; 'stale'/'verified' count as neither gap.
    const untestedAcs = activeAcs
      .filter((r) => r.verificationState === "untested")
      .map((r) => `ac-${r.ac.seq}`);
    const failingAcs = activeAcs
      .filter((r) => r.verificationState === "failing")
      .map((r) => `ac-${r.ac.seq}`);

    // Which resolved decisions still have no implementation AC hanging off them.
    const coveredDecisionIds = new Set(
      implAcs.flatMap((r) =>
        r.parents.filter((p) => p.kind === "decision").map((p) => p.id),
      ),
    );
    const liveDecs = state.decs.filter((d) => d.status !== "deleted");
    const facts: StatusFacts = {
      handle: state.doc.handle,
      phase,
      decisionsTotal: liveDecs.length,
      decisionsUnresolved: liveDecs.filter(
        (d) => d.status === "open" || d.status === "candidate",
      ).length,
      openDecisions: state.decs
        .filter((d) => d.status === "open")
        .map((d) => `dec-${d.seq}`),
      resolvedDecisionsWithoutImplAc: state.decs
        .filter((d) => d.status === "resolved" && !coveredDecisionIds.has(d.id))
        .map((d) => `dec-${d.seq}`),
      scopeAcsActive: scopeAcs.length,
      tasksTotal: state.tasks.length,
      incompleteTasks: state.tasks
        .filter((t) => t.status !== "complete")
        .map((t) => `t-${t.seq}`),
      acsTotal: activeAcs.length,
      untestedAcs,
      failingAcs,
    };
    return composeStatusOverview(facts);
  } catch {
    return null;
  }
}

// spec-203 Layer 2 (dec-2): build the {namespace}/{memex}/{handle}/{title}/{url}
// interpolation context the full handoff prompt needs, from the workspace URL
// (origin/<namespace>/<memex>, the same `baseUrl` formatState already holds) and
// the doc. Returns undefined when the URL can't be parsed (e.g. the in-app
// agent's no-op empty workspace URL), in which case the footer keeps the
// token-free essence rather than emitting an un-interpolated full prompt.
export function handoffInterpolationContext(
  workspaceUrl: string,
  doc: { handle: string; title: string },
): { namespace: string; memex: string; handle: string; title: string; url: string } | undefined {
  if (!workspaceUrl) return undefined;
  let pathname: string;
  try {
    pathname = new URL(workspaceUrl).pathname;
  } catch {
    return undefined;
  }
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length < 2) return undefined;
  const memex = segs[segs.length - 1];
  const namespace = segs[segs.length - 2];
  return {
    namespace,
    memex,
    handle: doc.handle,
    title: doc.title,
    // Spec docs render under /specs/ (refs.ts DB_DOC_TYPE_TO_URL); the handoff
    // only fires for specs, so the path segment is fixed.
    url: `${workspaceUrl}/specs/${doc.handle}`,
  };
}

/**
 * spec-207 dec-1 — the single source of truth for the one-line AC coverage
 * summary an agent reads to judge "is this Spec done?". Consumed by BOTH
 * renderers — `formatCoverageHeader` (the get_doc doc-state header) and the
 * `list_acs` handler — so the contract can't silently drift between them again.
 * The two had already drifted in wording, and a `kind`-filtered `list_acs` once
 * read fully green while scope ACs sat untested (the spec-201 false-done).
 *
 * Contract:
 *  - LEADS WITH THE GAP: the count of not-verified ACs (untested + failing) and
 *    their handles (`ac-1 ac-2 …`). The honest signal is never demoted to a
 *    tail clause. (ac-1)
 *  - No "verified (of covered)" headline — that trophy reads *better* the more
 *    ACs you leave untested. Any percentage is denominated over the TOTAL rows
 *    in the set, never the self-selecting covered subset. (ac-2)
 *  - `hiddenByFilter` (list_acs only): when a kind/status filter shrank the set,
 *    state how many active ACs fall outside it, so a filtered view can't
 *    silently understate the gap. (ac-3)
 *
 * Pure over the `rows` it's handed (no DB, no clock). `stale` and `accepted`
 * count as covered / not-a-gap, mirroring the spec-121 nag footer.
 */
export function formatAcCoverageSummary(
  rows: AcWithVerification[],
  opts: { hiddenByFilter?: number } = {},
): string {
  const total = rows.length;
  const s = total === 1 ? "" : "s";
  const notVerified = rows.filter(
    (r) =>
      r.verificationState === "untested" || r.verificationState === "failing",
  );
  const covered = rows.filter((r) => r.tests.length > 0).length;
  const pctCovered = total === 0 ? 0 : Math.round((covered / total) * 100);

  const gapLead =
    notVerified.length === 0
      ? `0 of ${total} AC${s} not verified`
      : `${notVerified.length} of ${total} AC${s} NOT VERIFIED: ${notVerified
          .map((r) => `ac-${r.ac.seq}`)
          .join(" ")}`;

  const parts = [gapLead, `${pctCovered}% covered (of ${total})`];

  if (opts.hiddenByFilter && opts.hiddenByFilter > 0) {
    const h = opts.hiddenByFilter;
    parts.push(
      `⚠ ${h} active AC${h === 1 ? "" : "s"} outside this filter (not counted above)`,
    );
  }

  return parts.join(" · ");
}

/**
 * Render a one-line coverage header for a Spec, suitable for prepending to a
 * verbose doc-state dump. Returns "" when the Spec has no ACs (no signal),
 * or when the doc isn't a Spec.
 */
export async function formatCoverageHeader(
  memexId: string,
  briefId: string,
  docType: string,
): Promise<string> {
  if (docType !== "spec") return "";
  try {
    const rows = await listAcsForBriefWithVerification(memexId, briefId);
    const active = rows.filter((r) => r.ac.status === "active");
    if (active.length === 0) return "";
    return `**AC coverage:** ${formatAcCoverageSummary(active)}\n\n`;
  } catch {
    return "";
  }
}

export async function loadSpec(memexId: string, missionId: string) {
  const doc = await getDoc(memexId, missionId);
  if (doc.docType !== "spec") {
    throw new ValidationError(
      `Document ${doc.handle} is a ${doc.docType}, not a Spec.`,
    );
  }
  return doc;
}

// Per dec-1 of doc-20: terse update_task on addBlocker/removeBlocker reports
// the resulting [READY] / [BLOCKED-by-...] marker so the agent doesn't need a
// follow-up `list_tasks` call to learn the new state.
export function formatTaskReadyMarker(t: {
  blockedByDecisions: { seq: number }[];
  blockedByTasks: { seq: number }[];
}): string {
  const handles = [
    ...t.blockedByDecisions.map((d) => `D-${d.seq}`),
    ...t.blockedByTasks.map((bt) => `T-${bt.seq}`),
  ];
  return handles.length === 0 ? "[READY]" : `[BLOCKED-by-${handles.join(",")}]`;
}

// Per dec-1 of doc-20: terse update_task(status='complete') reports
// dependents that JUST became unblocked by this completion. Returns the
// fresh blocker state (`getTask`) for each dependent and filters to the
// ones whose blocker set is now empty.
export async function findNewlyUnblockedDependents(
  memexId: string,
  completedTaskId: string,
): Promise<{ id: string; seq: number }[]> {
  const dependentRows = await db
    .select({ taskId: taskDeps.taskId })
    .from(taskDeps)
    .where(eq(taskDeps.dependsOnId, completedTaskId));
  if (dependentRows.length === 0) return [];
  const fresh = await Promise.all(
    dependentRows.map((row) => getTask(memexId, row.taskId).catch(() => null)),
  );
  return fresh
    .filter((t): t is NonNullable<typeof t> => t !== null && !t.blocked)
    .map((t) => ({ id: t.id, seq: t.seq }));
}

// Per dec-4 of doc-20: terse `list_comments` emits one line per comment with
// the canonical ref + type + status + a 50-char content snippet. Per b-36 T-2
// comments are path-addressable (`.../comments/c-N`), so the ref is the stable
// reference an agent pastes back into a follow-up call.
export const COMMENT_SNIPPET_LEN = 50;

export function formatTerseComment(
  c: {
    seq: number;
    commentType: string;
    resolvedAt: Date | null;
    content: string;
  },
  slugs: { namespace: string; memex: string } | null,
  doc: import("../../db/schema.js").Doc,
): string {
  const status = c.resolvedAt ? "resolved" : "open";
  const oneLine = c.content.replace(/\s+/g, " ").trim();
  const snippet =
    oneLine.length > COMMENT_SNIPPET_LEN
      ? `${oneLine.slice(0, COMMENT_SNIPPET_LEN)}…`
      : oneLine;
  const ref = slugs
    ? buildChildRef(slugs, doc, { type: "comments", seq: c.seq })
    : `c-${c.seq}`;
  return `(ref: ${ref}) [${c.commentType}, ${status}] "${snippet}"`;
}

export function formatDocCommentsTerse(
  result: {
    sections: {
      section: { sectionType: string; title?: string | null; id: string };
      comments: { seq: number; commentType: string; resolvedAt: Date | null; content: string }[];
    }[];
    decisions: {
      decision: { seq: number };
      comments: { seq: number; commentType: string; resolvedAt: Date | null; content: string }[];
    }[];
    tasks: {
      task: { seq: number };
      comments: { seq: number; commentType: string; resolvedAt: Date | null; content: string }[];
    }[];
  },
  slugs: { namespace: string; memex: string } | null,
  doc: import("../../db/schema.js").Doc,
): string[] {
  const lines: string[] = [];
  for (const sg of result.sections) {
    const label = `section ${sg.section.title ?? sg.section.sectionType}`;
    for (const c of sg.comments) {
      lines.push(`- ${formatTerseComment(c, slugs, doc)} on ${label}`);
    }
  }
  for (const dg of result.decisions) {
    const label = `dec-${dg.decision.seq}`;
    for (const c of dg.comments) {
      lines.push(`- ${formatTerseComment(c, slugs, doc)} on ${label}`);
    }
  }
  for (const tg of result.tasks) {
    const label = `t-${tg.task.seq}`;
    for (const c of tg.comments) {
      lines.push(`- ${formatTerseComment(c, slugs, doc)} on ${label}`);
    }
  }
  return lines;
}

export function parseTypeFilter(value?: string | string[]): CommentType[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const cleaned = list.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return undefined;
  for (const v of cleaned) {
    if (!isCommentType(v)) {
      throw new ValidationError(
        `Invalid comment type '${v}'. Must be one of: ${COMMENT_TYPES.join(", ")}`,
      );
    }
  }
  return cleaned as CommentType[];
}

// `pathLikeForDomain` removed per doc-24 dec-1 — only the codebase-intelligence
// tools called it.

// ══════════════════════════════════════
// Specs
// ══════════════════════════════════════
//
// b-67 t-2 [per std-19]: the CANONICAL tool list + its presentation metadata
// (summary / args / group) live in `@memex/shared/tool-manifest.ts`. This
// array is the runtime half of that contract — it supplies the Zod schema +
// handler + MCP annotations for each tool, plus the rich `description` strings
// the live MCP / agent surfaces emit. The manifest carries the terse reference
// metadata the React UI Init Prompt renders.
//
// The two halves are NOT physically deduped (this matches the existing
// MCP ↔ agent parity pattern in this codebase — parity is enforced by test,
// not by a single physical source). The b-67 regression test in
// `__regression__/tools-coverage.regression.test.ts` asserts the manifest's
// tool-name set equals the registered MCP surface, so adding / removing /
// renaming a tool here forces a matching edit in the manifest. `list_memexes`
// is the one tool registered inline in `mcp/tools.ts` (not in this array), so
// the cross-check below excludes it — see `manifestVsSpecsDiff`.


// ══════════════════════════════════════
// Internal helper: canonical-ref resolution at tool boundary
// ══════════════════════════════════════
//
// b-36 D-7 / T-6: tool inputs accept canonical refs only — no UUIDs, no
// `<prefix>-N` handles in isolation. This helper enforces the boundary,
// delegates to `ctx.resolveRef` (which runs the resolver + membership), and
// optionally asserts the resolved kind matches what the tool expects.
//
// Expected kinds for ref-acting tools:
//   - doc-level CRUD (`get_doc`, `update_doc`, `add_section`, `create_decision`,
//     `create_task`, `list_tasks`, `list_comments` with docId, `assess_spec`,
//     `publish_spec`) expect kind ∈ {spec, doc, standard, execution-plan}.
//   - section CRUD (`update_section`) expects kind === 'section'.
//   - decision verbs (`update_decision`, `resolve_decision`,
//     `approve_candidate`, `reject_candidate`) expect kind === 'decision'.
//   - task verbs (`update_task`, `delete_task`) expect kind === 'task'.
//   - comment verbs (`update_comment`) expect kind === 'comment'.
//   - `add_comment` / `list_comments` accept any of {section, decision, task}.

export type DocLikeKind = "spec" | "doc" | "standard" | "execution-plan";
export const DOC_LIKE_KINDS = new Set<DocLikeKind>(["spec", "doc", "standard", "execution-plan"]);

export function isDocLikeKind(kind: ResolvedEntity["kind"]): kind is DocLikeKind {
  return DOC_LIKE_KINDS.has(kind as DocLikeKind);
}

// spec-112 (ac-25/ac-27): rank the best-suited Specs to home a homeless Issue.
// Semantic search over the issue text (title + body) restricted to Specs
// (kind:'spec'). searchMemex already excludes archived + paused content; we
// additionally drop `done` so ONLY active-phase Specs are suggested. The vector
// arm of searchMemex runs whenever a provider is supplied — so this ranks via
// the vector path when embeddings are configured, and falls back to FTS-only
// otherwise (ac-27). Exported so the assist's ranking is unit-testable with an
// injected provider without driving the whole register_issue handler.
export async function suggestActiveSpecsForIssue(
  memexId: string,
  title: string,
  body: string,
  provider: import("../../services/embedding-provider.js").EmbeddingProvider | null,
  limit = 5,
): Promise<import("../../services/memex-search.js").MemexSearchHit[]> {
  const issueText = `${title}\n\n${body}`.trim();
  if (issueText.length === 0) return [];
  const hits = await searchMemex(memexId, issueText, {
    kind: "spec",
    provider,
    limit,
  });
  // searchMemex drops archived/paused already; exclude `done` so the
  // suggestions are active-phase Specs only (ac-27).
  return hits.filter((h) => h.status !== "done" && h.status !== "archived");
}

// spec-112 (ac-4 / ac-15): decision-time auto-surfacing of related Issues.
//
// When a decision is created or resolved, the JIT-nudge channel appends related
// Issues whose semantic overlap with the decision text clears a relevance
// threshold. This reuses the SAME searchMemex(kind:'issue') machinery the
// search_issues tool rides — no new search infra (s-4). It is INFORMATIONAL
// only: it never mutates, never blocks a phase move, and below threshold it
// appends nothing.
//
// Relevance threshold. searchMemex merges an FTS arm and a vector arm via RRF.
// The vector arm is rank-only — it returns EVERY embedded Issue ordered by
// cosine distance with no distance cutoff (see runIssueVector), so a
// vector-only hit is not by itself evidence of relevance, and adjacent
// post-RRF scores are nearly identical (1/(K+i) for consecutive ranks). The
// genuine relevance gate is therefore the FTS arm: `@@ plainto_tsquery` only
// matches Issues that share content terms with the decision text. So the
// threshold is "the hit must have been surfaced by FTS" — a real lexical
// overlap — and, among those, we keep hits whose score is at least
// RELATED_ISSUE_SCORE_RATIO of the top FTS-backed hit (a secondary trim that
// drops far-weaker partial matches). Below the gate, nothing is appended.
export const RELATED_ISSUE_SCORE_RATIO = 0.5;
export const RELATED_ISSUE_LIMIT = 3;

// Search Issues across the whole Memex (cross-Spec) for ones whose text overlaps
// the decision, keeping only those above the relevance threshold. Exported so the
// threshold behaviour is unit-testable with an injected provider (ac-15) without
// driving a whole create/resolve_decision handler.
export async function relatedIssuesForDecision(
  memexId: string,
  decisionText: string,
  provider: import("../../services/embedding-provider.js").EmbeddingProvider | null,
  limit = RELATED_ISSUE_LIMIT,
): Promise<import("../../services/memex-search.js").MemexSearchHit[]> {
  const text = decisionText.trim();
  if (text.length === 0) return [];
  const hits = await searchMemex(memexId, text, {
    kind: "issue",
    provider,
    // Pull a few extra so the ratio trim has a population to cut against, then
    // trim to `limit` after thresholding.
    limit: Math.max(limit * 2, limit),
  });
  if (hits.length === 0) return [];
  // searchMemex already drops resolved-Spec / archived noise at the doc level;
  // exclude resolved Issues so a closed bug/todo never resurfaces as "related".
  // The relevance gate: the hit must carry a real lexical overlap (FTS), not be
  // a vector-only rank artefact (every embedded Issue rides the vector arm).
  const related = hits.filter(
    (h) => h.status !== "resolved" && h.strategies.includes("fts"),
  );
  if (related.length === 0) return [];
  const top = related[0].score;
  const floor = top * RELATED_ISSUE_SCORE_RATIO;
  return related.filter((h) => h.score >= floor).slice(0, limit);
}

// Compose the informational JIT-nudge tail that lists related Issues by their
// cross-Spec canonical ref (hit.path). Returns "" when there are none above
// threshold, so callers can append unconditionally. Informational only.
export function relatedIssuesNudge(
  hits: import("../../services/memex-search.js").MemexSearchHit[],
): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h) => {
    const typeTag = h.issueType ? `${h.issueType}` : "issue";
    return `  - ${h.path} — "${h.title}" (${typeTag}, ${h.status})`;
  });
  return (
    `\n\nRelated Issues (informational — may inform this decision; nothing was changed):\n` +
    lines.join("\n") +
    `\nReview with \`get_issue({ ref: '<one of the above>' })\`; pull one into the work with \`create_task\` if it bears on this decision.`
  );
}

export async function resolveRefArg(
  ctx: ToolCtx,
  ref: string,
  argName = "ref",
): Promise<ResolvedRef> {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new ValidationError(`${argName} is required.`);
  }
  assertRefNotUuid(ref, argName);
  return ctx.resolveRef(ref);
}

// spec-118: resolve a tool's USER target. Tools accept either an email
// (contains '@' — resolved against the users table) or a user UUID (looked up
// to confirm it exists). There is no separate user-lookup tool; callers pass an
// email or id directly. A miss is a ValidationError so Claude can correct the
// argument rather than silently mutating the wrong user.
// Resolve an email-or-uuid user argument to the user record. Returns id + email
// so callers can render the EMAIL in terse output — std-10 forbids raw UUIDs in
// the response body, so handlers must never echo the resolved id.
export async function resolveUserArg(
  value: string,
  argName: string,
): Promise<{ id: string; email: string | null }> {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${argName} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.includes("@")) {
    const user = await getUserByEmail(trimmed);
    if (!user) throw new ValidationError(`No user found for email '${trimmed}'.`);
    return { id: user.id, email: user.email };
  }
  const user = await getUserById(trimmed);
  if (!user) throw new ValidationError(`No user found for id '${trimmed}'.`);
  return { id: user.id, email: user.email };
}

