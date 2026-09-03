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
import {
  assertRefNotUuid,
} from "../../mcp/refs.js";
import type { ResolvedEntity } from "../../services/resolver.js";
import {
  type AcKind,
} from "../../services/acs.js";
import type { RequestCtx } from "../../services/mutate.js";
import type { AccessibleMemex } from "../../services/skills/skills-service.js";
import { ValidationError } from "../../types/errors.js";
import { type SketchAc } from "../../mcp/ac-test-sketch.js";
import { getOrgIdForMemex } from "../../services/memexes.js";
import { listOrgScaffoldAdditionsCached } from "../../services/scaffold-additions-cache.js";
import { filterOrgBlocksForMemex } from "../../services/scaffold-additions.js";
import {
  type GuidanceBlock,
} from "@memex/shared";
import type { MemexSearchHit } from "../../services/memex-search.js";
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
// spec-546: two variants below used `Awaited<ReturnType<typeof
// relatedIssuesForDecision>>`, which made this module depend on
// related-issues.ts while related-issues.ts depends on ToolCtx/ResolvedRef
// here — a cycle. That derived type resolves to exactly MemexSearchHit[], so
// naming it directly removes the edge. Types only, erased at runtime.
export type FooterSignal =
  | {
      kind: "decision_resolved";
      decRef: string;
      linkedAcs: SketchAc[];
      issueHits: MemexSearchHit[];
    }
  | { kind: "task_completed"; allComplete: boolean; remaining: number }
  | { kind: "doc_transition"; beforeStatus: string; target: string; docType: string }
  | { kind: "doc_created"; docRef: string; docType: string }
  | { kind: "decision_created"; issueHits: MemexSearchHit[] }
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
   * spec-300 dec-25: enumerate the Memexes this caller may read, for the
   * cross-Memex skills union (`list_skills({ all_memexes: true })`). This is the
   * authorization seam — the handler never decides which Memexes are visible.
   * MCP binds it to the org-scoped membership list (std-4 + the OAuth Org-scope
   * filter); the in-app agent binds it to the single Memex its chat is scoped to.
   *
   * Optional for the same reason as `getOrgBlocksForNudge` below: the many
   * hand-rolled test ctxes never set it. BOTH real surfaces do, so it is always
   * present in production; the `all_memexes` handler guards on its absence.
   */
  listAccessibleMemexes?: () => Promise<readonly AccessibleMemex[]>;
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
interface ToolAnnotations {
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

// ══════════════════════════════════════
// Helpers
// ══════════════════════════════════════

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

type DocLikeKind = "spec" | "doc" | "standard" | "execution-plan";
const DOC_LIKE_KINDS = new Set<DocLikeKind>(["spec", "doc", "standard", "execution-plan"]);

export function isDocLikeKind(kind: ResolvedEntity["kind"]): kind is DocLikeKind {
  return DOC_LIKE_KINDS.has(kind as DocLikeKind);
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
