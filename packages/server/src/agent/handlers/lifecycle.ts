// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).

import {
  z,
} from "zod";
import {
  buildDocRef,
} from "../../mcp/refs.js";
import {
  getDoc,
  updateDocStatus,
} from "../../services/documents.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  formatTerseSpecPhase,
} from "../../formatting/formatters.js";
import {
  searchMemex,
  formatSearchResults,
  type MemexSearchKind,
} from "../../services/memex-search.js";
import {
  resolveEmbeddingProvider,
} from "../../services/embedding-provider.js";
import {
  assessPhaseTransition,
  formatPhaseAssessment,
  isPhaseTarget,
} from "../../services/phase-assessment.js";
import {
  timeAgo,
  capitalizeDisplayName,
} from "@memex/shared";
import {
  assessNarrativeFreshness,
  markNarrativeConsolidated,
} from "../../services/narrative.js";
import {
  assessCommentsStatus,
} from "../../services/comment-assessment.js";
import {
  MEMEX_DESC,
  VERBOSE_FIELD,
  formatState,
  fullDocState,
  isDocLikeKind,
  loadSpec,
  reqCtx,
  resolveRefArg,
  type ToolSpec,
} from "./shared.js";

export const lifecycleTools: ToolSpec[] = [
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
      facetAck: z
        .boolean()
        .optional()
        .describe(
          "spec-340 facet gate: pass true to ACKNOWLEDGE the standards the facet routing surfaced, " +
          "after re-checking them against the actual diff. Pass on a second call to assess_spec once " +
          "you've consulted them. Ignored unless target='verify' or 'done'.",
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
      const facetAck = input.facetAck as boolean | undefined;

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
          facetAck,
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
];
