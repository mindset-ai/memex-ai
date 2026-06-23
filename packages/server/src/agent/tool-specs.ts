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
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, taskDeps } from "../db/schema.js";
import {
  assertRefNotUuid,
  buildChildRef,
  buildDocRef,
  memexSlugsById,
} from "../mcp/refs.js";
import type { ResolvedEntity } from "../services/resolver.js";
import {
  createDocDraft,
  listDocs,
  getDoc,
  updateDocStatus,
  updateDocTitle,
  DOC_STATUSES,
  promoteToSpec,
} from "../services/documents.js";
import {
  addSection,
  updateSection,
  retitleSection,
  deleteSection,
  resolveSectionWriteMode,
} from "../services/sections.js";
import { appendQaReport } from "../services/qa-reports.js";
import {
  addClausesToSection,
  createClause,
  updateClause,
  deleteClause,
} from "../services/clauses.js";
import {
  addComment,
  addAnchoredComment,
  addDecisionComment,
  addTaskComment,
  listComments,
  listDecisionComments,
  listTaskComments,
  listCommentsForDoc,
  reviewDocComments,
  resolveComment,
  getDocForTarget,
  getDocForComment,
  type CommentExtras,
  type ListCommentsOptions,
} from "../services/comments.js";
import {
  COMMENT_TYPES,
  isCommentType,
  type CommentType,
} from "../types/roles.js";
import {
  createDecision,
  listDecisions,
  resolveDecision,
  reopenDecision,
  deleteDecision,
  restoreDecision,
  updateDecisionFields,
  proposeDecision,
  approveDecision,
  rejectDecision,
  type DecisionOption,
  type UpdateDecisionFields,
} from "../services/decisions.js";
import {
  createAc,
  listAcsForBrief,
  listAcsForBriefWithVerification,
  listResolvedDecisionImplAcCoverage,
  getAc as getAcById,
  updateAc,
  deleteAc,
  acceptAc,
  rejectAc,
  linkAcToParent,
  listTestEventDigestForAc,
  softHideTestEventsForAc,
  restoreTestEventsForAc,
  type Ac,
  type AcKind,
  type AcStatus,
  type AcWithVerification,
} from "../services/acs.js";
import { listTopics, fetchTopic } from "../services/guidance.js";
import { mintEphemeralEmissionKey } from "../services/emission-keys.js";
import {
  createTask,
  listTasks,
  getTask,
  updateTaskStatus,
  updateTask,
  deleteTask,
  getReadyTasks,
} from "../services/tasks.js";
import type { RequestCtx } from "../services/mutate.js";
import { listActivityView } from "../services/activity-view.js";
import { resolveTestEventActors } from "../services/who-resolver.js";
import { stripUuids, containsUuid } from "../services/shared/identifiers.js";
import { listPresent } from "../services/presence.js";
import {
  createIssue,
  listIssuesForSpec,
  getIssue as getIssueById,
  updateIssue,
  updateIssueStatus,
  convertIssueToTask,
  kickTaskToIssue,
  markIssuePromoted,
  ISSUE_TYPES,
  ISSUE_STATUSES,
  isIssueType,
  type IssueType,
  type IssueStatus,
} from "../services/issues.js";
import {
  promoteToEditor,
  demoteToReviewer,
  resolveRole,
  listEditors,
  type DocRole,
} from "../services/doc-members.js";
import { assign, unassign } from "../services/doc-assignees.js";
import { getUserByEmail, getUserById } from "../services/users.js";
import { addBlocker, removeBlocker } from "../services/shared/blockers.js";
import {
  applyTagString,
  removeTagString,
  listDocTags,
  parseTagInput,
  formatTag,
  type ParsedTag,
} from "../services/tags.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import {
  formatFullDocState,
  formatSpecGuidanceBody,
  formatDocList,
  formatComment,
  formatCommentList,
  formatDocComments,
  formatReviewComments,
  formatReadyTasks,
  formatDocStatusHeader,
  formatSpecList,
  formatPromotedSpec,
  formatStandard,
  renderStandardSectionBody,
  formatTerseSpecPhase,
  type InjectedBlock,
} from "../mcp/formatters.js";
import { buildSketchBlock, type SketchAc } from "../mcp/ac-test-sketch.js";
import { getStandard, flagDrift, proposeStandardChange } from "../services/standards.js";
import { buildDocExportForm } from "../services/doc-export.js";
import { getDiscordWebhook, postToDiscord } from "../services/discord-webhook.js";
import { getSlackClientForUser, SlackClientError } from "../services/.ee/slack/client.js";
import { resolveSlackUser, SlackUserResolutionError } from "../services/.ee/slack/users.js";
import { getSlackBotUserId } from "../services/.ee/slack/oauth.js";
import { getOrgIdForMemex } from "../services/memexes.js";
import { markdownToMrkdwn } from "../services/slack-markdown.js";
import { buildTenantUrl } from "../services/shared/tenant-url.js";
import { listOrgScaffoldAdditionsCached } from "../services/scaffold-additions-cache.js";
import { filterOrgBlocksForMemex } from "../services/scaffold-additions.js";
import {
  searchMemex,
  formatSearchResults,
  type MemexSearchKind,
} from "../services/memex-search.js";
import { resolveEmbeddingProvider } from "../services/embedding-provider.js";
import {
  assessPhaseTransition,
  formatPhaseAssessment,
  isPhaseTarget,
} from "../services/phase-assessment.js";
import {
  toolManifest,
  BASE_SCAFFOLD,
  HANDOFF_BUTTON_BY_PHASE,
  toButtonPrompt,
  toHandoffEssence,
  GET_PROMPT_PROSE,
  timeAgo,
  capitalizeDisplayName,
  type Phase,
  type GuidanceBlock,
} from "@memex/shared";
import { claimFullHandoffDelivery } from "../services/handoff-delivery.js";
import {
  assessNarrativeFreshness,
  markNarrativeConsolidated,
} from "../services/narrative.js";
import { assessCommentsStatus } from "../services/comment-assessment.js";

// ══════════════════════════════════════
// spec-366 (sol-1): handler infra now lives in ./handlers/shared.ts.
// This file is the tool CATALOGUE — it wires each ToolSpec to its handler.
// ══════════════════════════════════════

import {
  COMMENT_TYPE_DESC,
  COMPLETION_NUDGE,
  MEMEX_DESC,
  TASK_STATUS,
  VERBOSE_FIELD,
  buildNudgeOrgBlocksGetter,
  buildStandardCommentRef,
  composeGuidanceEnvelope,
  composeStatusOverview,
  craftActivityBlock,
  findNewlyUnblockedDependents,
  formatAcCoverageSummary,
  formatDocCommentsTerse,
  formatState,
  formatTaskReadyMarker,
  formatTerseComment,
  fullDocState,
  handoffInterpolationContext,
  isDocLikeKind,
  loadSpec,
  parseTypeFilter,
  relatedIssuesForDecision,
  relatedIssuesNudge,
  renderFooterSignal,
  reqCtx,
  resolveRefArg,
  resolveStandardSectionRef,
  resolveUserArg,
  suggestActiveSpecsForIssue,
  verificationStateForAc,
  type EntityKind,
  type FooterSlot,
  type ResolvedRef,
  type StatusFacts,
  type ToolCtx,
  type ToolSpec,
} from "./handlers/shared.js";

// spec-366: re-export the shared infra symbols external modules/tests import
// from this file, so no import site moved (std-16 contract unchanged).
export {
  composeGuidanceEnvelope,
  craftActivityBlock,
  composeStatusOverview,
  formatAcCoverageSummary,
  relatedIssuesForDecision,
  relatedIssuesNudge,
  suggestActiveSpecsForIssue,
  buildNudgeOrgBlocksGetter,
  COMPLETION_NUDGE,
  // spec-366: re-exported because tool-specs.audit.integration.test.ts imports
  // VERBOSE_FIELD from here to assert the shared-instance identity contract.
  VERBOSE_FIELD,
  MEMEX_DESC,
} from "./handlers/shared.js";
export type {
  ToolCtx,
  ToolSpec,
  ResolvedRef,
  EntityKind,
  FooterSlot,
  StatusFacts,
} from "./handlers/shared.js";

export const toolSpecs: ToolSpec[] = [
  // ── On-demand operating guidance ──────────────────────────
  // The MCP `instructions` field is truncated by Claude Code at 2 KB (per
  // Anthropic's official docs at https://code.claude.com/docs/en/mcp), so
  // the bulk of operating guidance is delivered via this tool instead.
  // Topics are JSON files in packages/server/src/guidance/ — drop one in,
  // it appears automatically in the index.
  {
    name: "get_information",
    annotations: { title: "Fetch operating guidance", readOnlyHint: true, destructiveHint: false },
    description:
      "Fetch on-demand operating guidance for working with Memex. The session-init prompt is intentionally minimal; most depth lives here. " +
      "Call with no arguments to get the topic index — each entry shows when to read that topic. " +
      "Call with `topic='<slug>'` to fetch the full body of one topic. " +
      "You MUST call this with `topic='ac-emission'` before writing any test during build — the test-tagging mechanism is silent and undetectable from the agent's side if skipped; the cost of getting it wrong is every implementation AC staying silently unverified. " +
      "Consult it for any topic referenced by other tools' descriptions or responses.",
    schema: {
      topic: z.string().optional().describe(
        "Slug of a topic to fetch (e.g. 'ac-emission', 'phases', 'decisions-vs-tasks'). Omit to get the topic index.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input) {
      const topic = input.topic as string | undefined;
      if (!topic) {
        const index = await listTopics();
        if (index.length === 0) {
          return "No guidance topics published yet.";
        }
        const lines = [
          "Available guidance topics. Call get_information(topic='<slug>') to fetch one.",
          "",
        ];
        for (const t of index) {
          lines.push(`- **${t.topic}** — ${t.title}`);
          if (t.whenToRead) lines.push(`  _When to read:_ ${t.whenToRead}`);
        }
        return lines.join("\n");
      }
      const t = await fetchTopic(topic);
      return `# ${t.title}\n\n_When to read:_ ${t.whenToRead}\n\n${t.body}`;
    },
  },

  // ── Doc CRUD ──────────────────────────────────────────────
  {
    name: "list_docs",
    annotations: { title: "List documents", readOnlyHint: true, destructiveHint: false },
    description:
      "List active Specs in a Memex with decision/task counts and lineage. Active means status in specify/build/verify; paused/archived/draft/done are hidden. Pass `docType` to filter by document type (defaults to 'spec'). Pass `tags` to narrow to Specs carrying the given tags — facet semantics: AND across different scopes, OR within one scope.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      docType: z
        .string()
        .optional()
        .describe(
          "Document type filter. Defaults to 'spec'. Other values (e.g. 'standard', 'document', 'execution_plan') filter directly.",
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "Tag filter — array of `scope::value` (e.g. `priority::high`) or flat (e.g. `bug`) strings. " +
            "AND across distinct scopes, OR within a single scope; each flat tag is its own AND clause.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const docTypeArg = (input.docType as string | undefined) ?? "spec";
      const tagFilter = input.tags as string[] | undefined;
      const memexId = await ctx.resolveMemex(memex);

      // Parse each `scope::value` string into the structured ParsedTag the
      // listDocs facet filter expects (parseTagInput validates + splits on the
      // first `::`). Empty/whitespace entries throw — surfaced as a
      // ValidationError at the boundary rather than silently dropped.
      const parsedTags: ParsedTag[] | undefined =
        tagFilter && tagFilter.length > 0 ? tagFilter.map(parseTagInput) : undefined;

      const docs = await listDocs(memexId, {
        docType: docTypeArg,
        includePaused: false,
        statusIn: ["specify", "build", "verify"],
        // spec-178 t-11 / dec-11 (ac-37): the MCP/agent enumeration must NOT
        // surface handhold demo specs. The REST board route omits this flag so
        // its cards still show demo specs (with the DEMO badge); only this
        // agent-facing list path opts into the exclusion.
        excludeDemo: true,
        ...(parsedTags ? { tags: parsedTags } : {}),
      });

      if (ctx.verbose) {
        const url = await ctx.workspaceUrl(memexId);
        return formatSpecList(docs, url);
      }

      if (docs.length === 0) return "No active specs in this Memex.";
      const slugs = await memexSlugsById(memexId);
      const enriched = await Promise.all(
        docs.map(async (d) => {
          const [decs, ts] = await Promise.all([
            listDecisions(memexId, d.id),
            listTasks(memexId, d.id),
          ]);
          return { d, decisionCount: decs.length, taskCount: ts.length };
        }),
      );
      return enriched
        .map(({ d, decisionCount, taskCount }) => {
          const ref = slugs ? buildDocRef(slugs, d) : d.handle;
          return `- ref: ${ref} [${d.docType}, ${d.status}] "${d.title}" (${decisionCount} decisions, ${taskCount} tasks)`;
        })
        .join("\n");
    },
  },
  {
    name: "get_doc",
    annotations: { title: "Get document", readOnlyHint: true, destructiveHint: false },
    description:
      "Get a document with all its sections, decisions, tasks, comments, and blockers. Returns the full picture: content, decision statuses, task readiness, and phase-aware guidance. The response includes the public URL — no separate get_doc_url call needed.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the document, e.g. `mindset/main/specs/spec-3` or `mindset/main/docs/doc-16`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `get_doc expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      if (ctx.verbose) {
        const url = await ctx.workspaceUrl(memexId);
        if (doc.docType === "standard") {
          const standard = await getStandard(memexId, doc.id);
          return formatStandard(standard, url);
        }
        const state = await fullDocState(memexId, doc.id);
        // spec-219 ac-10 / dec-4: the AC-coverage header is NO LONGER injected
        // here. The single seat (`composeGuidanceEnvelope`) composes it — verbose
        // AND get_doc only — and the choke point (`runToolWithSpecTraffic`)
        // prepends it above the body. Centralizing both header and footer in the
        // one seat is the whole point (ac-6); this handler renders only the body.
        return await formatState(url, state, ctx);
      }

      // Terse: agent already has the doc context injected by the system
      // prompt; this is for the rare case it explicitly asks. Carries the
      // canonical ref so a follow-up tool call can use it directly.
      const docRef = buildDocRef(slugs, doc);
      if (doc.docType === "standard") {
        const standard = await getStandard(memexId, doc.id);
        const header = `ref: ${docRef} "${standard.title}" (status=${standard.status}, ${standard.driftCount} open drift)`;
        const sectionLines = standard.sections
          .map((s) => {
            const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: s.seq });
            const body = renderStandardSectionBody(
              s.content,
              standard.clauses.filter((c) => c.sectionId === s.id),
            );
            return `## ${s.title ?? s.sectionType} [${s.sectionType}] (ref: ${sectionRef})\n${body}`;
          })
          .join("\n\n");
        return `${header}\n\n${sectionLines}`;
      }
      // spec-136 t-4: surface the Spec's tags inline even in the terse shape so
      // get_doc always returns them (the verbose path renders them via formatState).
      const docTags = await listDocTags(memexId, doc.id);
      const tagSuffix =
        docTags.length > 0 ? ` Tags: ${docTags.map(formatTag).join(", ")}.` : "";
      return `ref: ${docRef} "${doc.title}" [${doc.docType}, ${doc.status}].${tagSuffix}`;
    },
  },
  {
    // spec-263 — the phase handoff prompt, fetched from inside the coding
    // session. Same scaffold node, same composition path, same Org appends as
    // the web UI's copy-prompt button: the two surfaces cannot drift (std-23).
    name: "get_prompt",
    annotations: { title: "Get handoff prompt", readOnlyHint: true, destructiveHint: false },
    description:
      "Get the handoff prompt for a Spec's CURRENT phase — the exact text the web UI's copy-prompt button produces (specify → plan handoff, build → build handoff, verify → verify handoff), composed from the shared Scaffold with your Org's additions included. " +
      "Call it after orienting on a Spec or right after a phase transition, when you need the full handoff prompt to act on. " +
      "Phases with no handoff (draft, done) return an explanation, never an error. Spec-only.",
    schema: {
      ref: z
        .string()
        .describe("Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `get_prompt expects a doc-level Spec ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc } = resolved;
      if (doc.docType !== "spec") {
        throw new ValidationError(
          `get_prompt expects a Spec; ${doc.handle} is a ${doc.docType}. Handoff prompts exist only on Specs.`,
        );
      }
      // dec-1: select for the CURRENT phase through the SAME map the UI copy
      // button and the footer essence select through (spec-203 dec-1) — node
      // selection is single-source by construction. draft/done carry no node;
      // explain, never throw or return empty (ac-7 / scope ac-4).
      const phase = doc.status as Phase;
      const buttonId = HANDOFF_BUTTON_BY_PHASE[phase];
      if (!buttonId) return GET_PROMPT_PROSE.noHandoff(phase);
      const baseUrl = await ctx.workspaceUrl(memexId);
      const context = handoffInterpolationContext(baseUrl, doc);
      if (!context) return GET_PROMPT_PROSE.noContext;
      // dec-2: Org appends ride the composition, so the returned text is
      // byte-identical to the UI button's clipboard output (PromptButton.tsx
      // threads orgBlocks the same way).
      const orgBlocks = ctx.getOrgBlocksForNudge
        ? await ctx.getOrgBlocksForNudge()
        : undefined;
      const prompt = toButtonPrompt({
        dataset: BASE_SCAFFOLD,
        buttonId,
        context,
        orgBlocks,
      });
      if (prompt === null) {
        // Unreachable while every HANDOFF_BUTTON_BY_PHASE id has a node in
        // BASE_SCAFFOLD (pinned by shared tests) — a missing node is scaffold
        // corruption, not a caller error.
        throw new Error(`No PromptButtonNode found for buttonId="${buttonId}".`);
      }
      return prompt;
    },
  },
  {
    name: "export_doc",
    annotations: { title: "Export document (lossless markdown)", readOnlyHint: true, destructiveHint: false },
    description:
      "spec-100 §4: export a spec as lossless markdown with every comment thread expanded inline at its anchor position (HTML-comment-delimited block-quotes). Floating comments are appended per section. This is the form to paste into an external LLM/editor, or hand to a colleague, without losing the conversation. `ref` is a doc-level canonical ref.",
    schema: {
      ref: z
        .string()
        .describe("Canonical ref to the document to export, e.g. `mindset/main/specs/spec-3`."),
      // Carried for parity with the shared verbose contract (doc-20 t-10): every
      // tool exposes VERBOSE_FIELD by identity. export_doc is always lossless, so
      // the flag is a no-op here, but the field must be present for the audit.
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `export_doc expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      return buildDocExportForm(resolved.memexId, resolved.doc.id);
    },
  },
  {
    name: "create_doc",
    annotations: { title: "Create document", readOnlyHint: false, destructiveHint: false },
    description:
      "Create a new Spec. Pass `purpose` for the Overview narrative. Optional `decisions` seeds open decisions on creation. Optional `promoteFromTaskRef` (a canonical task ref) creates a child Spec whose parent is the task's source Spec, preserving lineage. Optional `promoteFromIssueRef` (a canonical issue ref) does the same from an Issue — the child Spec is parented to the Issue's source Spec, the Issue → converted, and it auto-resolves when the child Spec reaches done. Optional `docType` defaults to 'spec'; pass any other docType the service layer recognises ('standard', 'document', 'execution_plan'). **Run `search_memex({ query })` first** to discover whether an existing Spec, Standard, or prior Decision already covers this — surface any overlap in the confirmation before creating. " +
      "**After creating a spec in draft/specify, your next move is to create its scope acceptance criteria** via `create_ac({ ref: '<this-spec>', kind: 'scope', statement: '...' })`: plain-English statements of what 'done' looks like, which anchor every downstream decision. Create as many as genuinely capture success, usually three to six; without them the spec has no measurable success criteria.",
    schema: {
      memex: z
        .string()
        .optional()
        .describe(
          MEMEX_DESC +
            " (not needed if promoteFromTaskRef or promoteFromIssueRef is provided — the Memex is inferred from the source)",
        ),
      title: z.string().describe("Spec title (1–500 chars)."),
      purpose: z
        .string()
        .optional()
        .describe("Overview narrative. Required unless `promoteFromTaskRef` / `promoteFromIssueRef` is used."),
      docType: z
        .string()
        .optional()
        .describe(
          "Document type. Defaults to 'spec'. Pass 'standard', 'document', or 'execution_plan' to override.",
        ),
      decisions: z
        .array(
          z.object({
            title: z.string(),
            context: z.string().optional(),
          }),
        )
        .optional()
        .describe("Seed open decisions at creation."),
      promoteFromTaskRef: z
        .string()
        .optional()
        .describe(
          "Promote a task to a child Spec. Canonical task ref (e.g. `mindset/main/specs/spec-3/tasks/t-2`). Lineage preserved.",
        ),
      promoteFromIssueRef: z
        .string()
        .optional()
        .describe(
          "Promote an Issue to a child Spec. Canonical issue ref (e.g. `mindset/main/specs/spec-3/issues/issue-2`). The child Spec is parented to the Issue's SOURCE Spec (lineage preserved); the Issue → converted and auto-resolves when the child Spec reaches done.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const args = input as {
        memex?: string;
        title: string;
        purpose?: string;
        docType?: string;
        decisions?: Array<{ title: string; context?: string }>;
        promoteFromTaskRef?: string;
        promoteFromIssueRef?: string;
      };

      if (args.promoteFromIssueRef) {
        const resolved = await resolveRefArg(ctx, args.promoteFromIssueRef, "promoteFromIssueRef");
        if (resolved.entity.kind !== "issue") {
          throw new ValidationError(
            `promoteFromIssueRef must resolve to an issue; got ${resolved.entity.kind}.`,
          );
        }
        // The Issue's SOURCE Spec is its parent doc (issues.doc_id → documents.id).
        // promoteToSpec parents the child Spec on it, preserving lineage (ac-23).
        const sourceDoc = resolved.doc;
        const child = await promoteToSpec(
          resolved.memexId,
          sourceDoc.id,
          args.title,
          args.purpose,
          ctx.userId,
          reqCtx(ctx),
        );
        // Issue → converted, record promoted_doc_id so the child-done hook resolves
        // it later (ac-24). NOT resolved now — only when the child Spec reaches done.
        await markIssuePromoted(resolved.memexId, resolved.entity.row.id, child.id);
        const childRef = buildDocRef(resolved.slugs, child);
        if (ctx.verbose) {
          return `Promoted Issue issue-${resolved.entity.row.seq} to child Spec ref: ${childRef} "${child.title}" (parent: ${sourceDoc.handle}). Issue → converted; auto-resolves when the child Spec reaches done.`;
        }
        return `Promoted issue issue-${resolved.entity.row.seq} to Spec ref: ${childRef} "${child.title}".`;
      }

      if (args.promoteFromTaskRef) {
        const resolved = await resolveRefArg(ctx, args.promoteFromTaskRef, "promoteFromTaskRef");
        if (resolved.entity.kind !== "task") {
          throw new ValidationError(
            `promoteFromTaskRef must resolve to a task; got ${resolved.entity.kind}.`,
          );
        }
        const item = await getTask(resolved.memexId, resolved.entity.row.id);
        const sourceDoc = resolved.doc;
        const child = await promoteToSpec(
          resolved.memexId,
          sourceDoc.id,
          args.title,
          args.purpose,
          ctx.userId,
          reqCtx(ctx),
        );
        if (ctx.verbose) {
          const url = await ctx.workspaceUrl(resolved.memexId);
          return formatPromotedSpec(child, sourceDoc, item, url);
        }
        const childRef = buildDocRef(resolved.slugs, child);
        return `Promoted task t-${item.seq} to Spec ref: ${childRef} "${child.title}".`;
      }

      const memexId = await ctx.resolveMemex(args.memex);
      if (!args.purpose) {
        throw new ValidationError("create_doc requires `purpose` (Overview narrative).");
      }
      // Default to canonical 'spec' for callers that don't pass an explicit
      // docType.
      const docType = args.docType ?? "spec";
      // spec-295 dec-3: the web agent (in_app_agent channel — the creation
      // modal + the in-app spec agent) no longer auto-advances phase, so a new
      // Spec can't rely on draft→specify traffic to become team-visible. Place
      // it in `specify` deterministically at creation instead. Only Specs get a
      // phase (standards/documents have their own status lifecycle); the mcp
      // surface keeps 'draft' (it still auto-advances).
      const initialStatus =
        docType === "spec" && ctx.channel === "in_app_agent" ? "specify" : undefined;
      const doc = await createDocDraft(
        memexId,
        args.title,
        args.purpose,
        docType,
        args.decisions,
        initialStatus ? { initialStatus } : undefined,
        ctx.userId,
        reqCtx(ctx),
      );
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const slugs = await memexSlugsById(memexId);
      const docRef = slugs ? buildDocRef(slugs, doc) : doc.handle;
      // spec-219 Phase 2 (sole-author): create_doc resolves no ref, so the choke
      // never set a target. Record the just-created doc so composeGuidanceEnvelope
      // runs for it (like every other Spec-resolving tool), and signal the event
      // — the activation-moment scope-AC / standard-clauses guidance is authored
      // by composeGuidanceEnvelope, not here.
      ctx.recordCreatedDoc?.(memexId, doc.id);
      if (ctx.footerSlot) {
        ctx.footerSlot.signal = { kind: "doc_created", docRef, docType };
      }
      return `Spec created: ref: ${docRef} "${doc.title}".`;
    },
  },
  {
    name: "update_doc",
    annotations: { title: "Update document", readOnlyHint: false, destructiveHint: false },
    description:
      "Update a document's status, title, and/or tags. Pass only the fields you want to change. " +
      "**status** transitions a Spec through draft → specify → build → verify → done; backward moves and pauses are supported. Run `assess_spec({mode:'phase', target:<phase>})` BEFORE any forward Spec transition past specify — it returns the rubric + a fact sheet of open decisions / incomplete work / drift. Closing to 'done' is the user's call. " +
      "**title** renames the document (handle stays immutable). " +
      "**tags** adds tags to the Spec — array of `scope::value` (e.g. `priority::high`) or flat (e.g. `bug`) strings; a scoped tag is mutually exclusive within its scope (applying `priority::high` drops any other `priority::*`). New tags are created on first use. " +
      "**removeTags** removes the given tags from the Spec (same string form); removing a tag the Spec doesn't carry is a no-op. " +
      "Replaces update_doc_status, update_doc_title.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the document, e.g. `mindset/main/specs/spec-3` or `mindset/main/docs/doc-16`.",
        ),
      status: z.enum(DOC_STATUSES).optional().describe("New lifecycle status (spec/document)."),
      title: z.string().optional().describe("New title (1-500 chars, trimmed)."),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "Tags to ADD to the Spec — `scope::value` (e.g. `priority::high`) or flat (e.g. `bug`) strings. " +
            "Scoped tags are mutually exclusive within their scope; new tags are created on first use.",
        ),
      removeTags: z
        .array(z.string())
        .optional()
        .describe(
          "Tags to REMOVE from the Spec — same `scope::value`/flat string form. Removing an absent tag is a no-op.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const status = input.status as string | undefined;
      const title = input.title as string | undefined;
      const tagsToAdd = input.tags as string[] | undefined;
      const tagsToRemove = input.removeTags as string[] | undefined;

      const hasTagWork =
        (tagsToAdd && tagsToAdd.length > 0) || (tagsToRemove && tagsToRemove.length > 0);
      if (status === undefined && title === undefined && !hasTagWork) {
        throw new ValidationError(
          "update_doc requires at least one of: status, title, tags, removeTags.",
        );
      }
      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `update_doc expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc: before, slugs } = resolved;

      if (status !== undefined) {
        // spec-122 dec-2/dec-5: thread the activity contract (WHO + HOW) onto the
        // status transition so Pulse attributes the phase move to the human +
        // surface.
        await updateDocStatus(memexId, before.id, status, { ctx: reqCtx(ctx) });
        // spec-219 Phase 2 (sole-author): the transition guidance (assess_spec
        // tip + coverage nudge) is owned by composeGuidanceEnvelope; signal the
        // transition, don't author it here.
        if (ctx.footerSlot) {
          ctx.footerSlot.signal = {
            kind: "doc_transition",
            beforeStatus: before.status,
            target: status,
            docType: before.docType,
          };
        }
      }
      if (title !== undefined) {
        await updateDocTitle(memexId, before.id, title);
      }
      // Tag writes route through the tags service (never raw inserts): applyTagString
      // handles create-or-pick + per-scope mutual exclusivity; removeTagString resolves
      // the existing tag and drops the link (no-op if absent). Attribution: the link's
      // added_by is ctx.userId (mirrors the assign handler), and the channel records
      // the actor *kind* on the bus event → activity_log (spec-122).
      // spec-156 ac-19: derive the channel from the invoking surface instead of
      // hardcoding `mcp` — the in-app agent path sets `in_app_agent`, so Pulse
      // attributes agent-driven tagging correctly. Defaults to `mcp` for the MCP
      // surface (and any ctx that doesn't set it).
      const tagCtx = { channel: ctx.channel ?? "mcp", userId: ctx.userId };
      const appliedTags: string[] = [];
      const removedTags: string[] = [];
      if (tagsToAdd) {
        for (const raw of tagsToAdd) {
          const tag = await applyTagString(tagCtx, memexId, before.id, raw, ctx.userId);
          appliedTags.push(formatTag(tag));
        }
      }
      if (tagsToRemove) {
        for (const raw of tagsToRemove) {
          const tag = await removeTagString(tagCtx, memexId, before.id, raw);
          if (tag) removedTags.push(formatTag(tag));
        }
      }

      // One-line summary of any tag mutation, shared by both response shapes so
      // the agent learns what landed without a follow-up get_doc.
      const tagParts: string[] = [];
      if (appliedTags.length > 0) tagParts.push(`tagged ${appliedTags.join(", ")}`);
      if (removedTags.length > 0) tagParts.push(`removed ${removedTags.join(", ")}`);
      const tagSuffix = tagParts.length > 0 ? ` (${tagParts.join("; ")})` : "";

      if (ctx.verbose) {
        const state = await fullDocState(memexId, before.id);
        const url = await ctx.workspaceUrl(memexId);
        // spec-219 Phase 2 (sole-author): the transition guidance is signalled
        // above; composeGuidanceEnvelope authors it. `tagSuffix` is a FACT
        // (result-reporting), so it rides the body, not the footer.
        const body = await formatState(url, state, ctx);
        return tagSuffix ? `${body}\n${tagSuffix.trim()}` : body;
      }
      const fresh = await getDoc(memexId, before.id);
      // Per dec-1: on a status change include the deterministic phase header so
      // the agent learns the new "Allowed now" without another assess_spec.
      const phaseLine =
        status !== undefined && fresh.docType === "spec"
          ? formatTerseSpecPhase(fresh.status)
          : null;
      const phaseSuffix = phaseLine ? ` ${phaseLine}` : "";
      const freshRef = buildDocRef(slugs, fresh);
      return `ref: ${freshRef} updated.${tagSuffix}${phaseSuffix}`;
    },
  },

  // ── Section CRUD ──────────────────────────────────────────
  {
    name: "add_section",
    annotations: { title: "Add section", readOnlyHint: false, destructiveHint: false },
    description:
      "Add a new section to a document. The pair (doc, sectionType) is unique within the document — re-using an existing sectionType will fail with a constraint violation. Pick descriptive, unique identifiers on first attempt: 'design', 'architecture', 'testing', 'risks', 'rollout', 'risk-auth', or numbered variants like 'issue-1', 'issue-2'. STANDARDS are authored as clauses: for a standard pass `clauses` (an array of one-aspect clause bodies), NOT `content`; for every other doc type pass `content`. Passing the wrong one for the doc type fails with guidance toward the right field.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the parent document, e.g. `mindset/main/docs/doc-16`.",
        ),
      sectionType: z
        .string()
        .describe("Unique section identifier within the document (e.g. 'design', 'issue-1')."),
      content: z
        .string()
        .optional()
        .describe(
          "Markdown body of the new section. For NON-standard documents. Mutually exclusive with `clauses`.",
        ),
      clauses: z
        .array(z.string())
        .optional()
        .describe(
          "For STANDARDS only: the section's clauses, one self-contained aspect each, in order. A clause is a single granular rule/definition/example — not a compound paragraph. The section's content becomes these clauses joined; each gets an addressable `cl-N` handle returned in the response. Mutually exclusive with `content`.",
        ),
      title: z.string().optional().describe("Optional human-readable section heading. Falls back to sectionType. Do NOT prefix with the section number — the renderer auto-prefixes `${seq}. `. Pass just the heading, e.g. 'Grammar', not '2. Grammar'."),
      description: z.string().optional().describe("Optional free-text metadata describing the section's purpose. Travels with the section everywhere (get_doc/list_docs/section responses) and is editable later via update_section."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const sectionType = input.sectionType as string;
      const content = input.content as string | undefined;
      const clauses = input.clauses as string[] | undefined;
      const title = input.title as string | undefined;
      const description = input.description as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `add_section expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      // spec-161 doc-type gate: standards take clauses[], everything else takes content.
      const hasContent = typeof content === "string" && content.trim().length > 0;
      const hasClauses =
        Array.isArray(clauses) && clauses.some((c) => typeof c === "string" && c.trim().length > 0);
      const mode = resolveSectionWriteMode({
        isStandard: doc.docType === "standard",
        hasContent,
        hasClauses,
      });

      if (mode === "clauses") {
        // Born clause-first: create the (empty) section, then author its clauses; the
        // service regenerates content = clauses joined.
        const sectionMut = await addSection(memexId, doc.id, sectionType, "", title, description, reqCtx(ctx));
        const clauseMut = await addClausesToSection(memexId, sectionMut.id, clauses!);
        if (ctx.verbose) {
          const state = await fullDocState(memexId, doc.id);
          const url = await ctx.workspaceUrl(memexId);
          return await formatState(url, state, ctx);
        }
        const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: sectionMut.seq });
        const clauseRefs = clauseMut.map((c) => `cl-${c.seq}`).join(", ");
        return `Added "${sectionMut.title ?? sectionType}" section (ref: ${sectionRef}) with ${clauseMut.length} clause(s): ${clauseRefs}.`;
      }

      const section = await addSection(memexId, doc.id, sectionType, content!, title, description, reqCtx(ctx));
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: section.seq });
      return `Added "${section.title ?? section.sectionType}" section (ref: ${sectionRef}).`;
    },
  },
  {
    name: "write_qa_report",
    annotations: { title: "Write QA report", readOnlyHint: false, destructiveHint: false },
    description:
      "Persist a QA Report on a Spec at the build→verify hand-off — a human-readable record of what THIS build session actually changed, written for a reviewer who was not in the session (including a non-developer owner). Organise it so each audience finds its part: (1) Front-end / user-affecting changes in plain language, (2) Back-end changes (routes, schema/migrations, services, auth/tenancy, agent behaviour), (3) Testing created and run (which tests, which suites, what passed, what was skipped or left red — tie back to the Spec's ACs), (4) Known gaps & follow-ups (also captured via register_issue todos), (5) Deviations from the plan, (6) Dependencies & integration points, (7) Migration/deployment notes, (8) Open questions. Ground every claim in the changes you made this session and the tests you ran — never restate the plan. Each call APPENDS a new dated version (qa_report, qa_report-2, …); it never overwrites a prior session's report. Read-only once written.",
    schema: {
      ref: z
        .string()
        .describe("Canonical ref to the Spec the report is for, e.g. `mindset/main/specs/spec-3`."),
      content: z
        .string()
        .describe(
          "Markdown body of the report, structured into the front-end / back-end / testing / gaps / deviations / dependencies / deploy-notes / open-questions sections described above. Grounded in this session's actual changes — not a restatement of the plan.",
        ),
      title: z
        .string()
        .optional()
        .describe("Optional heading for the report row. Defaults to 'QA Report'."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const content = input.content as string;
      const title = input.title as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `write_qa_report expects a Spec ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      if (doc.docType !== "spec") {
        throw new ValidationError(
          "QA Reports attach to Specs only — pass a `spec-N` ref.",
        );
      }

      const section = await appendQaReport(memexId, doc.id, content, title, reqCtx(ctx));
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: section.seq });
      return `Wrote QA Report "${section.sectionType}" (ref: ${sectionRef}) for ${doc.handle}. Each build session appends a new version — prior reports are preserved.`;
    },
  },
  {
    name: "update_section",
    annotations: { title: "Update section", readOnlyHint: false, destructiveHint: false },
    description: "Update the content of a document section, and optionally its writable metadata (`sectionType` machine key and free-text `description`). Returns the full document state. A `sectionType` collision with another section on the same document fails with a readable error (pick a different identifier).",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the section, e.g. `mindset/main/docs/doc-16/sections/s-3`.",
        ),
      content: z.string().describe("New markdown body, replacing the existing content."),
      sectionType: z
        .string()
        .optional()
        .describe("Optional new machine key for the section. Omit to keep the existing key. Must be unique within the document."),
      description: z
        .string()
        .optional()
        .describe("Optional free-text metadata describing the section's purpose. Omit to leave it unchanged."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const content = input.content as string;
      const sectionType = input.sectionType as string | undefined;
      const description = input.description as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "section") {
        throw new ValidationError(
          `update_section expects a section ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      // spec-161: standards are edited at the clause grain, not as prose blobs.
      if (doc.docType === "standard") {
        throw new ValidationError(
          "Standards are edited at the clause grain. Use add_clause / edit_clause / delete_clause, not update_section.",
        );
      }
      const section = await updateSection(memexId, entity.row.id, content, { sectionType, description }, reqCtx(ctx));
      if (ctx.verbose) {
        const state = await fullDocState(memexId, section.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: section.seq });
      return `Section updated (ref: ${sectionRef}).`;
    },
  },
  // ── Clause CRUD (standards only) ──────────────────────────
  {
    name: "add_clause",
    annotations: { title: "Add clause", readOnlyHint: false, destructiveHint: false },
    description:
      "Append a clause to a STANDARD section (or insert at a position). A clause is one self-contained aspect — a single rule, definition, or example, not a compound paragraph. Standards only: for other doc types edit the section body with update_section. The new clause gets an allocate-once cl-N handle, returned in the response.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the standard SECTION the clause belongs to, e.g. `mindset/main/standards/std-7/sections/s-2`.",
        ),
      body: z.string().describe("The clause body — one self-contained aspect, markdown."),
      position: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based display position to insert at; omit to append at the end."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const body = input.body as string;
      const position = input.position as number | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "section") {
        throw new ValidationError(
          `add_clause expects a standard section ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      if (doc.docType !== "standard") {
        throw new ValidationError(
          "Only standards have clauses. Use update_section to edit this document's section body.",
        );
      }
      const clause = await createClause(memexId, entity.row.id, body, position);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const clauseRef = buildChildRef(slugs, doc, { type: "clauses", seq: clause.seq });
      return `Added clause cl-${clause.seq} (ref: ${clauseRef}).`;
    },
  },
  {
    name: "edit_clause",
    annotations: { title: "Edit clause", readOnlyHint: false, destructiveHint: false },
    description:
      "Edit a STANDARD clause's body by its cl-N ref. Standards only. The section's content (the join of its clauses) is regenerated; the clause keeps its cl-N identity.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the clause, e.g. `mindset/main/standards/std-7/clauses/cl-12`.",
        ),
      body: z.string().describe("New clause body — one self-contained aspect, markdown."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const body = input.body as string;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "clause") {
        throw new ValidationError(
          `edit_clause expects a clause ref (cl-N); got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const clause = await updateClause(memexId, entity.row.id, body);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const clauseRef = buildChildRef(slugs, doc, { type: "clauses", seq: clause.seq });
      return `Clause cl-${clause.seq} updated (ref: ${clauseRef}).`;
    },
  },
  {
    name: "delete_clause",
    annotations: { title: "Delete clause", readOnlyHint: false, destructiveHint: false },
    description:
      "Soft-delete a STANDARD clause by its cl-N ref. The cl-N is frozen (never reused) and siblings are NOT resequenced; the section content is regenerated without it. Standards only.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the clause, e.g. `mindset/main/standards/std-7/clauses/cl-12`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "clause") {
        throw new ValidationError(
          `delete_clause expects a clause ref (cl-N); got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, entity } = resolved;
      const clause = await deleteClause(memexId, entity.row.id);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      return `Clause cl-${clause.seq} deleted.`;
    },
  },
  {
    name: "retitle_section",
    annotations: { title: "Retitle section", readOnlyHint: false, destructiveHint: false },
    description:
      "Change a section's heading (and, optionally, its machine key). Sets `title` to the new heading; pass `sectionType` to also rekey the section's identifier. Content is left untouched — use `update_section` for body edits. A `sectionType` collision with another section on the same document fails with a readable error (pick a different identifier). Do NOT prefix the title with the section number — the renderer auto-prefixes `${seq}. `.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the section, e.g. `mindset/main/specs/spec-3/sections/s-3`.",
        ),
      title: z.string().describe("New human-readable heading. Pass just the heading, e.g. 'Considerations', not '3. Considerations'."),
      sectionType: z
        .string()
        .optional()
        .describe("Optional new machine key. Omit to keep the existing key and change only the heading. Must be unique within the document."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const title = input.title as string;
      const sectionType = input.sectionType as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "section") {
        throw new ValidationError(
          `retitle_section expects a section ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const section = await retitleSection(memexId, entity.row.id, title, sectionType);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, section.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: section.seq });
      return `Section retitled to "${section.title}" (ref: ${sectionRef}).`;
    },
  },
  {
    name: "delete_section",
    // Soft-delete (→ status=deleted), reversible — so NOT destructive in the
    // irreversible sense, matching delete_decision's annotation.
    annotations: { title: "Delete section", readOnlyHint: false, destructiveHint: false },
    description:
      "Soft-delete a section: transitions it to status `deleted`. Deleted sections are hidden from `get_doc`, list/render paths, and search, but remain restorable to their prior status. The remaining sections resequence so their numbers stay contiguous (no gap). Anchored comments stay attached to the deleted section (they reappear on restore); any `tasks.section_ref` pointing at it dangles harmlessly as free text. Use this to clean up a stale or superseded section during a recut.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the section to delete, e.g. `mindset/main/specs/spec-3/sections/s-4`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "section") {
        throw new ValidationError(
          `delete_section expects a section ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const section = await deleteSection(memexId, entity.row.id);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, section.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: section.seq });
      return `Section deleted (ref: ${sectionRef}) "${section.title ?? section.sectionType}". Remaining sections resequenced.`;
    },
  },

  // ── Decision CRUD + named verbs ───────────────────────────
  {
    name: "create_decision",
    annotations: { title: "Create decision", readOnlyHint: false, destructiveHint: false },
    description:
      "Create a new decision on a document. Pass `status: 'candidate'` (with `options`) to record an agent-extracted candidate awaiting human review (replaces propose_decision). Default `status: 'open'` is for human-authored decisions that immediately block tasks. **Decision-in-disguise check**: if the user's message articulates multiple options + trade-offs + a pending choice, prefer status='candidate' so a reviewer approves explicitly.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the parent document, e.g. `mindset/main/specs/spec-3`.",
        ),
      title: z.string().describe("The question or choice to be made"),
      context: z.string().optional().describe("Options, trade-offs, and background"),
      status: z
        .enum(["open", "candidate"])
        .optional()
        .describe(
          "Decision status — 'open' (default, human-authored) or 'candidate' (agent-extracted, awaits approve_candidate / reject_candidate).",
        ),
      options: z
        .array(
          z.object({
            label: z.string(),
            trade_offs: z.string().describe("Trade-offs / consequences of this option"),
          }),
        )
        .optional()
        .describe("Structured options. Strongly recommended for status='candidate'."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const title = input.title as string;
      const context = input.context as string | undefined;
      const status = input.status as "open" | "candidate" | undefined;
      const options = input.options as DecisionOption[] | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `create_decision expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      if (status === "candidate") {
        const decision = await proposeDecision(memexId, doc.id, {
          title,
          context: context ?? null,
          options,
          source: "agent",
        });
        if (ctx.verbose) {
          const state = await fullDocState(memexId, doc.id);
          const url = await ctx.workspaceUrl(memexId);
          return await formatState(url, state, ctx);
        }
        const optCount = Array.isArray(decision.options) ? decision.options.length : 0;
        const decRef = buildChildRef(slugs, doc, { type: "decisions", seq: decision.seq });
        return `Candidate decision proposed: ref: ${decRef} "${decision.title}" (${optCount} options).`;
      }

      const decision = await createDecision(memexId, doc.id, title, context, "human", reqCtx(ctx));
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const decRef = buildChildRef(slugs, doc, { type: "decisions", seq: decision.seq });
      // spec-112 (ac-4 / ac-15): at decision creation, auto-surface related
      // Issues whose semantic overlap with the decision (title + context)
      // clears the relevance threshold. Same searchMemex(kind:'issue')
      // machinery as resolve_decision; informational only, never blocks. Below
      // threshold this appends nothing.
      const issueHits = await relatedIssuesForDecision(
        memexId,
        `${decision.title}\n\n${context ?? ""}`,
        resolveEmbeddingProvider(),
      );
      // spec-219 Phase 2 (sole-author): hand the data to composeGuidanceEnvelope;
      // it authors the related-issues nudge. No guidance crafted here.
      if (ctx.footerSlot) {
        ctx.footerSlot.signal = { kind: "decision_created", issueHits };
      }
      return `Decision created: ref: ${decRef} "${decision.title}"`;
    },
  },
  {
    name: "update_decision",
    annotations: { title: "Update decision", readOnlyHint: false, destructiveHint: false },
    description:
      "Three modes, all invoked via this one tool:\n" +
      "  1. **Edit-in-place** (no `status` arg): mutate `title`, `context`, " +
      "`resolution`, and/or `chosenOptionIndex` on a decision. Status is " +
      "unchanged. Use this to tighten resolution wording on a resolved " +
      "decision without forcing the Spec back to specify.\n" +
      "  2. **Reopen** (`status: 'open'` from a resolved decision): reopens it so it " +
      "can be re-resolved. Stash the prior resolution as 'Proposed: …'. Use " +
      "this when the choice itself is being reconsidered, not when the wording " +
      "needs polish.\n" +
      "  3. **Restore** (`status: 'open'|'resolved'|'candidate'|'rejected'` from a " +
      "deleted decision): transitions a soft-deleted decision back to the requested " +
      "status (b-97). The captured `previousStatus` drives the default target in the " +
      "Deleted tab.\n" +
      "Cannot combine modes in one call; pick the verb that matches intent. For new " +
      "resolutions use the named verb `resolve_decision`. To soft-delete use `delete_decision`.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the decision, e.g. `mindset/main/specs/spec-3/decisions/dec-2`.",
        ),
      status: z
        .enum(["open", "resolved", "candidate", "rejected"])
        .optional()
        .describe(
          "Target status. Omit for edit-in-place. From a resolved decision only `open` is accepted (reopen). From a deleted decision any of {open, resolved, candidate, rejected} restores the decision to that state. Use `delete_decision` to move to `deleted`; `resolve_decision` / `approve_candidate` / `reject_candidate` for first-time transitions.",
        ),
      title: z.string().optional().describe("New title (edit-in-place mode)."),
      context: z
        .string()
        .nullable()
        .optional()
        .describe("New context, or null to clear it (edit-in-place mode)."),
      resolution: z
        .string()
        .optional()
        .describe(
          "New resolution prose. May not be empty on a resolved decision (reopen first to drop the resolution).",
        ),
      chosenOptionIndex: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Zero-based index into the decision's options (edit-in-place mode)."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const target = input.status as
        | "open"
        | "resolved"
        | "candidate"
        | "rejected"
        | undefined;
      const fields: UpdateDecisionFields = {};
      if (typeof input.title === "string") fields.title = input.title;
      if (input.context !== undefined) fields.context = input.context as string | null;
      if (typeof input.resolution === "string") fields.resolution = input.resolution;
      if (typeof input.chosenOptionIndex === "number") {
        fields.chosenOptionIndex = input.chosenOptionIndex;
      }
      const hasEditFields = Object.keys(fields).length > 0;

      if (target && hasEditFields) {
        throw new ValidationError(
          "update_decision: cannot combine a status transition with field edits in one call; pick one mode.",
        );
      }
      if (!target && !hasEditFields) {
        throw new ValidationError(
          "update_decision requires either status (open/resolved/candidate/rejected to transition) or one of: title, context, resolution, chosenOptionIndex.",
        );
      }

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "decision") {
        throw new ValidationError(
          `update_decision expects a decision ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const current = entity.row.status;

      let updated;
      let mode: "reopened" | "restored" | "updated";
      if (target) {
        // Status-transition mode. Reopen (resolved → open) and restore
        // (deleted → any of the four live statuses) are the two supported
        // transitions. Anything else is a usage error — the caller should
        // be using `resolve_decision`, `approve_candidate`,
        // `reject_candidate`, or `delete_decision` instead.
        if (current === "resolved" && target === "open") {
          updated = await reopenDecision(memexId, entity.row.id);
          mode = "reopened";
        } else if (current === "deleted") {
          updated = await restoreDecision(memexId, entity.row.id, target);
          mode = "restored";
        } else {
          throw new ValidationError(
            `update_decision cannot transition a ${current} decision to ${target}. ` +
              `Use resolve_decision / approve_candidate / reject_candidate / delete_decision for first-time transitions.`,
          );
        }
      } else {
        // Edit-in-place mode.
        updated = await updateDecisionFields(memexId, entity.row.id, fields);
        mode = "updated";
      }

      if (ctx.verbose) {
        const state = await fullDocState(memexId, updated.docId);
        const url = await ctx.workspaceUrl(memexId);
        return formatState(url, state);
      }
      const decRef = buildChildRef(slugs, doc, { type: "decisions", seq: updated.seq });
      // Response shape mirrors what callers parse (`^Decision <verb>: ref: ...`).
      // The status tag at the end is the b-65 contract for edit-in-place output;
      // restore mode appends the new status too so a caller can tell what state
      // the decision ended up in.
      if (mode === "reopened") {
        return `Decision reopened: ref: ${decRef} "${updated.title}"`;
      }
      if (mode === "restored") {
        return `Decision restored: ref: ${decRef} "${updated.title}" [${updated.status}]`;
      }
      return `Decision updated: ref: ${decRef} "${updated.title}" [${updated.status}]`;
    },
  },
  {
    name: "delete_decision",
    // Soft-delete (→ status=deleted), reversible via update_decision — so NOT
    // destructive in the irreversible sense (cf. delete_task / delete_ac which
    // are hard deletes). Matches the tool-annotations DESTRUCTIVE matrix.
    annotations: { title: "Delete decision", readOnlyHint: false, destructiveHint: false },
    description:
      "Soft-delete a decision: transitions it to status `deleted`. Deleted decisions are hidden from `get_doc`, the default `list_decisions` API, and the Open/Resolved/Candidate tabs in the UI, but remain queryable via `?include=deleted` so a Deleted tab can surface them for review. There is NO hard delete — `update_decision({ref, status: 'open'|'resolved'|'candidate'|'rejected'})` restores a deleted decision to the requested status. Use this when a decision was created in error (wrong title, wrong options, third attempt at the same question) and is cluttering the spec read view (b-97).",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the decision to delete, e.g. `mindset/main/specs/b-3/decisions/dec-2`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "decision") {
        throw new ValidationError(
          `delete_decision expects a decision ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const decision = await deleteDecision(memexId, entity.row.id);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, decision.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const decRef = buildChildRef(slugs, doc, { type: "decisions", seq: decision.seq });
      return `Decision deleted: ref: ${decRef} "${decision.title}". Restore with update_decision({ref, status: '${decision.previousStatus ?? "open"}'}).`;
    },
  },
  {
    name: "resolve_decision",
    annotations: { title: "Resolve decision", readOnlyHint: false, destructiveHint: false },
    description:
      "Resolve a decision with an explanation of the choice made. May unblock tasks waiting on it. Resolving the last open decision on a Spec in 'specify' unblocks the move to 'build'. If the decision has structured options, pass `chosenOptionIndex` to mark which one was selected — `resolution` is then optional and defaults to that option's label. Re-resolving an already-resolved decision updates the choice in place (spec-247 dec-5).",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the decision, e.g. `mindset/main/specs/spec-3/decisions/dec-2`.",
        ),
      resolution: z
        .string()
        .optional()
        .describe(
          "The resolution — what was decided and why. Optional when chosenOptionIndex is supplied (defaults to the chosen option's label); required otherwise.",
        ),
      chosenOptionIndex: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Zero-based index of the chosen option (only valid if the decision has structured options).",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolution = input.resolution as string;
      const chosenOptionIndex = input.chosenOptionIndex as number | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "decision") {
        throw new ValidationError(
          `resolve_decision expects a decision ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const decision = await resolveDecision(memexId, entity.row.id, resolution, chosenOptionIndex, reqCtx(ctx));
      if (ctx.verbose) {
        const state = await fullDocState(memexId, decision.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      // Per dec-1 of doc-20: if this was the last open decision on a Spec
      // in 'specify', surface the unblocked phase move so the agent doesn't have
      // to call assess_spec to discover it.
      let hint = "";
      if (doc.docType === "spec" && doc.status === "specify") {
        const remaining = await listDecisions(memexId, decision.docId);
        const stillOpen = remaining.filter((d) => d.status === "open");
        if (stillOpen.length === 0) {
          hint = " This was the last open decision; Spec can move to build.";
        }
      }
      const decRef = buildChildRef(slugs, doc, { type: "decisions", seq: decision.seq });
      // JIT nudge: a resolved decision is a commitment without a verification
      // path until its implementation AC(s) exist. Surface the create_ac
      // syntax at exactly the moment the decision flips so the next move is
      // obvious. The full rationale lives in the `decisions-need-acs`
      // guidance topic — cited here so a confused agent can read once and
      // keep the discipline going. Build-readiness will refuse specify→build
      // if any resolved decision is missing its implementation AC(s).
      // spec-121 mechanism 2 — if this decision ALREADY has linked
      // implementation ACs, sketch the test shape for each (with a paste-ready
      // tagAc) so the agent writes the verification while the decision is warm.
      // Reuses the same ac_parent_links traversal decisionAcCoverage walks
      // (dec-6); a decision with zero linked implementation ACs yields no block
      // (ac-19) and we fall back to the generic author-your-ACs nudge.
      // Gather the DATA for the post-resolve guidance (linked implementation
      // ACs → test-shape sketch; semantically-related Issues). These are reads,
      // not prose. spec-219 Phase 2: we hand the data to composeGuidanceEnvelope
      // and it authors the impl-AC push + related-issues nudge. No guidance is
      // crafted in this handler.
      let linkedAcs: SketchAc[] = [];
      try {
        const acRows = await listAcsForBriefWithVerification(memexId, decision.docId);
        linkedAcs = acRows
          .filter(
            (r) =>
              r.ac.kind === "implementation" &&
              r.parents.some((p) => p.kind === "decision" && p.id === entity.row.id),
          )
          .map((r) => ({
            seq: r.ac.seq,
            statement: r.ac.statement,
            canonicalRef: r.canonicalRef,
          }));
      } catch {
        linkedAcs = [];
      }
      // spec-112 (ac-4 / ac-15): auto-surface related Issues whose semantic
      // overlap with the decision clears the relevance threshold. Reuses the
      // same searchMemex(kind:'issue') machinery; informational only, never
      // blocks. Below threshold composeGuidanceEnvelope appends nothing.
      const issueHits = await relatedIssuesForDecision(
        memexId,
        `${decision.title}\n\n${decision.resolution ?? ""}`,
        resolveEmbeddingProvider(),
      );
      if (ctx.footerSlot) {
        ctx.footerSlot.signal = { kind: "decision_resolved", decRef, linkedAcs, issueHits };
      }
      return `Decision resolved: ref: ${decRef} "${decision.title}" — ${decision.resolution}.${hint}`;
    },
  },
  {
    name: "approve_candidate",
    annotations: { title: "Approve candidate decision", readOnlyHint: false, destructiveHint: false },
    description:
      'Approve a candidate decision, transitioning it from status="candidate" to status="open". Throws if the decision is not in candidate status.',
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the candidate decision, e.g. `mindset/main/specs/spec-3/decisions/dec-2`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "decision") {
        throw new ValidationError(
          `approve_candidate expects a decision ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const decision = await approveDecision(memexId, entity.row.id);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, decision.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const decRef = buildChildRef(slugs, doc, { type: "decisions", seq: decision.seq });
      return `Candidate approved: ref: ${decRef} "${decision.title}" → status=open`;
    },
  },
  {
    name: "reject_candidate",
    annotations: { title: "Reject candidate decision", readOnlyHint: false, destructiveHint: false },
    description:
      'Reject a candidate decision, transitioning it from status="candidate" to status="rejected". The reason is preserved as the resolution. Use this when an extracted candidate is not actually a load-bearing decision (single-path action, factual question, procedural meta-decision).',
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the candidate decision, e.g. `mindset/main/specs/spec-3/decisions/dec-2`.",
        ),
      reason: z.string().describe("Why this candidate is being rejected"),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const reason = input.reason as string;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "decision") {
        throw new ValidationError(
          `reject_candidate expects a decision ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const decision = await rejectDecision(memexId, entity.row.id, reason);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, decision.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const decRef = buildChildRef(slugs, doc, { type: "decisions", seq: decision.seq });
      return `Candidate rejected: ref: ${decRef} "${decision.title}".`;
    },
  },

  // ── Acceptance Criteria (feat-ac-spike V0.0.1) ─────────────
  // An AC is a forward-facing testable assertion. Two flavours: 'scope' (manager-
  // authored, plain-English) and 'implementation' (agent-spawned from resolved
  // Decisions). See docs/ac-primitive-hypothesis.md for the full thesis.
  {
    name: "create_ac",
    annotations: { title: "Create acceptance criterion", readOnlyHint: false, destructiveHint: false },
    description:
      "Create an acceptance criterion (AC) under a Spec. Two flavours: " +
      "`kind: 'scope'` for manager-authored plain-English outcome commitments " +
      "(typically authored with the Spec and rendered with the Spec body), and " +
      "`kind: 'implementation'` for technical assertions spawned from a resolved " +
      "Decision (typically auto-accepted; pass `parent_decision_ref` to link). " +
      "ACs are addressable as `ac-N` and have zero or more tests in the codebase " +
      "that emit pass/fail events to POST /api/test-events tagged with the AC handle. " +
      "Before you write the verifying test for an implementation-kind AC you create here, " +
      "MUST call `get_information(topic='ac-emission')` if you haven't already — the " +
      "test-tagging mechanism is silent and undetectable if skipped.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the parent Spec, e.g. `mindset/main/specs/b-3`.",
      ),
      kind: z.enum(["scope", "implementation"]).describe(
        "AC flavour: 'scope' for manager-authored outcome commitments, " +
        "'implementation' for agent-spawned technical assertions.",
      ),
      statement: z.string().describe(
        "The forward-facing statement of what the system must do. Plain English " +
        "for scope; technical/mechanism-shaped for implementation.",
      ),
      status: z.enum(["proposed", "active"]).optional().describe(
        "Initial status. Default 'active' (the auto-accept path). Use 'proposed' " +
        "for ACs that need explicit human review before they take effect.",
      ),
      parent_decision_ref: z.string().optional().describe(
        "Optional canonical ref to a parent Decision (for Implementation ACs), " +
        "e.g. `mindset/main/specs/b-3/decisions/dec-7`. If omitted, no Decision " +
        "parent is recorded; for Scope ACs, the AC's parent is the Spec itself.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const kind = input.kind as AcKind;
      const statement = input.statement as string;
      const status = (input.status as AcStatus | undefined) ?? "active";
      const parentDecisionRef = input.parent_decision_ref as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `create_ac expects a doc-level (Spec) ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      // Resolve optional parent Decision ref to its UUID.
      // The parent-kind discriminator is the DB `ac_parent_links.parent_kind`
      // value (CHECK IN ('brief','decision')); it stays "brief" — see
      // services/acs.ts ParentKind. Not the product noun.
      let parent: { kind: "brief" | "decision"; id: string } | undefined;
      if (parentDecisionRef) {
        const parentResolved = await resolveRefArg(ctx, parentDecisionRef, "parent_decision_ref");
        if (parentResolved.entity.kind !== "decision") {
          throw new ValidationError(
            `parent_decision_ref expects a decision ref; got ${parentResolved.entity.kind}.`,
          );
        }
        parent = { kind: "decision", id: parentResolved.entity.row.id };
      } else if (kind === "scope") {
        // Scope AC default parent: the Spec itself, so blast-radius cascades work.
        parent = { kind: "brief", id: doc.id };
      }

      const ac = await createAc({
        memexId,
        briefId: doc.id,
        kind,
        statement,
        status,
        parent,
      }, reqCtx(ctx));

      // spec-219 comb-through: count-aware AC call-to-action. The handler parks
      // DATA only; renderFooterSignal owns every word. For implementation ACs it
      // also parks the build-gate picture (resolved-decision coverage + open
      // decisions) so the footer can push toward build the moment it's earned —
      // the only phone-home Memex has for "stop lingering in specify while code is
      // being written". Sourced from the rubric's own coverage helper so the
      // footer and assess_spec speak with one voice. Net-new guidance.
      if (ctx.footerSlot) {
        const sameKind = await listAcsForBrief(memexId, doc.id, { kind, status: "active" });
        let coverage:
          | { phase: string; resolvedCount: number; uncovered: string[]; open: string[] }
          | undefined;
        if (kind === "implementation") {
          const [allDecs, cov] = await Promise.all([
            listDecisions(memexId, doc.id),
            listResolvedDecisionImplAcCoverage(memexId, doc.id),
          ]);
          coverage = {
            phase: doc.status,
            resolvedCount: cov.length,
            uncovered: cov
              .filter((c) => c.implementationAcCount === 0)
              .map((c) => c.decisionHandle),
            open: allDecs.filter((d) => d.status === "open").map((d) => `dec-${d.seq}`),
          };
        }
        ctx.footerSlot.signal = {
          kind: "ac_created",
          acKind: kind,
          sameKindCount: sameKind.length,
          coverage,
        };
      }

      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });
      if (ctx.verbose) {
        return `Created AC ${acRef} (${kind}, status=${status}): "${statement}"` +
          (parent ? ` linked to ${parent.kind}` : "");
      }
      return `ref: ${acRef} [${kind}, ${status}]`;
    },
  },
  {
    // spec-234: the agent-facing onboarding for AC emission. One call mints an
    // ephemeral, spec-scoped key AND returns the integration guidance — replacing the
    // "open Settings, mint a key, copy it, npm install a helper" detour. The key is
    // short-lived (so it's safe to return through the MCP transcript, dec-1/dec-5) and
    // scoped to this Spec. The guidance half is rendered from the SAME source as
    // get_information(topic='ac-emission-bootstrap'), never hand-copied (std-22, ac-16).
    name: "provision_ac_emission",
    annotations: { title: "Provision AC emission", readOnlyHint: false, destructiveHint: false },
    description:
      "Provision AC emission for the Spec you are working on, in one call: (1) mints a " +
      "working, ephemeral, spec-scoped emission key for this repo's Memex and returns the " +
      "raw value once, and (2) returns markdown guidance for wiring emission into whatever " +
      "test runner(s) the repo actually uses — authoring a native integration when no " +
      "official helper exists for the stack. No Settings-UI detour and no package install " +
      "are needed to start emitting. The key is short-lived (~2h) and may ONLY record " +
      "emissions for this Spec; use it in the test process environment for THIS session and " +
      "do not persist it — call again next session for a fresh key. For a long-lived CI key, " +
      "a human mints one in Settings → Emission Keys (this tool does not produce CI keys).",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the Spec you are working on, e.g. `mindset/main/specs/spec-3`. " +
          "The provisioned key is scoped to this Spec.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind) || resolved.doc.docType !== "spec") {
        throw new ValidationError(
          `provision_ac_emission expects a Spec ref (e.g. .../specs/spec-N); got ${resolved.entity.kind}/${resolved.doc.docType}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const specHandle = doc.handle; // e.g. "spec-3" — matches the ac_uid's /specs/<handle>/ segment
      const specRef = `${slugs.namespace}/${slugs.memex}/specs/${specHandle}`;

      // Member-level authority (dec-5): resolveRef already asserted the caller is a member of
      // this Memex, so minting here is the same authority as the Settings-UI mint. The minting
      // user is recorded (created_by_user_id) for audit.
      const minted = await mintEphemeralEmissionKey(memexId, specHandle, ctx.userId);
      const expiresAt = minted.row.expiresAt!; // always set for an ephemeral key

      // Render the protocol from the shared guidance source — NOT a hand-copied duplicate
      // (ac-16). This is the same body get_information(topic='ac-emission-bootstrap') serves.
      const bootstrap = await fetchTopic("ac-emission-bootstrap");

      return [
        `# AC emission provisioned for \`${specRef}\``,
        "",
        "## 1. Your emission key (use this session only — do NOT save it to disk)",
        "",
        "```",
        `MEMEX_EMIT_KEY=${minted.raw}`,
        "```",
        "",
        `- **Ephemeral:** this key expires at ${expiresAt.toISOString()} (~2h). It is **scoped to \`${specHandle}\`** — it can only record emissions for this Spec, nothing else on the board.`,
        "- **Do not persist it.** Export it into the environment of the test process for THIS session only " +
          "(e.g. `MEMEX_EMIT_KEY=… <run your tests>`). Do not write it to `.env`, CI config, or any file — " +
          "it will be expired by next session. When you start a fresh session, call `provision_ac_emission` " +
          "again for a new key.",
        "- **CI is different:** a long-lived key for a CI pipeline is minted by a human in Settings → Emission " +
          "Keys and stored as a CI secret. This tool only provisions the short-lived agent key.",
        "",
        "## 2. Wire emission into the repo's test runner(s)",
        "",
        "Detect the test runner(s) **this** repo actually uses (do not assume one). For each suite: if an " +
          "official Memex helper exists for that stack, prefer it; otherwise hand-roll the native emitter using " +
          "the protocol below. A repo with multiple suites (e.g. a web suite plus a mobile/native suite) wires " +
          "emission into **every** suite, not just one. Tag each test with the AC ref it verifies and the emitter " +
          "POSTs the result — no package install is required to begin.",
        "",
        "---",
        "",
        bootstrap.body,
      ].join("\n");
    },
  },
  {
    name: "list_acs",
    annotations: { title: "List acceptance criteria", readOnlyHint: true, destructiveHint: false },
    description:
      "List acceptance criteria on a Spec, optionally filtered by `kind` " +
      "('scope' | 'implementation') or `status` ('proposed' | 'active' | 'rejected' | 'superseded'). " +
      "Each row carries its current verification state derived from `test_events`: " +
      "`verified` (all tagged tests pass) / `failing` (any latest emission is fail) / `stale` " +
      "(all pass but oldest is >7 days) / `untested` (no tagged tests yet). " +
      "**The header line shows coverage % (ACs with ≥1 tagged test) and verification %** so a quick glance " +
      "tells you where the gaps are. An AC sitting at 0 tests in build phase is silent debt — write a tagged " +
      "test before declaring any task done.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the Spec, e.g. `mindset/main/specs/b-3`.",
      ),
      kind: z.enum(["scope", "implementation"]).optional().describe("Filter by AC flavour."),
      status: z.enum(["proposed", "active", "rejected", "superseded"]).optional().describe("Filter by status."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const kind = input.kind as AcKind | undefined;
      const status = input.status as AcStatus | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `list_acs expects a doc-level (Spec) ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      // Use the verification-enriched service so every row carries its
      // test count + derived state. Filtering is client-side because the
      // service signature doesn't accept filters — the row set is tiny
      // (rarely > 50 ACs per Spec) so the JS pass is negligible.
      const allRows: AcWithVerification[] =
        await listAcsForBriefWithVerification(memexId, doc.id);
      let rows = allRows;
      if (kind) rows = rows.filter((r) => r.ac.kind === kind);
      if (status) rows = rows.filter((r) => r.ac.status === status);

      if (rows.length === 0) {
        return `No ACs on ${slugs.namespace}/${slugs.memex}/specs/${doc.handle} matching the filter.`;
      }

      // spec-207 ac-3 — a kind/status filter shrinks `rows`; surface how many
      // active ACs it hides so a filtered view can't silently understate the
      // gap. Counted over the active set on both sides (proposed/superseded ACs
      // aren't part of the "is this done?" signal).
      const filterActive = Boolean(kind || status);
      const hiddenByFilter = filterActive
        ? allRows.filter((r) => r.ac.status === "active").length -
          rows.filter((r) => r.ac.status === "active").length
        : 0;

      // Aggregate header — the coverage gap is the action signal. The agent
      // enumerates ACs constantly during build; spec-207 dec-1 routes the
      // headline through the shared `formatAcCoverageSummary` so it leads with
      // the not-verified gap (and the filter-hiding warning) instead of a
      // self-flattering "verified (of covered)" trophy.
      const covered = rows.filter((r) => r.tests.length > 0).length;
      const untested = rows.length - covered;
      const verified = rows.filter((r) => r.verificationState === "verified").length;
      const failing = rows.filter((r) => r.verificationState === "failing").length;
      const stale = rows.filter((r) => r.verificationState === "stale").length;

      const summary = formatAcCoverageSummary(rows, { hiddenByFilter });
      // Full state distribution stays below the headline as a breakdown.
      const breakdown: string[] = [];
      if (verified > 0) breakdown.push(`${verified} verified`);
      if (failing > 0) breakdown.push(`${failing} failing`);
      if (stale > 0) breakdown.push(`${stale} stale`);
      if (untested > 0) breakdown.push(`${untested} UNTESTED`);

      // Decision-coverage line — mirrors the test-coverage signal one level
      // up: "how many resolved decisions have at least one implementation
      // AC?" A resolved decision without an implementation AC is a
      // commitment without a verification path; see guidance topic
      // `decisions-need-acs`. Best-effort — fails silently if the helper
      // throws so list_acs stays usable even if the join breaks.
      let decisionLine = "";
      try {
        const decCoverage = await listResolvedDecisionImplAcCoverage(
          memexId,
          doc.id,
        );
        if (decCoverage.length > 0) {
          const withAc = decCoverage.filter(
            (c) => c.implementationAcCount > 0,
          ).length;
          const nakedHandles = decCoverage
            .filter((c) => c.implementationAcCount === 0)
            .map((c) => c.decisionHandle);
          const naked = nakedHandles.length;
          decisionLine = `\n${decCoverage.length} resolved decision${decCoverage.length === 1 ? "" : "s"} · ${withAc}/${decCoverage.length} with implementation ACs`;
          if (naked > 0) {
            decisionLine += ` (NAKED: ${nakedHandles.join(", ")})`;
          }
        }
      } catch {
        // Best-effort.
      }

      const header = `${summary}\nBreakdown: ${breakdown.join(", ")}${decisionLine}`;

      // Per-row line — surfaces the AC's tagged-test count so the gap is
      // visible per AC, not just in the aggregate. UNTESTED is uppercase
      // so it pops in the agent's context.
      const lines = rows.map((r) => {
        const acRef = buildChildRef(slugs, doc, { type: "acs", seq: r.ac.seq });
        const testStatus =
          r.tests.length === 0
            ? "0 tests · UNTESTED"
            : `${r.tests.length} test${r.tests.length === 1 ? "" : "s"} · ${r.verificationState}`;
        return `- ref: ${acRef} [${r.ac.kind}, ${r.ac.status}] (${testStatus}) "${r.ac.statement}"`;
      });

      // Tail nudges: surface the two action signals when present —
      //   1. tests-missing: untested ACs need tagged tests
      //   2. ACs-missing-from-decisions: resolved decisions without
      //      implementation ACs are commitments without a verification path
      // Both cite their respective guidance topic so the agent can ground
      // the rule before acting.
      const tailParts: string[] = [];
      if (untested > 0) {
        tailParts.push(
          `${untested} AC${untested === 1 ? " is" : "s are"} untested. ` +
            `If you're in build / verify, write tagged tests for these before declaring any task done. ` +
            `See get_information(topic='test-coverage') for the discipline.`,
        );
      }
      try {
        const decCoverage = await listResolvedDecisionImplAcCoverage(
          memexId,
          doc.id,
        );
        const naked = decCoverage.filter((c) => c.implementationAcCount === 0);
        if (naked.length > 0) {
          const handles = naked.map((c) => c.decisionHandle).join(", ");
          tailParts.push(
            `${naked.length} resolved decision${naked.length === 1 ? "" : "s"} (${handles}) ${naked.length === 1 ? "has" : "have"} no implementation AC. ` +
              `Author at least one via \`create_ac({kind:'implementation', parent_decision_ref:'<dec-ref>', ...})\` before specify→build. ` +
              `See \`get_information(topic='decisions-need-acs')\` for the discipline.`,
          );
        }
      } catch {
        // Best-effort.
      }

      // spec-127 ac-6: orphan awareness. For every FAILING AC, name the
      // test_identifier(s) pinning it red and point to the ref-keyed retire
      // path — so an agent that just renamed/deleted a tagged test discovers
      // and clears its own orphan in-flow. We do NOT claim these ARE orphans
      // (the server can't tell "renamed away" from "failed for real"); we
      // surface the candidates + the affordance and leave the judgement to the
      // actor who knows the codebase (dec-1).
      const failingRows = rows.filter((r) => r.verificationState === "failing");
      if (failingRows.length > 0) {
        const pinLines = failingRows.map((r) => {
          const acRef = buildChildRef(slugs, doc, { type: "acs", seq: r.ac.seq });
          const ids = r.tests
            .filter((t) => t.latestStatus === "fail" || t.latestStatus === "error")
            .map((t) => `"${t.testIdentifier ?? "(no identifier)"}"`);
          return `- ${acRef} pinned by ${ids.join(", ")}`;
        });
        tailParts.push(
          `${failingRows.length} failing AC${failingRows.length === 1 ? "" : "s"} — if a pinning test was renamed/deleted in the codebase, ` +
            `it's an orphan: retire it with \`discontinue_test_events(ref, test_identifier)\` (inspect first with \`get_test_matrix(ref)\`). ` +
            `See \`get_information(topic='orphaned-test-events')\`.\n${pinLines.join("\n")}`,
        );
      }
      const tail = tailParts.length > 0 ? `\n\n${tailParts.join("\n\n")}` : "";

      return `${header}\n\n${lines.join("\n")}${tail}`;
    },
  },
  {
    name: "get_ac",
    annotations: { title: "Get acceptance criterion", readOnlyHint: true, destructiveHint: false },
    description:
      "Get a single AC by canonical ref. Returns the kind, status, statement, " +
      "and (in verbose mode) the full record.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/b-3/acs/ac-2`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `get_ac expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const ac = entity.row;
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });

      // spec-127 ac-6: when this AC is held red, name the pinning identifier(s)
      // and point to the ref-keyed retire path, so an agent inspecting an AC it
      // just broke by renaming a test discovers and clears its own orphan. The
      // digest read is best-effort — a miss never fails get_ac.
      let orphanHint = "";
      try {
        const digest = await listTestEventDigestForAc(memexId, ac.id);
        const pinning = digest.filter((d) => d.pinning);
        if (pinning.length > 0) {
          const ids = pinning
            .map((d) => `"${d.testIdentifier === "" ? "(no identifier)" : d.testIdentifier}"`)
            .join(", ");
          orphanHint =
            `\n⚠ This AC reads failing — pinned by ${ids}. If a pinning test was renamed/deleted in the codebase, ` +
            `it's an orphan: retire it with \`discontinue_test_events(ref="${acRef}", test_identifier=…)\` ` +
            `(inspect with \`get_test_matrix(ref="${acRef}")\`). See \`get_information(topic='orphaned-test-events')\`.`;
        }
      } catch {
        // Best-effort.
      }

      if (ctx.verbose) {
        return `ref: ${acRef} (seq=${ac.seq}, kind=${ac.kind}, status=${ac.status}): "${ac.statement}"${orphanHint}`;
      }
      return `ref: ${acRef} [${ac.kind}, ${ac.status}] "${ac.statement}"${orphanHint}`;
    },
  },
  {
    name: "get_test_matrix",
    annotations: {
      title: "Read an AC's test-event matrix",
      readOnlyHint: true,
      destructiveHint: false,
    },
    description:
      "Read the per-`test_identifier` test-event digest for one AC, keyed by its " +
      "canonical ref. One row per identifier: latest (non-hidden) status, last run " +
      "time, emission count, and two flags — `PINNING red` (this identifier's latest " +
      "emission is fail/error, so it holds the AC red) and `retired (hidden)` (already " +
      "soft-hidden, invisible to the verdict). Use this when an AC reads `failing`/`stale` " +
      "to find WHICH identifier is responsible — then, if you renamed/deleted that test " +
      "in the codebase, retire its orphan with `discontinue_test_events`. See " +
      "`get_information(topic='orphaned-test-events')`.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/spec-3/acs/ac-2`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `get_test_matrix expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: entity.row.seq });
      const rows = await listTestEventDigestForAc(memexId, entity.row.id);
      if (rows.length === 0) {
        return `ref: ${acRef}\nNo test events recorded for this AC yet.`;
      }
      const lines = rows.map((r) => {
        const id = r.testIdentifier === "" ? "(no identifier)" : r.testIdentifier;
        const status = r.hidden ? "retired" : (r.latestStatus ?? "—");
        const last = r.latestRunAt ? r.latestRunAt.toISOString() : "—";
        const flags: string[] = [];
        if (r.pinning) flags.push("PINNING red");
        if (r.hidden) flags.push("retired (hidden)");
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        return `- ${id} — latest ${status}, ${r.count} emission${r.count === 1 ? "" : "s"}, last ${last}${flagStr}`;
      });
      return `ref: ${acRef}\n${lines.join("\n")}`;
    },
  },
  {
    name: "discontinue_test_events",
    annotations: {
      title: "Discontinue (soft-hide) an orphaned test_identifier",
      readOnlyHint: false,
      destructiveHint: false,
    },
    description:
      "Retire an orphaned `test_identifier` on an AC — a test you renamed/moved/deleted " +
      "in the codebase whose last emission still pins the AC red. SOFT, reversible: it sets " +
      "`hidden=true` on the matching emissions (audit retained) and drops them from the " +
      "verification badge. If you were wrong, `restore_test_events` brings it back; and a " +
      "fresh live emission of the same identifier re-enters the verdict on its own. Only " +
      "retire an identifier you KNOW no longer exists in the codebase — not one that merely " +
      "wasn't run this round. Find the identifier with `get_test_matrix`.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/spec-3/acs/ac-2`.",
      ),
      test_identifier: z.string().describe(
        "The exact test_identifier to retire (as shown by get_test_matrix), " +
          "e.g. `tests/cache.test.ts::uses redis`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      // Resolve the ref FIRST so the std-10 UUID boundary guard fires before
      // any other validation (b-36 D-7 — the canonical error must win).
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `discontinue_test_events expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const testIdentifier = input.test_identifier as string;
      if (!testIdentifier?.trim()) {
        throw new ValidationError("test_identifier is required.");
      }
      const { memexId, doc, slugs, entity } = resolved;
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: entity.row.seq });
      const result = await softHideTestEventsForAc(
        memexId,
        entity.row.id,
        testIdentifier,
      );
      const state = await verificationStateForAc(memexId, doc.id, entity.row.id);
      if (result.hidden === 0) {
        return `ref: ${acRef} — no emissions matched "${testIdentifier}"; nothing retired. AC verification: ${state}.`;
      }
      return `ref: ${acRef} — retired (soft-hidden) ${result.hidden} emission${result.hidden === 1 ? "" : "s"} of "${testIdentifier}". AC verification is now: ${state}. Reverse with restore_test_events.`;
    },
  },
  {
    name: "restore_test_events",
    annotations: {
      title: "Restore (un-hide) a discontinued test_identifier",
      readOnlyHint: false,
      destructiveHint: false,
    },
    description:
      "Reverse a `discontinue_test_events`: un-hide every emission of a `test_identifier` " +
      "on an AC and recompute the verification badge from the restored history. Use when an " +
      "identifier was retired by mistake (the test still exists). Find retired identifiers " +
      "with `get_test_matrix` (they show `retired (hidden)`).",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/spec-3/acs/ac-2`.",
      ),
      test_identifier: z.string().describe(
        "The exact test_identifier to restore (as shown by get_test_matrix).",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      // Resolve the ref FIRST so the std-10 UUID boundary guard fires before
      // any other validation (b-36 D-7 — the canonical error must win).
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `restore_test_events expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const testIdentifier = input.test_identifier as string;
      if (!testIdentifier?.trim()) {
        throw new ValidationError("test_identifier is required.");
      }
      const { memexId, doc, slugs, entity } = resolved;
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: entity.row.seq });
      const result = await restoreTestEventsForAc(
        memexId,
        entity.row.id,
        testIdentifier,
      );
      const state = await verificationStateForAc(memexId, doc.id, entity.row.id);
      if (result.restored === 0) {
        return `ref: ${acRef} — no emissions matched "${testIdentifier}"; nothing restored. AC verification: ${state}.`;
      }
      return `ref: ${acRef} — restored ${result.restored} emission${result.restored === 1 ? "" : "s"} of "${testIdentifier}". AC verification is now: ${state}.`;
    },
  },
  {
    name: "link_ac_to_decision",
    annotations: { title: "Link AC to a parent Decision", readOnlyHint: false, destructiveHint: false },
    description:
      "Add a parent-Decision link to an existing AC. Used when an AC needs to be " +
      "associated with a Decision that wasn't its origin (e.g. cross-cutting " +
      "Implementation ACs spawned from multiple Decisions). For typical " +
      "Decision-spawned ACs, pass the parent_decision_ref argument to create_ac instead.",
    schema: {
      ac_ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/b-3/acs/ac-2`.",
      ),
      decision_ref: z.string().describe(
        "Canonical ref to the parent Decision, e.g. `mindset/main/specs/b-3/decisions/dec-7`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const acRefArg = input.ac_ref as string;
      const decisionRef = input.decision_ref as string;

      const acResolved = await resolveRefArg(ctx, acRefArg, "ac_ref");
      if (acResolved.entity.kind !== "ac") {
        throw new ValidationError(
          `ac_ref expects an ac ref; got ${acResolved.entity.kind}.`,
        );
      }
      const parentResolved = await resolveRefArg(ctx, decisionRef, "decision_ref");
      if (parentResolved.entity.kind !== "decision") {
        throw new ValidationError(
          `decision_ref expects a decision ref; got ${parentResolved.entity.kind}.`,
        );
      }
      await linkAcToParent(acResolved.memexId, acResolved.entity.row.id, {
        kind: "decision",
        id: parentResolved.entity.row.id,
      });
      const acRefOut = buildChildRef(acResolved.slugs, acResolved.doc, {
        type: "acs",
        seq: acResolved.entity.row.seq,
      });
      const decRefOut = buildChildRef(parentResolved.slugs, parentResolved.doc, {
        type: "decisions",
        seq: parentResolved.entity.row.seq,
      });
      return `Linked ref: ${acRefOut} to ref: ${decRefOut}`;
    },
  },
  {
    name: "update_ac",
    annotations: { title: "Update AC statement", readOnlyHint: false, destructiveHint: false },
    description:
      "Update the statement text of an existing AC. Only the statement is " +
      "mutable here; kind is fixed at creation, and status transitions go " +
      "through accept_ac / reject_ac (when exposed). Use this to polish " +
      "wording, sharpen falsifiability, or fix typos.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/b-3/acs/ac-2`.",
      ),
      statement: z.string().describe("New statement text. Must be non-empty."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const statement = input.statement as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `update_ac expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const ac = await updateAc(memexId, entity.row.id, statement, reqCtx(ctx));
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });
      if (ctx.verbose) {
        return `Updated ref: ${acRef} (seq=${ac.seq}, kind=${ac.kind}, status=${ac.status}): "${ac.statement}"`;
      }
      return `Updated ref: ${acRef} [${ac.kind}, ${ac.status}]`;
    },
  },
  {
    name: "delete_ac",
    annotations: { title: "Delete AC", readOnlyHint: false, destructiveHint: true },
    description:
      "Hard-delete an AC. FK cascades remove its parent links and any " +
      "task_satisfies_ac rows pointing at it. Prefer reject_ac (status " +
      "transition, preserves history) over delete for ACs that were " +
      "considered and dismissed; delete is for accidents or duplicates.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/b-3/acs/ac-2`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `delete_ac expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const ac = await deleteAc(memexId, entity.row.id);
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });
      if (ctx.verbose) {
        return `Deleted ref: ${acRef} (seq=${ac.seq}, kind=${ac.kind}) "${ac.statement}"`;
      }
      return `Deleted ref: ${acRef}`;
    },
  },

  // ── Task CRUD ────────────────────────────────────────────
  {
    name: "list_tasks",
    annotations: { title: "List tasks", readOnlyHint: true, destructiveHint: false },
    description:
      "List tasks on a document, with optional filters. " +
      "`readyOnly: true` returns only unblocked, not_started tasks (replaces get_ready_tasks) — the response includes a pre-task reminder. " +
      "Without filters, behaves like the task subset of get_doc.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the parent document, e.g. `mindset/main/specs/spec-3`.",
        ),
      readyOnly: z
        .boolean()
        .optional()
        .describe("Only return tasks with status='not_started' and no open blockers."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const readyOnly = input.readyOnly as boolean | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `list_tasks expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      if (ctx.verbose) {
        if (readyOnly) {
          const ready = await getReadyTasks(memexId, doc.id);
          return `${formatDocStatusHeader(doc)}\n\n${formatReadyTasks(ready, doc.handle)}`;
        }
        const all = await listTasks(memexId, doc.id);
        if (all.length === 0) {
          return `${formatDocStatusHeader(doc)}\n\nNo tasks on this doc.`;
        }
        const lines = all.map((t) => `- t-${t.seq} [${t.status}] "${t.title}"`);
        return `${formatDocStatusHeader(doc)}\n\n${lines.join("\n")}`;
      }

      // Terse path. Per dec-4: include the canonical task ref + READY|BLOCKED
      // marker so a follow-up `update_task` call has everything it needs
      // without another round-trip.
      if (readyOnly) {
        const ready = await getReadyTasks(memexId, doc.id);
        if (ready.length === 0) return "No ready tasks.";
        return ready
          .map((t) => {
            const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: t.seq });
            return `- ref: ${taskRef} [not_started, READY] "${t.title}"`;
          })
          .join("\n");
      }
      const all = await listTasks(memexId, doc.id);
      if (all.length === 0) return "No tasks on this doc.";
      return all
        .map((t) => {
          const blockerHandles = [
            ...t.blockedByDecisions.map((d) => `dec-${d.seq}`),
            ...t.blockedByTasks.map((bt) => `t-${bt.seq}`),
          ];
          const marker =
            blockerHandles.length > 0
              ? `BLOCKED-by-${blockerHandles.join(",")}`
              : "READY";
          const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: t.seq });
          return `- ref: ${taskRef} [${t.status}, ${marker}] "${t.title}"`;
        })
        .join("\n");
    },
  },
  {
    name: "create_task",
    annotations: { title: "Create task", readOnlyHint: false, destructiveHint: false },
    description:
      "Create a task. Build-phase only — see the two non-negotiable rules in the MCP instructions (tasks only in 'build', resolve open decisions first; a 'decide/choose/figure out/pick' title is a decision-in-disguise → use create_decision instead). Include acceptance criteria.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the parent document, e.g. `mindset/main/specs/spec-3`.",
        ),
      title: z.string().describe("Concrete unit of work — outcome, not a research/decide verb."),
      description: z.string().describe("What the task delivers and any constraints the implementer needs."),
      acceptanceCriteria: z
        .array(z.object({ description: z.string(), done: z.boolean().default(false) }))
        .optional()
        .describe("Checklist items that gate completion. Each {description, done?:false}."),
      sectionRef: z.string().optional().describe("Section type this task delivers against."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const title = input.title as string;
      const description = input.description as string;
      const acceptanceCriteria = input.acceptanceCriteria as
        | Array<{ description: string; done: boolean }>
        | undefined;
      const sectionRef = input.sectionRef as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `create_task expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const task = await createTask(
        memexId,
        doc.id,
        title,
        description,
        acceptanceCriteria,
        sectionRef,
        reqCtx(ctx),
      );
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: task.seq });
      return `Task created: ref: ${taskRef} "${task.title}"`;
    },
  },
  {
    name: "update_task",
    annotations: { title: "Update task", readOnlyHint: false, destructiveHint: false },
    description:
      "Update a task. Pass only the fields you want to change. Replaces update_task_status, add_blocker, remove_blocker.\n" +
      "  - **status**: 'not_started' | 'in_progress' | 'complete'. Completing may unblock dependents.\n" +
      "  - **addBlockerRef**: canonical ref to a decision or task in the same parent doc.\n" +
      "  - **removeBlockerRef**: canonical ref to a decision or task in the same parent doc.\n" +
      "  - **title / description / acceptanceCriteria / sectionRef**: in-place edits.\n" +
      "Multiple fields can be set in one call (e.g. status + acceptanceCriteria for verification).\n" +
      "When transitioning to `status: 'in_progress'` on a Spec in build, MUST call `get_information(topic='ac-emission')` first if you haven't already this session — that's the moment you're about to write code + tests, and the AC tagging mechanic is non-obvious.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the task, e.g. `mindset/main/specs/spec-3/tasks/t-2`.",
        ),
      status: z.enum(TASK_STATUS).optional().describe("'not_started' | 'in_progress' | 'complete'. Completing may unblock dependents."),
      title: z.string().optional().describe("Replace the task title."),
      description: z.string().optional().describe("Replace the task description."),
      acceptanceCriteria: z
        .array(z.object({ description: z.string(), done: z.boolean().default(false) }))
        .optional()
        .describe("Replace the acceptance-criteria checklist (each item: {description, done?:false})."),
      sectionRef: z.string().nullable().optional().describe("Section type this task delivers against. Pass null to clear."),
      addBlockerRef: z
        .string()
        .optional()
        .describe(
          "Canonical ref to a decision or task in the same parent doc, e.g. `mindset/main/specs/spec-3/decisions/dec-2`.",
        ),
      removeBlockerRef: z
        .string()
        .optional()
        .describe(
          "Canonical ref to a decision or task in the same parent doc, e.g. `mindset/main/specs/spec-3/decisions/dec-2`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const status = input.status as string | undefined;
      const title = input.title as string | undefined;
      const description = input.description as string | undefined;
      const acceptanceCriteria = input.acceptanceCriteria as
        | Array<{ description: string; done: boolean }>
        | undefined;
      const sectionRef = input.sectionRef as string | null | undefined;
      const addBRef = input.addBlockerRef as string | undefined;
      const rmBRef = input.removeBlockerRef as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "task") {
        throw new ValidationError(
          `update_task expects a task ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const taskUuid = entity.row.id;

      // Resolve a blocker ref → service-layer handle string. The blocker must
      // live in the same parent doc as the task; the service rejects cross-doc
      // blockers via its `getDecision/getTask(docId)` lookup, but we double-
      // check here so the error surfaces at the boundary.
      const resolveBlockerRef = async (
        blockerRef: string,
        argName: string,
      ): Promise<string> => {
        const br = await resolveRefArg(ctx, blockerRef, argName);
        if (br.doc.id !== doc.id) {
          throw new ValidationError(
            `${argName} must point to an entity in the same parent doc.`,
          );
        }
        if (br.entity.kind === "decision") {
          return `D-${br.entity.row.seq}`;
        }
        if (br.entity.kind === "task") {
          return `T-${br.entity.row.seq}`;
        }
        throw new ValidationError(
          `${argName} must resolve to a decision or task; got ${br.entity.kind}.`,
        );
      };

      const messages: string[] = [];
      if (
        title !== undefined ||
        description !== undefined ||
        acceptanceCriteria !== undefined ||
        sectionRef !== undefined
      ) {
        const updated = await updateTask(memexId, taskUuid, {
          title,
          description,
          acceptanceCriteria,
          sectionRef,
        }, reqCtx(ctx));
        const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: updated.seq });
        messages.push(`Task ref: ${taskRef} fields updated.`);
      }
      if (status !== undefined) {
        const updated = await updateTaskStatus(memexId, taskUuid, status, reqCtx(ctx));
        let unblockedHint = "";
        // Per dec-1: when completing a task unblocks dependents, name them so
        // the agent skips the follow-up `list_tasks(readyOnly:true)` call. This
        // is RESULT-REPORTING (a fact about what the call did), so it stays in
        // the handler. The "leave a progress comment" STEER is guidance, owned by
        // composeGuidanceEnvelope — we signal the event, not the words.
        if (status === "complete") {
          const unblocked = await findNewlyUnblockedDependents(memexId, taskUuid);
          if (unblocked.length > 0) {
            unblockedHint = ` Unblocked dependents: ${unblocked
              .map((u) => `t-${u.seq}`)
              .join(", ")}.`;
          }
          if (ctx.footerSlot) {
            // spec-219 comb-through: park the build-completion picture so the
            // footer can push toward verify the moment the last task is done
            // (the build->verify analogue of create_ac's build-push).
            const open = (await listTasks(memexId, doc.id)).filter(
              (t) => t.status !== "complete",
            ).length;
            ctx.footerSlot.signal = {
              kind: "task_completed",
              allComplete: open === 0,
              remaining: open,
            };
          }
        }
        const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: updated.seq });
        messages.push(
          `Task ref: ${taskRef} status → "${updated.status}".${unblockedHint}`,
        );
      }
      if (addBRef !== undefined) {
        const handle = await resolveBlockerRef(addBRef, "addBlockerRef");
        await addBlocker(memexId, taskUuid, handle);
        const fresh = await getTask(memexId, taskUuid);
        const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: fresh.seq });
        messages.push(
          `Blocker ${handle} added to ref: ${taskRef} ${formatTaskReadyMarker(fresh)}.`,
        );
      }
      if (rmBRef !== undefined) {
        const handle = await resolveBlockerRef(rmBRef, "removeBlockerRef");
        await removeBlocker(memexId, taskUuid, handle);
        const fresh = await getTask(memexId, taskUuid);
        const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: fresh.seq });
        messages.push(
          `Blocker ${handle} removed from ref: ${taskRef} ${formatTaskReadyMarker(fresh)}.`,
        );
      }

      if (ctx.verbose) {
        const fresh = await getTask(memexId, taskUuid);
        const state = await fullDocState(memexId, fresh.docId);
        const url = await ctx.workspaceUrl(memexId);
        // spec-219 Phase 2 (sole-author): the completion steer is already
        // signalled above (kind:'task_completed'); composeGuidanceEnvelope owns
        // the prose for terse AND verbose. Nothing to park here.
        return await formatState(url, state, ctx);
      }

      if (messages.length === 0) {
        return "No-op: pass at least one of status, title, description, acceptanceCriteria, sectionRef, addBlockerRef, removeBlockerRef.";
      }
      return messages.join(" ");
    },
  },
  {
    name: "delete_task",
    annotations: { title: "Delete task", readOnlyHint: false, destructiveHint: true },
    description: "Delete a task. Also removes its blockers and dependencies.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the task, e.g. `mindset/main/specs/spec-3/tasks/t-2`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "task") {
        throw new ValidationError(
          `delete_task expects a task ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const deleted = await deleteTask(memexId, entity.row.id);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, deleted.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: deleted.seq });
      return `Task ref: ${taskRef} "${deleted.title}" deleted.`;
    },
  },

  // ── Comment CRUD ─────────────────────────────────────────
  {
    name: "add_comment",
    annotations: { title: "Add comment", readOnlyHint: false, destructiveHint: false },
    description:
      "Add a comment to a section, decision, or task. `ref` is a canonical ref to the target. When called via MCP the comment is stamped `source='agent'` automatically. **Use type=`question` when you hit a knowledge gap the codebase can't answer** — surface to the user via this tool rather than producing plausible-looking code.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the comment's target — a section, decision, or task. Examples: `mindset/main/specs/spec-3/sections/s-2`, `.../decisions/dec-1`, `.../tasks/t-4`.",
        ),
      authorName: z.string().describe("Display name for the comment author. Defaults to 'Memex agent' when called by the agent."),
      content: z.string().describe("Comment body (markdown)."),
      type: z
        .enum(COMMENT_TYPES as readonly [string, ...string[]])
        .optional()
        .describe(COMMENT_TYPE_DESC),
      referenceRef: z
        .string()
        .optional()
        .describe(
          "Cross-reference target — canonical ref to a spec, standard, decision, or task. Use only with type=cross_reference.",
        ),
      anchorOffset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "spec-100 (geo-comments): anchor this comment to a point in a SECTION's markdown. Character offset into the section source where the `[^c-N]` marker is inserted. The snapshot of the surrounding sentence is captured automatically. Only valid when `ref` is a section.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      // spec-126 change-10: attribute the comment to the acting user when the
      // in-app agent set ctx.userName (it acts on the signed-in human's behalf).
      // MCP/unknown callers keep the historic 'Memex agent' / source='agent'.
      const actingUser = ctx.userName;
      const authorName =
        (input.authorName as string | undefined) ?? actingUser ?? "Memex agent";
      const content = input.content as string;
      const type = input.type as CommentType | undefined;
      const referenceRef = input.referenceRef as string | undefined;
      const anchorOffset = input.anchorOffset as number | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (
        resolved.entity.kind !== "section" &&
        resolved.entity.kind !== "decision" &&
        resolved.entity.kind !== "task"
      ) {
        throw new ValidationError(
          `add_comment expects a section, decision, or task ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      const extras: CommentExtras = {
        // human when the in-app agent acts for a signed-in user (change-10);
        // agent otherwise (MCP / no bound human) — preserves the v0 semantics.
        source: actingUser ? "human" : "agent",
        ...(type !== undefined ? { type } : {}),
      };
      if (referenceRef !== undefined) {
        const xref = await resolveRefArg(ctx, referenceRef, "referenceRef");
        switch (xref.entity.kind) {
          case "spec":
            // referenceBriefId column predates the Spec → Spec rename and is
            // kept stable to avoid a schema/data migration; the value is a
            // Spec doc id.
            extras.referenceBriefId = xref.entity.row.id;
            break;
          case "standard":
            extras.referenceStandardId = xref.entity.row.id;
            break;
          case "decision":
            extras.referenceDecisionId = xref.entity.row.id;
            break;
          case "task":
            extras.referenceTaskId = xref.entity.row.id;
            break;
          default:
            throw new ValidationError(
              `referenceRef must resolve to a spec, standard, decision, or task; got ${xref.entity.kind}.`,
            );
        }
      }

      // spec-100: anchoring only applies to section targets. Reject the
      // combination early rather than silently dropping the offset.
      if (anchorOffset !== undefined && resolved.entity.kind !== "section") {
        throw new ValidationError(
          `anchorOffset is only valid when commenting on a section; got ${resolved.entity.kind}.`,
        );
      }

      let comment;
      if (resolved.entity.kind === "section") {
        comment =
          anchorOffset !== undefined
            ? await addAnchoredComment(
                memexId,
                resolved.entity.row.id,
                authorName,
                content,
                anchorOffset,
                extras,
              )
            : await addComment(memexId, resolved.entity.row.id, authorName, content, extras);
      } else if (resolved.entity.kind === "decision") {
        comment = await addDecisionComment(
          memexId,
          resolved.entity.row.id,
          authorName,
          content,
          extras,
        );
      } else {
        comment = await addTaskComment(memexId, resolved.entity.row.id, authorName, content, extras);
      }

      if (ctx.verbose) {
        return `${formatDocStatusHeader(doc)}\n\n${formatComment(comment)}`;
      }
      const commentRef = buildChildRef(slugs, doc, { type: "comments", seq: comment.seq });
      return `Comment added (ref: ${commentRef}).`;
    },
  },
  {
    name: "list_comments",
    annotations: { title: "List comments", readOnlyHint: true, destructiveHint: false },
    description:
      "List comments. Replaces list_doc_comments / list_task_notes / list_open_questions / review_doc_comments via filter combinations:\n" +
      "  - **By target**: pass a section/decision/task ref.\n" +
      "  - **By document**: pass a doc-level ref — returns every comment across sections/decisions/tasks of the doc.\n" +
      "  - **types**: array of comment types to filter (e.g. ['question'], ['drift', 'plan_revision']).\n" +
      "  - **mode='review'**: review-shaped output (excludes agent `progress` notes by default; pass explicit `types` to override). Only valid with a doc-level ref.\n" +
      "  - **mode='task_notes'**: agent-typed notes on a task (plan/progress/issue/deferred/question). Only valid with a task ref.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the document, section, decision, or task to filter comments by.",
        ),
      types: z
        .array(z.enum(COMMENT_TYPES as readonly [string, ...string[]]))
        .optional()
        .describe("Comment-type filter, e.g. ['question'] or ['drift', 'plan_revision']."),
      mode: z.enum(["default", "review", "task_notes"]).optional().describe("'review' is doc-scoped review output (excludes agent `progress` notes); 'task_notes' is task-scoped agent notes (plan/progress/issue/deferred/question)."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const types = input.types as CommentType[] | undefined;
      const mode = input.mode as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      const { memexId, doc, slugs } = resolved;

      // Doc-scoped paths
      if (isDocLikeKind(resolved.entity.kind)) {
        if (mode === "review") {
          const allowed: CommentType[] =
            types && types.length > 0
              ? types
              : COMMENT_TYPES.filter((t) => t !== "progress");
          const result = await reviewDocComments(memexId, doc.id, { typeFilter: allowed });
          if (ctx.verbose) {
            return `${formatDocStatusHeader(doc)}\n\n${formatReviewComments(result)}`;
          }
          const lines = formatDocCommentsTerse(result, slugs, doc);
          if (lines.length === 0) return "No open comments to review on this doc.";
          return lines.join("\n");
        }

        const opts: ListCommentsOptions = {};
        if (types && types.length > 0) opts.typeFilter = types;
        const result = await listCommentsForDoc(memexId, doc.id, opts);
        if (ctx.verbose) {
          return `${formatDocStatusHeader(doc)}\n\n${formatDocComments(result)}`;
        }
        const lines = formatDocCommentsTerse(result, slugs, doc);
        if (lines.length === 0) return "No comments on this doc.";
        return lines.join("\n");
      }

      // Single-target paths.
      if (
        resolved.entity.kind !== "section" &&
        resolved.entity.kind !== "decision" &&
        resolved.entity.kind !== "task"
      ) {
        throw new ValidationError(
          `list_comments expects a doc, section, decision, or task ref; got ${resolved.entity.kind}.`,
        );
      }

      const opts: ListCommentsOptions = {};
      if (mode === "task_notes") {
        if (resolved.entity.kind !== "task") {
          throw new ValidationError("mode='task_notes' requires a task ref.");
        }
        opts.typeFilter = ["plan", "progress", "issue", "deferred", "question"] as CommentType[];
      } else if (types && types.length > 0) {
        opts.typeFilter = types;
      }

      let comments;
      if (resolved.entity.kind === "section") {
        comments = await listComments(memexId, resolved.entity.row.id, opts);
      } else if (resolved.entity.kind === "decision") {
        comments = await listDecisionComments(memexId, resolved.entity.row.id, opts);
      } else {
        comments = await listTaskComments(memexId, resolved.entity.row.id, opts);
      }

      if (ctx.verbose) {
        return `${formatDocStatusHeader(doc)}\n\n${formatCommentList(comments, slugs, doc)}`;
      }
      if (comments.length === 0) return "No comments on this target.";
      return comments
        .map((c) => `- ${formatTerseComment(c, slugs, doc)}`)
        .join("\n");
    },
  },
  {
    name: "update_comment",
    annotations: { title: "Update comment", readOnlyHint: false, destructiveHint: false },
    description:
      "Update a comment. Today: status='resolved' resolves the comment after addressing it (replaces resolve_comment). Include a resolution describing what was done.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the comment, e.g. `mindset/main/specs/spec-3/comments/c-5`.",
        ),
      status: z.literal("resolved").describe("Currently only 'resolved' is supported."),
      resolution: z.string().optional().describe("Optional note describing what was done to resolve the comment."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolution = input.resolution as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "comment") {
        throw new ValidationError(
          `update_comment expects a comment ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const comment = await resolveComment(memexId, entity.row.id, resolution, reqCtx(ctx));
      if (ctx.verbose) {
        return `${formatDocStatusHeader(doc)}\n\nComment resolved.\n${formatComment(comment)}`;
      }
      const commentRef = buildChildRef(slugs, doc, { type: "comments", seq: comment.seq });
      return `Comment resolved (ref: ${commentRef}).`;
    },
  },

  // ── Spec lifecycle ─────────────────────────────────────
  {
    name: "assess_spec",
    annotations: { title: "Assess Spec", readOnlyHint: false, destructiveHint: false },
    description:
      "Run a deterministic Spec assessment. Replaces assess_phase_transition / assess_narrative_freshness / assess_comments_status / mark_narrative_consolidated.\n" +
      "Modes:\n" +
      "  - **phase**: readiness check before forward Spec transitions. Returns the rubric for `target` (specify/build/verify/done) plus a fact sheet (open decisions, incomplete tasks, ready-vs-blocked, drift, narrative coverage). Call BEFORE update_doc({status:<target>}) on any forward move.\n" +
      "  - **narrative**: freshness check — decisions / sections changed since the last consolidation. Use at specify→build before re-walking the narrative.\n" +
      "  - **comments**: open-comments survey (oldest-first, per-type breakdown). Useful at any phase transition.\n" +
      "  - **consolidate**: stamps `narrativeLastConsolidatedAt = now()`. Call AFTER walking the narrative-freshness output with the user and updating prose inline.\n" +
      "Spec-only.",
    schema: {
      ref: z
        .string()
        .describe("Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`."),
      mode: z.enum(["phase", "narrative", "comments", "consolidate"]).describe("Which assessment to run: 'phase' (forward-transition rubric), 'narrative' (freshness check), 'comments' (open-comments survey), or 'consolidate' (stamp narrativeLastConsolidatedAt)."),
      target: z
        .enum(["specify", "build", "verify", "done"])
        .optional()
        .describe("Required for mode='phase'. The target phase being transitioned into."),
      codeGrounding: z
        .enum(["not_applicable", "verified", "not_verified"])
        .optional()
        .describe(
          "Agent's self-classification of code-grounding for this Spec's resolved decisions. " +
          "Pass on a second call to assess_spec after reading the prompt in the first call's response. " +
          "Ignored unless target='build'.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const mode = input.mode as string;
      const target = input.target as string | undefined;
      const codeGrounding = input.codeGrounding as
        | "not_applicable"
        | "verified"
        | "not_verified"
        | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `assess_spec expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc } = resolved;
      const missionUuid = doc.id;
      await loadSpec(memexId, missionUuid);

      if (mode === "phase") {
        if (!target) throw new ValidationError("assess_spec(mode='phase') requires `target`.");
        if (!isPhaseTarget(target)) {
          throw new ValidationError(`Invalid target '${target}'. Must be specify/build/verify/done.`);
        }
        const assessment = await assessPhaseTransition(
          memexId,
          missionUuid,
          target,
          codeGrounding,
        );
        return formatPhaseAssessment(assessment);
      }
      if (mode === "narrative") {
        const result = await assessNarrativeFreshness(memexId, missionUuid);
        const lines: string[] = [result.factSheet];
        if (result.changedDecisions.length > 0) {
          lines.push("", "Changed decisions:");
          for (const d of result.changedDecisions) {
            lines.push(
              `- ${d.handle} "${d.title}" (status=${d.status}, last changed ${d.lastChangedAt.toISOString()})`,
            );
          }
        }
        if (result.changedSections.length > 0) {
          lines.push("", "Changed sections:");
          for (const s of result.changedSections) {
            lines.push(
              `- ${s.title ?? s.sectionType} [${s.sectionType}] — updated ${s.updatedAt.toISOString()}`,
            );
          }
        }
        return lines.join("\n");
      }
      if (mode === "comments") {
        const status = await assessCommentsStatus(memexId, missionUuid);
        const lines: string[] = [];
        lines.push(
          `Spec ${status.specHandle} "${status.specTitle}" — ${status.totalOpen} open comment${status.totalOpen === 1 ? "" : "s"}.`,
        );
        lines.push(
          `Breakdown: note=${status.byType.note}, question=${status.byType.question}, drift=${status.byType.drift}, plan_revision=${status.byType.plan_revision}${status.byType.other > 0 ? `, other=${status.byType.other}` : ""}.`,
        );
        if (status.comments.length > 0) {
          lines.push("", "Open comments (oldest first):");
          for (const c of status.comments) {
            const targetTitle = c.target.title ? ` "${c.target.title}"` : "";
            lines.push(
              `- [${c.type}] on ${c.target.kind} ${c.target.handle}${targetTitle} by ${capitalizeDisplayName(c.author)} (${timeAgo(c.createdAt)}): ${c.contentSnippet}`,
            );
          }
        }
        return lines.join("\n");
      }
      // mode === "consolidate"
      const result = await markNarrativeConsolidated(memexId, missionUuid);
      return `Narrative consolidated for Spec ${result.specHandle} at ${result.consolidatedAt.toISOString()}.`;
    },
  },
  {
    name: "publish_spec",
    annotations: { title: "Publish Spec", readOnlyHint: false, destructiveHint: false },
    description:
      'Transition a Spec out of draft. Defaults to "specify" status. Pass `status` to override. Run `assess_spec({mode:\'phase\'})` first for any forward move past specify. Refuses already-published Specs (use update_doc({status}) for further moves).',
    schema: {
      ref: z
        .string()
        .describe("Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`."),
      status: z.enum(["specify", "build", "verify", "done"]).optional().describe("Target lifecycle status. Defaults to 'specify'."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const status = input.status as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `publish_spec expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, slugs } = resolved;
      const missionUuid = resolved.doc.id;
      const doc = await loadSpec(memexId, missionUuid);
      if (doc.status !== "draft") {
        throw new ValidationError(
          `Spec ${doc.handle} is already published (current status: ${doc.status}). Use update_doc({status}) to change status further.`,
        );
      }
      const beforeStatus = doc.status;
      const target = status ?? "specify";
      // spec-122 dec-2/dec-5: thread the activity contract onto the publish
      // transition so Pulse attributes the phase move to the human + surface.
      await updateDocStatus(memexId, doc.id, target, { ctx: reqCtx(ctx) });
      // spec-219 Phase 2 (sole-author): signal the transition; composeGuidanceEnvelope
      // owns the transition guidance prose.
      if (ctx.footerSlot) {
        ctx.footerSlot.signal = {
          kind: "doc_transition",
          beforeStatus,
          target,
          docType: doc.docType,
        };
      }

      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const fresh = await getDoc(memexId, doc.id);
      // Per dec-1 / t-8: replace the best-effort `nudge` with the deterministic
      // phase header so the agent always learns the new "Allowed now".
      const phaseLine = formatTerseSpecPhase(fresh.status) ?? "";
      const freshRef = buildDocRef(slugs, fresh);
      return `Spec ref: ${freshRef} published to "${fresh.status}". ${phaseLine}`.trim();
    },
  },

  // ── Memex-wide search (spec-34) ──────────────────────────
  // search_memex covers Specs, Standards, free-form docs, and Decisions
  // inside the active Memex. Replaces the old search_standards tool wholesale
  // (mcp/migration-map.ts has the rename entry). Path-based result format
  // per b-34 D-4 + b-36 D-1/D-2/D-7 — zero UUIDs in output.
  {
    name: "search_memex",
    annotations: { title: "Search Memex", readOnlyHint: true, destructiveHint: false },
    description:
      "Semantic + full-text search across Specs, Standards, free-form documents, and Decisions in the active Memex. Excludes archived and paused content by default. Returns markdown grouped by source doc, each hit headed by the canonical URL path so the agent can cite and follow up with get_doc. Use BEFORE creating a new Spec (spot overlap), BEFORE writing code that touches a rule (find prior decisions / standards), and whenever the user mentions prior work by topic rather than handle. When you're editing a Spec, the Spec you're in is excluded from results by default (it's already in your Document Context); pass `includeCurrentDoc: true` if you specifically want to see it back.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      query: z.string().describe("Free-text query, or a `spec-N` / `std-N` / `doc-N` handle for direct lookup."),
      kind: z
        .enum(["spec", "standard", "document", "decision"])
        .optional()
        .describe("Restrict to one entity kind. Omit to search every kind."),
      includeArchived: z
        .boolean()
        .optional()
        .describe("Include archived and paused content. Default false."),
      includeCurrentDoc: z
        .boolean()
        .optional()
        .describe(
          "Include hits from the Spec the agent is currently editing. Default false — the current doc is already in your Document Context so it's filtered out to reduce noise. Pass true if you specifically want to see whether your own Spec has matching content; matching hits are tagged `[current doc]`.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Cap on hits returned. Default 8."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const query = input.query as string;
      const kind = input.kind as MemexSearchKind | undefined;
      const includeArchived = input.includeArchived as boolean | undefined;
      const includeCurrentDoc = input.includeCurrentDoc as boolean | undefined;
      const limit = input.limit as number | undefined;

      const memexId = await ctx.resolveMemex(memex);
      const provider = resolveEmbeddingProvider();

      // Self-filter: by default, the in-app agent's current Spec is excluded
      // from results because it's already in the agent's Document Context.
      // Setting `includeCurrentDoc: true` keeps the doc in results; the
      // formatter labels those hits `[current doc]` so the agent recognises
      // them. MCP callers always have `ctx.currentDocId` unset so neither
      // path applies there.
      const excludeDocId =
        ctx.currentDocId && includeCurrentDoc !== true ? ctx.currentDocId : undefined;

      const hits = await searchMemex(memexId, query, {
        kind,
        includeArchived,
        limit,
        provider,
        excludeDocId,
      });
      return formatSearchResults(query, hits, {
        verbose: ctx.verbose,
        currentDocId: includeCurrentDoc === true ? ctx.currentDocId : undefined,
      });
    },
  },

  // ── Issues (spec-112) ─────────────────────────────────────
  // An Issue is a bug or todo raised against a Spec as a whole (NOT anchored to a
  // section/decision/task). It is the human/agent-level backlog primitive. These
  // tools mirror+extend the acs/tasks/decisions machinery — no new infrastructure
  // (s-4). Tenancy is 404-not-403 (std-7) via the service layer; every write goes
  // through mutate() and emits on the unified bus (std-8).
  {
    name: "register_issue",
    annotations: { title: "Register issue", readOnlyHint: false, destructiveHint: false },
    description:
      "Register an Issue (a bug or a todo) against a Spec. Pass `spec_ref` to home it on a " +
      "specific Spec; the Issue belongs to that Spec as a whole (it does NOT anchor to a " +
      "section/decision/task). An Issue may be raised against a Spec in ANY status — draft, " +
      "specify, build, verify, done, paused, archived (no phase guard). " +
      "**Every Issue must be bound to a Spec — a homeless Issue is never persisted (std-5, no " +
      "silent default home).** If you OMIT `spec_ref`, this tool persists NOTHING and instead " +
      "returns a two-option assist so the caller can decide where it lives: (1) turn the issue " +
      "into its OWN new root Spec (pass `promote_to_spec: true` on a follow-up call), or (2) link " +
      "it to the best-suited active Spec — a ranked list of active (not done, not archived) Specs " +
      "found by semantic search over the issue text is included in the assist. Pick one and call " +
      "again with `spec_ref` set (option 2) or `promote_to_spec: true` (option 1).",
    schema: {
      memex: z.string().optional().describe(
        MEMEX_DESC + " (not needed if `spec_ref` is provided — the Memex is inferred from the Spec).",
      ),
      spec_ref: z.string().optional().describe(
        "Canonical ref to the parent Spec, e.g. `mindset/main/specs/spec-3`. OMIT to receive the " +
        "homeless-issue assist (no Issue is persisted) instead of creating one.",
      ),
      title: z.string().describe("One-line summary of the bug/todo."),
      body: z.string().describe(
        "The detail: for a bug, the symptom + reproduction/context; for a todo, the work to be done. " +
        "Carry enough structure that the Issue can be pulled into a Task without re-discovery.",
      ),
      type: z.enum(["bug", "todo"]).describe(
        "`bug` (closes the bug→failing-AC→green-AC→resolved loop) or `todo` (forward-looking human-level backlog).",
      ),
      severity: z.string().optional().describe(
        "Free-text severity (e.g. low / medium / high / critical). Optional.",
      ),
      promote_to_spec: z.boolean().optional().describe(
        "Homeless-issue option (1): with NO `spec_ref`, create a new root Spec (parent_doc_id NULL) " +
        "seeded from the issue title/body and persist NO Issue row (the issue becomes the Spec). " +
        "Ignored when `spec_ref` is set.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const specRef = input.spec_ref as string | undefined;
      const title = input.title as string;
      const body = input.body as string;
      const type = input.type as IssueType;
      const severity = (input.severity as string | undefined) ?? null;
      const promoteToSpecOpt = input.promote_to_spec === true;

      if (!isIssueType(type)) {
        throw new ValidationError(
          `register_issue: invalid type '${type}'. Must be one of: ${ISSUE_TYPES.join(", ")}.`,
        );
      }

      // ── Homed path: a Spec ref was supplied — create the Issue under it. ──
      if (specRef) {
        const resolved = await resolveRefArg(ctx, specRef, "spec_ref");
        if (resolved.entity.kind !== "spec") {
          throw new ValidationError(
            `register_issue: spec_ref must resolve to a Spec; got ${resolved.entity.kind}.`,
          );
        }
        const { memexId, doc, slugs } = resolved;
        const created = await createIssue({
          memexId,
          docId: doc.id,
          title,
          body,
          type,
          severity,
          source: "agent",
          createdByUserId: ctx.userId,
        });
        const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: created.seq });
        if (ctx.verbose) {
          return `Registered Issue ${issueRef} (${type}, status=${created.status}) on ${doc.handle}: "${title}".`;
        }
        return `ref: ${issueRef} [${type}, ${created.status}]`;
      }

      // ── Homeless path: NO Spec ref. We never silently invent a home (std-5). ──
      const memexId = await ctx.resolveMemex(input.memex as string | undefined);

      // Option (1): promote — turn the issue into its OWN new root Spec, persist no
      // Issue row (ac-28: root Spec, parent_doc_id NULL, no orphan Issue).
      if (promoteToSpecOpt) {
        const spec = await createDocDraft(
          memexId,
          title,
          body,
          "spec",
          undefined,
          undefined,
          ctx.userId,
          reqCtx(ctx),
        );
        const slugs = await memexSlugsById(memexId);
        const specRefOut = slugs ? buildDocRef(slugs, spec) : spec.handle;
        if (ctx.verbose) {
          return `Turned the issue into a new root Spec ref: ${specRefOut} "${spec.title}". No Issue row was persisted — the issue is now the Spec.`;
        }
        return `Spec created from issue: ref: ${specRefOut} "${spec.title}".`;
      }

      // No promote flag → return the two-option assist. PERSIST NOTHING (ac-25/ac-26).
      // Option (2) ranking is delegated to suggestActiveSpecsForIssue (below) so the
      // vector-path ranking + active-only filter (ac-27) is testable in isolation.
      const provider = resolveEmbeddingProvider();
      const activeSpecHits = await suggestActiveSpecsForIssue(
        memexId,
        title,
        body,
        provider,
        5,
      );

      const optionTwo =
        activeSpecHits.length > 0
          ? activeSpecHits
              .map(
                (h, i) =>
                  `   ${i + 1}. ${h.path} — "${h.title}" (${h.status}) — call register_issue again with spec_ref: "${h.path}"`,
              )
              .join("\n")
          : "   (no active Spec matched the issue text — use option 1, or name a spec_ref explicitly)";

      return (
        `No Spec ref supplied — an Issue is never persisted without a home (std-5). ` +
        `Nothing was created. Pick where this Issue lives:\n\n` +
        `(1) Turn it into its OWN new Spec — call register_issue again with promote_to_spec: true ` +
        `(creates a root Spec seeded from the issue; no separate Issue row).\n\n` +
        `(2) Link it to the best-suited active Spec — call register_issue again with one of these spec_ref values:\n` +
        optionTwo
      );
    },
  },
  {
    name: "list_issues",
    annotations: { title: "List issues", readOnlyHint: true, destructiveHint: false },
    description:
      "List the Issues registered on a Spec, optionally filtered by `type` ('bug' | 'todo') or " +
      "`status` ('open' | 'converted' | 'resolved' | 'wont_fix'). Ordered by `issue-N` handle.",
    schema: {
      ref: z.string().describe("Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`."),
      type: z.enum(["bug", "todo"]).optional().describe("Filter by Issue type."),
      status: z
        .enum(["open", "converted", "resolved", "wont_fix"])
        .optional()
        .describe("Filter by Issue status."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const type = input.type as IssueType | undefined;
      const status = input.status as IssueStatus | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "spec") {
        throw new ValidationError(
          `list_issues expects a Spec ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const rows = await listIssuesForSpec(memexId, doc.id, { type, status });
      if (rows.length === 0) {
        return `No Issues on ${slugs.namespace}/${slugs.memex}/specs/${doc.handle} matching the filter.`;
      }
      const lines = rows.map((r) => {
        const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: r.seq });
        const sev = r.severity ? `, ${r.severity}` : "";
        return `- ref: ${issueRef} [${r.type}, ${r.status}${sev}] "${r.title}"`;
      });
      return `${rows.length} Issue${rows.length === 1 ? "" : "s"}\n${lines.join("\n")}`;
    },
  },
  {
    name: "get_issue",
    annotations: { title: "Get issue", readOnlyHint: true, destructiveHint: false },
    description:
      "Get a single Issue by canonical ref. Returns the type, status, severity, title, and " +
      "(in verbose mode) the body.",
    schema: {
      ref: z.string().describe("Canonical ref to the Issue, e.g. `mindset/main/specs/spec-3/issues/issue-2`."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "issue") {
        throw new ValidationError(
          `get_issue expects an issue ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      // Re-fetch through the service so tenancy is asserted in the service layer
      // (std-7) rather than relied on from the resolver alone.
      const issue = await getIssueById(memexId, entity.row.id);
      const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: issue.seq });
      const sev = issue.severity ? `, ${issue.severity}` : "";
      if (ctx.verbose) {
        return `ref: ${issueRef} [${issue.type}, ${issue.status}${sev}] "${issue.title}"\n\n${issue.body}`;
      }
      return `ref: ${issueRef} [${issue.type}, ${issue.status}${sev}] "${issue.title}"`;
    },
  },
  {
    name: "update_issue",
    annotations: { title: "Update issue", readOnlyHint: false, destructiveHint: false },
    description:
      "Update an Issue's editable fields: `title`, `body`, and/or `severity`. To change an Issue's " +
      "status to resolved/wont_fix, use `resolve_issue`.",
    schema: {
      ref: z.string().describe("Canonical ref to the Issue, e.g. `mindset/main/specs/spec-3/issues/issue-2`."),
      title: z.string().optional().describe("New one-line summary."),
      body: z.string().optional().describe("New detail/body."),
      severity: z.string().optional().describe("New free-text severity (e.g. low / medium / high / critical)."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "issue") {
        throw new ValidationError(
          `update_issue expects an issue ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const updated = await updateIssue(memexId, entity.row.id, {
        title: input.title as string | undefined,
        body: input.body as string | undefined,
        severity: input.severity as string | undefined,
      });
      const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: updated.seq });
      const sev = updated.severity ? `, ${updated.severity}` : "";
      if (ctx.verbose) {
        return `Updated Issue ${issueRef} [${updated.type}, ${updated.status}${sev}] "${updated.title}".`;
      }
      return `ref: ${issueRef} [${updated.type}, ${updated.status}${sev}]`;
    },
  },
  {
    name: "resolve_issue",
    annotations: { title: "Resolve issue", readOnlyHint: false, destructiveHint: false },
    description:
      "Close out an Issue by transitioning its status to `resolved` (the work is done) or " +
      "`wont_fix` (a deliberate decision not to address it). Use `resolution: 'resolved'` or " +
      "`resolution: 'wont_fix'`.",
    schema: {
      ref: z.string().describe("Canonical ref to the Issue, e.g. `mindset/main/specs/spec-3/issues/issue-2`."),
      resolution: z.enum(["resolved", "wont_fix"]).describe(
        "Target terminal status: `resolved` (addressed) or `wont_fix` (deliberately not addressed).",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolution = input.resolution as "resolved" | "wont_fix";
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "issue") {
        throw new ValidationError(
          `resolve_issue expects an issue ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const updated = await updateIssueStatus(memexId, entity.row.id, resolution);
      const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: updated.seq });
      if (ctx.verbose) {
        return `Resolved Issue ${issueRef} → status=${updated.status} "${updated.title}".`;
      }
      return `ref: ${issueRef} [${updated.type}, ${updated.status}]`;
    },
  },
  {
    name: "convert_issue_to_task",
    annotations: { title: "Convert issue to task", readOnlyHint: false, destructiveHint: false },
    description:
      "Down-bridge: pull an open Issue into an agent Task. ONE atomic operation — it creates the " +
      "Task (seeded from the Issue's title/body/type/severity), mints a verifying implementation " +
      "AC stating the Issue's expected behaviour (parented to the Issue), links the Task to that AC, " +
      "and sets the Issue → converted. A bug-Issue's AC starts RED: write the " +
      "failing reproduction test first, then fix until it goes GREEN — the Issue then auto-resolves " +
      "(converted→resolved) exactly when the Task is complete AND the AC's latest test event is a pass. " +
      "Partial failure rolls everything back.",
    schema: {
      ref: z.string().describe("Canonical ref to the open Issue, e.g. `mindset/main/specs/spec-3/issues/issue-2`."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "issue") {
        throw new ValidationError(
          `convert_issue_to_task expects an issue ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const result = await convertIssueToTask(memexId, entity.row.id);
      const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: result.task.seq });
      const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: result.issue.seq });
      if (ctx.verbose) {
        return (
          `Converted Issue ${issueRef} → Task ${taskRef} "${result.task.title}" (status=not_started). ` +
          `Minted a verifying implementation AC and linked it. The Issue is now status=converted; it ` +
          `auto-resolves when the Task is complete and the AC's latest test event passes.`
        );
      }
      return `ref: ${taskRef} [task, not_started] (from issue ${issueRef}, now converted)`;
    },
  },
  {
    name: "kick_task_to_issue",
    annotations: { title: "Kick task to issue", readOnlyHint: false, destructiveHint: true },
    description:
      "Up-bridge (the FOURTH escalation shape): when an agent Task hits agent-impossible work that " +
      "needs offline / human / external action, push it back up into a human Todo Issue and DELETE the " +
      "dead Task — the durable record becomes the Issue. Pass `reason` describing the offline work " +
      "needed. If the Task originated from an issue→task conversion, the ORIGIN Issue is reverted " +
      "converted→open (with the reason folded in) instead of creating a duplicate — one Issue, not two.",
    schema: {
      ref: z.string().describe("Canonical ref to the agent Task, e.g. `mindset/main/specs/spec-3/tasks/t-2`."),
      reason: z.string().describe(
        "Why the agent cannot complete this Task — the offline / human / external work that's needed.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const reason = input.reason as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "task") {
        throw new ValidationError(
          `kick_task_to_issue expects a task ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const result = await kickTaskToIssue(memexId, entity.row.id, reason);
      const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: result.issue.seq });
      if (ctx.verbose) {
        return result.reverted
          ? `Kicked Task t-${(entity.row as { seq: number }).seq} back: reverted its origin Issue ${issueRef} → open (note folded in) and deleted the Task. One Issue, not two.`
          : `Kicked Task t-${(entity.row as { seq: number }).seq} back: created open todo Issue ${issueRef} "${result.issue.title}" on ${doc.handle} and deleted the Task.`;
      }
      return `ref: ${issueRef} [todo, open]${result.reverted ? " (reverted origin)" : ""} (task deleted)`;
    },
  },
  {
    name: "search_issues",
    annotations: { title: "Search issues", readOnlyHint: true, destructiveHint: false },
    description:
      "Search Issues across the Memex — a scoped wrapper over the unified search restricted to " +
      "`kind: 'issue'`. Returns cross-spec Issue matches ranked by RRF over FTS + vector arms: an " +
      "Issue registered on one Spec is discoverable from another. Excludes archived/paused content " +
      "by default. Use this to spot a pre-existing Issue overlapping work in flight before raising a duplicate.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      query: z.string().describe("Free-text query over Issue title + body."),
      includeArchived: z
        .boolean()
        .optional()
        .describe("Include Issues on archived/paused Specs. Default false."),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Cap on hits returned. Default 8."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const query = input.query as string;
      const includeArchived = input.includeArchived as boolean | undefined;
      const limit = input.limit as number | undefined;

      const memexId = await ctx.resolveMemex(memex);
      const provider = resolveEmbeddingProvider();
      const hits = await searchMemex(memexId, query, {
        kind: "issue",
        includeArchived,
        limit,
        provider,
      });
      return formatSearchResults(query, hits, { verbose: ctx.verbose });
    },
  },

  // ── Roles + assignment (spec-118) ─────────────────────────
  // Per-Spec roles (editor | reviewer) and ticket-style assignment are TWO
  // independent axes (dec-3). Role decides capability + UI posture on a single
  // Spec and sits ABOVE the org access gate (std-4) — it never narrows read
  // access. Storage carries only elevated rows: an 'editor' row exists or the
  // member resolves to the implicit 'reviewer' default, so reading never writes
  // a row, promote is an idempotent INSERT, demote is a DELETE, and a Spec may
  // hold zero editors (dec-5/dec-6, ac-16). Assignment is a separate relation —
  // assigning never implies a role and is allowed for any active org member,
  // including a reviewer (ac-12). Every write flows through mutate() and emits
  // on the unified bus (std-8, ac-20). Tenancy is 404-not-403 via the service
  // layer (std-7). A USER target is given as an email or a user id.
  {
    name: "set_spec_role",
    annotations: { title: "Set Spec role", readOnlyHint: false, destructiveHint: false },
    description:
      "Set a user's role on a Spec: 'editor' (promote — idempotent) or 'reviewer' (demote — removes " +
      "the editor row so the user falls back to the implicit reviewer default). Role is independent of " +
      "assignment (assigning a Spec never changes a role, and vice-versa). There is no last-editor lock: " +
      "demoting the only editor is allowed and leaves the Spec with zero editors (any org member can " +
      "one-click self-promote again). Defaults to 'editor' when `role` is omitted. Identify the user by " +
      "email or user id.",
    schema: {
      ref: z.string().describe("Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`."),
      user: z
        .string()
        .describe("Target user — an email (e.g. `dev@acme.com`) or a user id (UUID)."),
      role: z
        .enum(["editor", "reviewer"])
        .optional()
        .describe("'editor' (promote) or 'reviewer' (demote). Defaults to 'editor'."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const role = (input.role as DocRole | undefined) ?? "editor";
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "spec") {
        throw new ValidationError(
          `set_spec_role expects a Spec ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const target = await resolveUserArg(input.user as string, "user");
      const who = target.email ?? "(unknown)";
      const specRef = buildDocRef(slugs, doc);
      if (role === "editor") {
        await promoteToEditor(memexId, doc.id, target.id, reqCtx(ctx));
        if (ctx.verbose) {
          return `Promoted ${who} to editor on ${specRef}.`;
        }
        return `ref: ${specRef} user=${who} role=editor`;
      }
      await demoteToReviewer(memexId, doc.id, target.id, reqCtx(ctx));
      if (ctx.verbose) {
        return `Demoted ${who} to reviewer on ${specRef} (editor row removed; falls back to the reviewer default).`;
      }
      return `ref: ${specRef} user=${who} role=reviewer`;
    },
  },
  {
    name: "get_spec_roles",
    annotations: { title: "Get Spec roles", readOnlyHint: true, destructiveHint: false },
    description:
      "List the editors of a Spec (the elevated members) and report the caller's own resolved role. " +
      "Reviewers are implicit — they hold no row, so they are not enumerated; a Spec with no editors " +
      "lists none. Read-only: querying never writes a member row.",
    schema: {
      ref: z.string().describe("Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "spec") {
        throw new ValidationError(
          `get_spec_roles expects a Spec ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const [editors, myRole] = await Promise.all([
        listEditors(memexId, doc.id),
        resolveRole(memexId, doc.id, ctx.userId),
      ]);
      const specRef = buildDocRef(slugs, doc);
      // Label by name/email only — never the user id (std-10: no raw UUIDs).
      const label = (e: { name: string | null; email: string | null }) =>
        e.name ?? e.email ?? "(unknown)";
      if (ctx.verbose) {
        const header = `# Roles on ${specRef}\n\nYour role: ${myRole}\n\n## Editors (${editors.length})`;
        if (editors.length === 0) {
          return `${header}\n\n_No editors — every member is an implicit reviewer._`;
        }
        const lines = editors.map((e) => `- ${label(e)} (${e.email ?? "no email"}) — editor`);
        return `${header}\n\n${lines.join("\n")}`;
      }
      const names = editors.map(label).join(", ");
      return `ref: ${specRef} — ${editors.length} editor${editors.length === 1 ? "" : "s"}${
        editors.length ? `: ${names}` : ""
      } (your role: ${myRole})`;
    },
  },
  {
    name: "assign_spec",
    annotations: { title: "Assign Spec", readOnlyHint: false, destructiveHint: false },
    description:
      "Assign a user to a Spec — ticket-style responsibility ('who is moving this Spec NOW'). " +
      "Idempotent: re-assigning an already-assigned user is a no-op. Assignment is INDEPENDENT of role " +
      "(dec-3) — you may assign any active org member, including a reviewer, and assigning NEVER changes " +
      "a role. A Spec supports multiple assignees. Omit `user` to self-assign (the caller). Identify the " +
      "user by email or user id.",
    schema: {
      ref: z.string().describe("Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`."),
      user: z
        .string()
        .optional()
        .describe(
          "Target user — an email or a user id. Omit to self-assign (defaults to the calling user).",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "spec") {
        throw new ValidationError(
          `assign_spec expects a Spec ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const userArg = input.user as string | undefined;
      const target = userArg
        ? await resolveUserArg(userArg, "user")
        : { id: ctx.userId, email: null };
      const who = target.email ?? "(you)";
      await assign(memexId, doc.id, target.id, ctx.userId, reqCtx(ctx));
      const specRef = buildDocRef(slugs, doc);
      if (ctx.verbose) {
        return `Assigned ${who} to ${specRef}.`;
      }
      return `ref: ${specRef} assigned=${who}`;
    },
  },
  {
    name: "unassign_spec",
    annotations: { title: "Unassign Spec", readOnlyHint: false, destructiveHint: false },
    description:
      "Remove a user's assignment from a Spec. Idempotent: unassigning a non-assignee is a no-op. " +
      "Leaves the user's role untouched (assignment and role are independent axes, dec-3). Identify the " +
      "user by email or user id (required — no self-default for the destructive path).",
    schema: {
      ref: z.string().describe("Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`."),
      user: z
        .string()
        .describe("Target user — an email or a user id."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "spec") {
        throw new ValidationError(
          `unassign_spec expects a Spec ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const target = await resolveUserArg(input.user as string, "user");
      const who = target.email ?? "(unknown)";
      await unassign(memexId, doc.id, target.id, reqCtx(ctx));
      const specRef = buildDocRef(slugs, doc);
      if (ctx.verbose) {
        return `Unassigned ${who} from ${specRef}.`;
      }
      return `ref: ${specRef} unassigned=${who}`;
    },
  },

  // ── Standards (named verbs) — RESTORED (spec-143 dec-1) ───
  // The `search_standards` spec that lived here is REMOVED (b-34 D-5);
  // `search_memex({ kind: 'standard' })` is the replacement and the
  // migration-map entry catches old callers. The standards-only verbs
  // (flag_drift, propose_standard_change) were re-enabled by spec-143 dec-1
  // (the half of spec-63 dec-6 that was blocked on the standards tooling
  // returning) and registered in the shared tool manifest (std-16). Their
  // write path lives in services/standards.ts and enforces the standards-only
  // invariant via loadOwnedStandard.
  {
    name: "flag_drift",
    annotations: { title: "Flag Standard drift", readOnlyHint: false, destructiveHint: false },
    description:
      "Flag drift on a standard section — post a typed `drift` comment (sourced 'agent') describing the gap between the rule and observed reality. Drift often surfaces *mid-change*, not at the start of a task: stay watchful as you implement and flag the moment you see the gap. If the rule itself is wrong (not just out-of-sync with code), use `propose_standard_change` instead.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the standard section, e.g. `<ns>/<mx>/standards/std-7/sections/s-3` — the same `ref:` form get_doc / search_memex emit. NOT a UUID.",
        ),
      observation: z
        .string()
        .describe("What the agent observed that diverges from the standard rule"),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const observation = input.observation as string;

      // spec-143 ac-14: address the section by canonical ref, not a raw UUID
      // (see resolveStandardSectionRef).
      const { memexId, sectionId } = await resolveStandardSectionRef(ctx, ref);
      // spec-156 W2 (FINDING 3): thread the invoking surface so the
      // standard_drift event is attributed to the actor (mcp vs in_app_agent)
      // instead of falling back to channel 'server' / actorKind 'system'.
      // Same idiom as the update_doc tag path above (tagCtx).
      const comment = await flagDrift(memexId, sectionId, observation, {}, {
        channel: ctx.channel ?? "mcp",
      });
      // b-36 D-8: emit the affected entity as a canonical `ref:` (the drift
      // comment on the standard), never a raw UUID. The drift comment lives
      // under the standard's std-N handle and so has a ref. Load the owning
      // standard to build it.
      const commentRef = await buildStandardCommentRef(memexId, sectionId, comment.seq);
      if (ctx.verbose) {
        return commentRef
          ? `Drift flagged (ref: ${commentRef}, source=agent).`
          : `Drift flagged (source=agent).`;
      }
      return commentRef ? `Drift flagged (ref: ${commentRef}).` : `Drift flagged.`;
    },
  },
  {
    name: "propose_standard_change",
    annotations: { title: "Propose Standard change", readOnlyHint: false, destructiveHint: false },
    description:
      "Propose a corrected version of a standard section. Lands as a typed `plan_revision` comment (sourced 'agent') containing the full proposed replacement and a rationale. The standard owner reviews + accepts in the React UI Drift Inbox.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the standard section, e.g. `<ns>/<mx>/standards/std-7/sections/s-3` — the same `ref:` form get_doc / search_memex emit. NOT a UUID.",
        ),
      proposedContent: z
        .string()
        .describe("The full replacement markdown for the section."),
      rationale: z
        .string()
        .optional()
        .describe("Why this change is needed (optional but strongly recommended)."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const proposedContent = input.proposedContent as string;
      const rationale = input.rationale as string | undefined;

      // spec-143 ac-14: address the section by canonical ref, not a raw UUID
      // (see resolveStandardSectionRef).
      const { memexId, sectionId } = await resolveStandardSectionRef(ctx, ref);
      // spec-156 W2 (FINDING 3): thread the invoking surface so the
      // standard_drift event carries channel/user attribution (mcp vs
      // in_app_agent), not the channel 'server' / actorKind 'system' default.
      const result = await proposeStandardChange(
        memexId,
        sectionId,
        proposedContent,
        rationale,
        {},
        { channel: ctx.channel ?? "mcp" },
      );
      // b-36 D-8: emit the canonical `ref:` for the plan_revision comment that
      // landed on the standard — never a raw UUID. proposeStandardChange
      // returns the owning standard, so build the ref directly from it.
      const slugs = await memexSlugsById(memexId);
      const commentRef = slugs
        ? buildChildRef(slugs, result.standard, { type: "comments", seq: result.comment.seq })
        : null;
      const sectionLabel = result.section.title ?? result.section.sectionType;
      if (ctx.verbose) {
        return commentRef
          ? `Proposed change recorded on ${result.standard.handle} section "${sectionLabel}" (ref: ${commentRef}, source=agent).`
          : `Proposed change recorded on ${result.standard.handle} section "${sectionLabel}" (source=agent).`;
      }
      return commentRef
        ? `Proposed change recorded on ${result.standard.handle} section "${sectionLabel}" (ref: ${commentRef}).`
        : `Proposed change recorded on ${result.standard.handle} section "${sectionLabel}".`;
    },
  },
  // (search_standards spec deleted by b-34 T-5 — replaced by the live
  // search_memex spec above.)

  // ── Codebase intelligence ─────────────────────────────────
  // TEMPORARILY DISABLED — codebase tools are commented out (both MCP + React UI agent).
  // To restore: delete the `/*` below and the matching `*/` before the closing `];` of toolSpecs.
  /*
  {
    name: "list_repos",
    annotations: { title: "List repos", readOnlyHint: true, destructiveHint: false },
    description:
      "List all repos ingested into a Memex with name, url, default branch, last-synced timestamp. Call first to discover what's available.",
    schema: { memex: z.string().optional().describe(MEMEX_DESC), verbose: VERBOSE_FIELD },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const memexId = await ctx.resolveMemex(memex);
      const rows = await listRepos(memexId);

      if (ctx.verbose) {
        if (rows.length === 0) return "No repos ingested into this Memex yet.";
        const lines = rows.map((r) => {
          const synced = r.lastSyncedAt
            ? new Date(r.lastSyncedAt).toISOString().slice(0, 10)
            : "never";
          return `- ${r.name} (${r.url}) — branch ${r.defaultBranch ?? "main"}, last synced ${synced}`;
        });
        return `Repos in this Memex:\n${lines.join("\n")}`;
      }

      if (rows.length === 0) return "No repos ingested into this Memex yet.";
      return (
        "Repos:\n" +
        rows
          .map(
            (r) =>
              `- ${r.name} (uuid: ${r.id}) (${r.url}) — branch ${r.defaultBranch ?? "main"}, last synced ${r.lastSyncedAt ? new Date(r.lastSyncedAt).toISOString().slice(0, 10) : "never"}`,
          )
          .join("\n")
      );
    },
  },
  {
    name: "get_repo",
    annotations: { title: "Get repo", readOnlyHint: true, destructiveHint: false },
    description:
      "Orient on a repo: file/symbol/endpoint/domain counts, tech stack, detected domains, structural conventions. Replaces get_repo_overview. Always call this first before drilling into a codebase.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;

      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      const [counts, techStack, domains, structure] = await Promise.all([
        getRepoOverviewCounts(repo.id),
        listTechStack(repo.id),
        listDomains(repo.id),
        listStructure(repo.id),
      ]);

      if (ctx.verbose) {
        return formatRepoOverview(repo, counts, techStack, domains, structure);
      }
      const lines: string[] = [];
      lines.push(
        `${repo.name} (uuid: ${repo.id}): ${counts.files} files, ${counts.symbols} symbols, ${counts.endpoints} endpoints, ${counts.domains} domains`,
      );
      if (techStack.length > 0)
        lines.push(`Tech: ${techStack.map((t) => `${t.layer}=${t.name}`).join(", ")}`);
      if (domains.length > 0)
        lines.push(
          `Domains: ${domains.map((d) => `${d.name} (${d.fileCount} files)`).join(", ")}`,
        );
      if (structure.length > 0)
        lines.push(
          `Conventions: ${structure.map((s) => `${s.kind}=${s.pathPattern}`).join(", ")}`,
        );
      return lines.join("\n");
    },
  },
  {
    name: "update_repo",
    annotations: { title: "Update repo", readOnlyHint: false, destructiveHint: false },
    description:
      "Update a repo's metadata. Today: `domainAliases` attaches business names to an auto-detected domain so future queries can scope by natural language. Replaces set_repo_domain_aliases.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      domainAliases: z
        .object({
          domainName: z.string().describe("The detected domain name (from get_repo)."),
          aliases: z.array(z.string()).describe("Business names the team uses."),
          description: z.string().optional(),
        })
        .optional()
        .describe("Attach business names to a detected domain so future queries can scope by natural language."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;
      const aliases = input.domainAliases as
        | { domainName: string; aliases: string[]; description?: string }
        | undefined;

      if (!aliases) {
        throw new ValidationError(
          "update_repo currently requires `domainAliases`. Other fields TBD.",
        );
      }
      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      await setDomainAliases(repo.id, aliases.domainName, aliases.aliases, aliases.description ?? null);

      if (ctx.verbose) {
        return formatAdminAck(
          `Set aliases on domain \`${aliases.domainName}\`: ${aliases.aliases.join(", ")}`,
        );
      }
      return `Set aliases on domain '${aliases.domainName}': ${aliases.aliases.join(", ")}`;
    },
  },
  {
    name: "list_symbols",
    annotations: { title: "List symbols", readOnlyHint: true, destructiveHint: false },
    description:
      "List symbols in a repo. Filter by `query` (case-insensitive partial name match), `kind` (function/class/method/interface/type/enum/constant/field/endpoint), `domain` (alias scopes by path), `framework` (for endpoints), `exportedOnly`. " +
      "When `kind='endpoint'`, returns HTTP route registrations with handlers and signatures (replaces get_endpoints). " +
      "Replaces find_symbol, get_endpoints.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      query: z
        .string()
        .optional()
        .describe("Partial symbol name, case-insensitive. Optional for kind='endpoint'."),
      kind: z
        .string()
        .optional()
        .describe("function/class/method/interface/type/enum/constant/field/endpoint"),
      domain: z.string().optional().describe("Domain alias to scope by — restricts the search to files inside that domain's path."),
      framework: z.string().optional().describe("Only meaningful for kind='endpoint'."),
      exportedOnly: z.boolean().optional().describe("If true, exclude non-exported symbols."),
      limit: z.number().optional().describe("Cap on the number of rows returned."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;
      const query = input.query as string | undefined;
      const kind = input.kind as string | undefined;
      const domain = input.domain as string | undefined;
      const framework = input.framework as string | undefined;
      const exportedOnly = input.exportedOnly as boolean | undefined;
      const limit = input.limit as number | undefined;

      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      const pathLike = await pathLikeForDomain(repo.id, domain);

      if (kind === "endpoint") {
        const rows = await listEndpoints(repo.id, { pathLike, framework });
        if (ctx.verbose) return formatEndpointList(rows);
        if (rows.length === 0) return "No endpoints detected.";
        return rows
          .map(
            (r) =>
              `- ${r.method} ${r.path} → ${r.handlerName ?? "?"} @ ${r.filePath}:${r.lineNumber ?? "?"} (uuid: ${r.id})`,
          )
          .join("\n");
      }

      if (!query) {
        throw new ValidationError("list_symbols requires `query` (unless kind='endpoint').");
      }
      const rows = await findSymbols(repo.id, query, { kind, pathLike, exportedOnly, limit });

      if (ctx.verbose) return formatSymbolList(rows);
      if (rows.length === 0) return `No symbols matched '${query}'.`;
      return rows
        .map(
          (r) =>
            `- ${r.name} [${r.kind}] @ ${r.filePath}:${r.lineStart ?? "?"}-${r.lineEnd ?? "?"} (uuid: ${r.id})`,
        )
        .join("\n");
    },
  },
  {
    name: "get_symbol",
    annotations: { title: "Get symbol", readOnlyHint: true, destructiveHint: false },
    description:
      "Inspect a symbol or file with optional include flags. Replaces get_dependencies, get_impact, get_call_graph.\n" +
      "Pass either:\n" +
      "  - `symbolId`: a symbol UUID (from list_symbols). Combine with `include: ['calls']` for the call graph.\n" +
      "  - `fileId` or `path`: a file. Combine with `include: ['dependencies']` (import graph) and/or `['impact']` (importer-graph blast radius).\n" +
      "Other args: `direction` (callers/callees/both for calls; imports/importers/both for dependencies), `depth` (impact recursion, default 3), `includeNoise` (calls only), `limit`.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      symbolId: z.string().optional().describe("Symbol UUID (from list_symbols)."),
      fileId: z.string().optional().describe("File UUID. Use with `include: ['dependencies']` or `['impact']`."),
      path: z.string().optional().describe("Partial file path."),
      include: z
        .array(z.enum(["dependencies", "impact", "calls"]))
        .optional()
        .describe("Which views to include in the response."),
      direction: z
        .string()
        .optional()
        .describe(
          "'imports'|'importers'|'both' for dependencies; 'callers'|'callees'|'both' for calls.",
        ),
      depth: z.number().optional().describe("Recursion depth for impact (default 3)."),
      includeNoise: z.boolean().optional().describe("Calls only — include framework / standard-library noise in the call graph."),
      limit: z.number().optional().describe("Cap on the number of rows returned."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;
      const symbolId = input.symbolId as string | undefined;
      const fileId = input.fileId as string | undefined;
      const filePath = input.path as string | undefined;
      const include = input.include as string[] | undefined;
      const direction = input.direction as string | undefined;
      const depth = input.depth as number | undefined;
      const includeNoise = input.includeNoise as boolean | undefined;
      const limit = input.limit as number | undefined;

      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      const wants = new Set(include ?? []);

      if (wants.size === 0) {
        throw new ValidationError(
          "get_symbol requires `include` with at least one of: 'dependencies' (file), 'impact' (file), 'calls' (symbol).",
        );
      }

      const sections: string[] = [];

      // File-scoped operations
      if (wants.has("dependencies") || wants.has("impact")) {
        if (!fileId && !filePath) {
          throw new ValidationError("dependencies/impact require fileId or path.");
        }
        let resolvedId = fileId;
        let resolvedPath = filePath ?? "";
        if (!resolvedId && filePath) {
          const f = await getFileByPath(repo.id, filePath);
          if (!f) throw new ValidationError(`No file matches path '${filePath}'`);
          resolvedId = f.id;
          resolvedPath = f.path;
        } else if (resolvedId) {
          const f = await getFileById(repo.id, resolvedId);
          if (!f) throw new ValidationError(`No file with id ${resolvedId} in this repo`);
          resolvedPath = f.path;
        }

        if (wants.has("dependencies")) {
          const dir = (direction as "imports" | "importers" | "both" | undefined) ?? "both";
          const rows = await getImportsForFile(repo.id, resolvedId!, dir);
          if (ctx.verbose) {
            sections.push(formatDependencyList(rows, dir, resolvedPath));
          } else if (rows.length === 0) {
            sections.push(`Dependencies (${dir}) for ${resolvedPath}: none.`);
          } else {
            const lines = rows.map((r) => {
              const other = r.toFileId ? r.toPath : r.toPackage;
              const names =
                r.importedSymbols && r.importedSymbols.length > 0
                  ? ` {${r.importedSymbols.join(", ")}}`
                  : "";
              return `- ${r.kind}: ${other ?? "?"}${names}`;
            });
            sections.push(`Dependencies (${dir}) for ${resolvedPath}:\n${lines.join("\n")}`);
          }
        }
        if (wants.has("impact")) {
          const d = depth ?? 3;
          const rows = await getFileImpact(repo.id, resolvedId!, d);
          if (ctx.verbose) {
            sections.push(formatImpact(resolvedPath, d, rows));
          } else if (rows.length === 0) {
            sections.push(`${resolvedPath}: 0 files affected at depth ${d}.`);
          } else {
            sections.push(
              `${resolvedPath}: ${rows.length} files affected at depth ${d}.\n` +
                rows.map((r) => `- d${r.distance}: ${r.path}`).join("\n"),
            );
          }
        }
      }

      // Symbol-scoped operations
      if (wants.has("calls")) {
        if (!symbolId) throw new ValidationError("calls requires symbolId.");
        const dir = (direction as "callers" | "callees" | "both" | undefined) ?? "both";
        const opts = { includeNoise, limit };
        const [callers, callees] = await Promise.all([
          dir === "callees" ? Promise.resolve([]) : getCallersOf(repo.id, symbolId, opts),
          dir === "callers" ? Promise.resolve([]) : getCalleesOf(repo.id, symbolId, opts),
        ]);
        if (ctx.verbose) {
          sections.push(formatCallGraph(symbolId, dir, callers, callees));
        } else {
          const lines: string[] = [];
          if (callers.length > 0) {
            lines.push(`Callers (${callers.length}):`);
            lines.push(
              ...callers.map(
                (c) =>
                  `- ${c.fromSymbolName} @ ${c.fromPath}:${c.lineNumber ?? "?"} [${c.resolutionKind ?? "?"}]`,
              ),
            );
          }
          if (callees.length > 0) {
            lines.push(`Callees (${callees.length}):`);
            lines.push(
              ...callees.map(
                (c) =>
                  `- ${c.toSymbolName ?? c.toName} @ ${c.toPath ?? "external"}:${c.lineNumber ?? "?"} [${c.resolutionKind ?? "?"}]`,
              ),
            );
          }
          sections.push(lines.length > 0 ? lines.join("\n") : "No calls.");
        }
      }

      return sections.join("\n\n");
    },
  },
  {
    name: "get_file",
    annotations: { title: "Get file content", readOnlyHint: true, destructiveHint: false },
    description:
      "Read the full source of a file. Provide fileId or partial path. Replaces get_file_content.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      fileId: z.string().optional().describe("File UUID. Provide either fileId or path."),
      path: z.string().optional().describe("Partial file path. Provide either fileId or path."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;
      const fileId = input.fileId as string | undefined;
      const filePath = input.path as string | undefined;

      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      if (!fileId && !filePath) {
        throw new ValidationError("Provide either fileId or path");
      }
      const file = fileId
        ? await getFileById(repo.id, fileId)
        : await getFileByPath(repo.id, filePath!);
      if (!file) throw new NotFoundError("No file found in this repo");

      if (ctx.verbose) return formatFileContent(file);
      return `${file.path}:\n\n${file.content ?? ""}`;
    },
  },
  {
    name: "code_search",
    annotations: { title: "Code search", readOnlyHint: true, destructiveHint: false },
    description:
      "Hybrid code search: semantic (meaning) + lexical (keywords), merged via reciprocal rank fusion. " +
      "STRONGLY prefer `phrases` (array, two phrasings at different abstraction levels) over `phrase`. Each phrase becomes an independent ranker; RRF fuses them. " +
      "Also pass `keywords` (2-5 specific identifiers) to drive the lexical FTS side.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      phrase: z.string().optional().describe("Single semantic phrase. Prefer `phrases` for better recall."),
      phrases: z.array(z.string()).optional().describe("2+ phrasings at different abstraction levels — each becomes an independent ranker fused via RRF."),
      keywords: z.array(z.string()).optional().describe("2-5 specific identifiers driving the lexical FTS side."),
      limit: z.number().optional().describe("Cap on hits returned."),
      model: z.string().optional().describe("Override the embedding model (defaults to the repo's configured model)."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;
      const phrase = input.phrase as string | undefined;
      const phrases = input.phrases as string[] | undefined;
      const keywords = input.keywords as string[] | undefined;
      const limit = input.limit as number | undefined;
      const model = input.model as string | undefined;

      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      const { hits, warnings } = await codeSearch(repo.id, {
        phrase,
        phrases,
        keywords,
        limit,
        model,
      });

      if (ctx.verbose) {
        const displayPhrases = [...(phrase ? [phrase] : []), ...(phrases ?? [])];
        return formatCodeSearchResults(displayPhrases, keywords ?? null, hits, warnings);
      }

      const lines: string[] = [];
      if (warnings.length > 0) lines.push(`warnings: ${warnings.join("; ")}`);
      if (hits.length === 0) {
        lines.push("No matches.");
      } else {
        for (const h of hits) {
          const loc =
            h.symbolName && h.lineStart
              ? `${h.filePath}:${h.lineStart} · ${h.symbolName} [${h.symbolKind ?? "?"}]`
              : `${h.filePath} (file)`;
          lines.push(`- [${h.source}] ${loc} (rrf ${h.rrfScore.toFixed(4)})`);
        }
      }
      return lines.join("\n");
    },
  },
  */

  // ── Discord integration (spec-138) ───────────────────────────
  {
    name: "memex__send_discord_message",
    annotations: { title: "Send Discord message", readOnlyHint: false, destructiveHint: false },
    description:
      "Send a message to a Discord channel via the org's configured webhook URL. " +
      "Use for AI → human handoffs: status updates, notifications, or flagging decisions without leaving the agent workflow. " +
      "Requires an org admin to have configured a Discord webhook at /settings/integrations. " +
      "Supports standard Markdown — **bold**, *italic*, `code`, [links](url), # headings — rendered natively by Discord (no conversion applied).",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      channelOrUser: z
        .string()
        .optional()
        .describe(
          "Ignored for Discord (the webhook URL already encodes the target channel). " +
          "Accepted for API parity with memex__send_slack_message.",
        ),
      text: z
        .string()
        .describe(
          "Message text. Standard Markdown is rendered natively by Discord — " +
          "**bold**, *italic*, `code`, [text](url), # headings all work as-is.",
        ),
      specRef: z
        .string()
        .optional()
        .describe(
          "Canonical ref of the originating Spec (e.g. `mindset-prod/memex-building-itself/specs/spec-138`). " +
          "When provided, a footer embed with a clickable link to the Spec is appended. " +
          "Always pass this when sending from inside a Spec context.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const text = input.text as string;
      const specRef = input.specRef as string | undefined;

      const memexId = await ctx.resolveMemex(input.memex as string | undefined);
      let orgId = await getOrgIdForMemex(memexId);

      // Personal Memex has no org — auto-discover an org the user belongs to
      // that has a Discord webhook configured (common case: one org, one webhook).
      if (!orgId) {
        const { orgMemberships, orgDiscordWebhooks } = await import("../db/schema.js");
        const memberships = await db
          .select({ orgId: orgMemberships.orgId })
          .from(orgMemberships)
          .where(
            and(
              eq(orgMemberships.userId, ctx.userId),
              eq(orgMemberships.status, "active"),
            ),
          );
        const orgIds = memberships.map((m) => m.orgId);
        if (orgIds.length > 0) {
          const webhooks = await db
            .select({ orgId: orgDiscordWebhooks.orgId })
            .from(orgDiscordWebhooks)
            .where(inArray(orgDiscordWebhooks.orgId, orgIds));
          if (webhooks.length === 1) {
            orgId = webhooks[0].orgId;
          } else if (webhooks.length > 1) {
            throw new ValidationError(
              "Multiple orgs have Discord webhooks configured. Pass the `memex` parameter to specify which org to use.",
            );
          }
        }
      }

      if (!orgId) {
        throw new ValidationError(
          "No Discord webhook configured. Ask an org admin to add one at /settings/integrations.",
        );
      }

      const webhook = await getDiscordWebhook(orgId);
      if (!webhook) {
        throw new ValidationError(
          "No Discord webhook configured for this org. Ask an admin to add one at /settings/integrations.",
        );
      }

      const explicitSpec = specRef
        ? await ctx.resolveRef(specRef).catch(() => null)
        : null;

      // Auto-build the footer from the current doc when specRef is omitted.
      // The /chat route always passes currentDocId when the agent is bound to a
      // Spec — fall back to it so the footer is consistent without requiring the
      // agent to remember to pass the parameter.
      // Format mirrors the Slack context block: **Spec:** [title](url) _(handle)_  ·  Sent via Memex
      const embedFooter = await (async () => {
        const buildDescription = (title: string, _handle: string, url: string) =>
          `**Spec:** [${title}](${url})`;

        if (explicitSpec) {
          const url = `${buildTenantUrl(explicitSpec.slugs)}/specs/${explicitSpec.doc.handle}`;
          return { description: buildDescription(explicitSpec.doc.title, explicitSpec.doc.handle, url) };
        }
        if (!ctx.currentDocId) return undefined;
        const [doc, slugs] = await Promise.all([
          db.query.documents.findFirst({ where: eq(documents.id, ctx.currentDocId) }),
          memexSlugsById(memexId),
        ]);
        if (!doc || !slugs) return undefined;
        const url = `${buildTenantUrl(slugs)}/specs/${doc.handle}`;
        return { description: buildDescription(doc.title, doc.handle, url) };
      })();

      await postToDiscord(webhook.webhookUrl, text, embedFooter);

      return embedFooter
        ? `sent to Discord channel ${webhook.channelName ?? webhook.webhookUrl} with Spec footer`
        : `sent to Discord channel ${webhook.channelName ?? webhook.webhookUrl}`;
    },
  },

  // ── Slack integration (doc-23 T-6) ────────────────────────
  {
    name: "memex__send_slack_message",
    annotations: { title: "Send Slack message", readOnlyHint: false, destructiveHint: false },
    description:
      "Send a Slack message as the current user via their connected Slack identity. " +
      "Use for AI → human handoffs: pinging a teammate for input, sending a status update, or flagging a question without leaving the agent workflow. " +
      "Messages appear in Slack attributed to the user — not a bot. " +
      "Requires the user to have connected Slack at /settings/integrations. " +
      "Target can be a channel (`#general`, `C0123456`), a DM user ID (`U0123456`), or a display name (`@christine` / `Christine Lee`) which is resolved via the workspace directory.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      channelOrUser: z
        .string()
        .describe(
          "Slack target: a channel name (`#general`), channel ID (`C0123456`), " +
          "user ID (`U0123456`), or display name (`@christine` / `Christine Lee`). " +
          "Display names are resolved against the workspace directory.",
        ),
      text: z
        .string()
        .describe(
          "Message text. Supports Markdown — **bold**, *italic*, `code`, [text](url), # Heading. " +
          "Converted to Slack mrkdwn before sending. `<@U0123456>` mention syntax is supported inline.",
        ),
      specRef: z
        .string()
        .optional()
        .describe(
          "Canonical ref of the originating Spec (e.g. `mindset-prod/memex-building-itself/specs/spec-71`). " +
          "When provided, a context block footer with a clickable link to the Spec is appended. " +
          "Always pass this when sending from inside a Spec context.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const channelOrUser = input.channelOrUser as string;
      const text = markdownToMrkdwn(input.text as string);
      const specRef = input.specRef as string | undefined;

      // Resolve org from active memex — null for personal memexes (uses personal Slack token).
      const memexId = await ctx.resolveMemex(input.memex as string | undefined);
      const orgId = await getOrgIdForMemex(memexId);

      const slackClient = await getSlackClientForUser(ctx.userId, orgId).catch((err) => {
        if (err instanceof SlackClientError && err.code === "not_connected") {
          throw new ValidationError(
            "Slack not connected for this org. Ask the user to visit /settings/integrations to connect their Slack account.",
          );
        }
        throw err;
      });

      // Resolve the target:
      //   - Slack IDs (U…, W…, C…, G…, D…) → pass through directly
      //   - #channel-name → pass through directly (Slack API accepts this natively)
      //   - display name (@christine, "Christine Lee") → directory lookup
      let channel: string;
      if (/^[UCGWDB][A-Z0-9]{6,}$/i.test(channelOrUser.trim()) || channelOrUser.trim().startsWith('#')) {
        channel = channelOrUser.trim();
      } else {
        const resolved = await resolveSlackUser(ctx.userId, orgId, channelOrUser).catch((err) => {
          if (err instanceof SlackUserResolutionError) {
            if (err.code === "ambiguous") {
              const names = err.candidates?.map((c) => c.displayName).join(", ") ?? "";
              throw new ValidationError(
                `Ambiguous Slack target "${channelOrUser}". Matching users: ${names}. Please be more specific.`,
              );
            }
            if (err.code === "not_found") {
              throw new ValidationError(
                `No Slack user matching "${channelOrUser}". Try the exact display name or use a channel name like #general.`,
              );
            }
            throw new ValidationError(`Slack directory error: ${err.message}`);
          }
          throw err;
        });
        channel = resolved.slackUserId;
      }

      const [botUserId, specDoc, explicitSpec] = await Promise.all([
        getSlackBotUserId(ctx.userId, orgId),
        ctx.currentDocId
          ? getDoc(memexId, ctx.currentDocId).catch(() => null)
          : Promise.resolve(null),
        specRef
          ? ctx.resolveRef(specRef).catch(() => null)
          : Promise.resolve(null),
      ]);

      const sentBy = botUserId ? `<@${botUserId}>` : "Memex";

      let footerText: string;
      if (explicitSpec) {
        const specUrl = `${buildTenantUrl(explicitSpec.slugs)}/specs/${explicitSpec.doc.handle}`;
        footerText = `📄 From: <${specUrl}|${explicitSpec.doc.handle}>  ·  Sent via ${sentBy}`;
      } else {
        const specLine = specDoc ? `*Spec:* ${specDoc.title} _(${specDoc.handle})_` : null;
        footerText = specLine ? `${specLine}  ·  Sent via ${sentBy}` : `Sent via ${sentBy}`;
      }

      const blocks = [
        { type: "section", text: { type: "mrkdwn", text } },
        { type: "context", elements: [{ type: "mrkdwn", text: footerText }] },
      ];
      const result = await slackClient.postMessage({ channel, text, blocks }).catch((err) => {
        if (err instanceof SlackClientError) {
          if (err.code === "reconnect_required") {
            throw new ValidationError(
              "Slack token revoked. Ask the user to reconnect at /settings/integrations.",
            );
          }
          throw new ValidationError(`Slack error (${err.code}): ${err.message}`);
        }
        throw err;
      });

      return `sent: ts=${result.ts} channel=${result.channel}`;
    },
  },
];

// Avoid unused-import warnings for tools that only reference these symbols
// indirectly through formatters.
void documents;
void eq;
void and;
void db;
void parseTypeFilter;

// ══════════════════════════════════════
// b-67 t-2: manifest ↔ specs cross-check
// ══════════════════════════════════════
//
// Returns the symmetric difference between the tool names declared in this
// file's `toolSpecs` array and the names in `@memex/shared`'s `toolManifest`,
// EXCLUDING `list_memexes` (which is registered inline in `mcp/tools.ts`, not
// in `toolSpecs`, but IS in the manifest). When the two are in lockstep both
// arrays are empty.
//
// Side-effect-free and non-throwing at module load — the b-67 regression test
// calls this (and the broader MCP-surface check) and turns a non-empty result
// into a failure that points the reader at `packages/shared/src/tool-manifest.ts`.
export function manifestVsSpecsDiff(): {
  inSpecsNotManifest: string[];
  inManifestNotSpecs: string[];
} {
  const specNames = new Set(toolSpecs.map((s) => s.name));
  // `list_memexes` is the MCP-only inline tool — present in the manifest but
  // never in `toolSpecs`, so excluding it keeps a matched catalogue empty.
  const manifestNames = new Set(
    toolManifest.map((e) => e.name).filter((name) => name !== "list_memexes"),
  );

  const inSpecsNotManifest = [...specNames]
    .filter((name) => !manifestNames.has(name))
    .sort();
  const inManifestNotSpecs = [...manifestNames]
    .filter((name) => !specNames.has(name))
    .sort();

  return { inSpecsNotManifest, inManifestNotSpecs };
}
