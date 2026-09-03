// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).

import {
  z,
} from "zod";
import {
  buildChildRef,
} from "../../mcp/refs.js";
import {
  createDecision,
  getDecision,
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
} from "../../services/decisions.js";
import {
  listAcsForBriefWithVerification,
} from "../../services/acs.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  type SketchAc,
} from "../../mcp/ac-test-sketch.js";
import {
  resolveEmbeddingProvider,
} from "../../services/embedding-provider.js";
// spec-423 dec-5/dec-6 — the facet ballot is FORCED at create_decision; resolve_decision
// reuses that stored ballot (footer only) and never forces one. Vocab via
// facet-ballot.ts → facet-vocab.ts (NO-LLM); classifier engine never imported here.
import { requireBallotForMemex, decisionBallotTrueFacets } from "../../services/facet-ballot.js";
import { parseBallotArg, storeRouteAndReadout, routeAndReadout } from "../../services/facet-consume.js";
import {
  VERBOSE_FIELD,
  formatState,
  fullDocState,
  isDocLikeKind,
  relatedIssuesForDecision,
  reqCtx,
  resolveRefArg,
  type ToolSpec,
} from "./tool-contract.js";

export const decisionsTools: ToolSpec[] = [
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
      // spec-423 — facets are declared at decision CREATION so the governing standards
      // surface WHILE the decision is being formed (not only at resolve). REQUIRED where
      // the Memex has a vocabulary (create_decision FAILS without it); same shape + re-hand
      // as create_task. The resolution then lands already pointed at those standards.
      facetBallot: z
        .object({
          verdict: z.record(z.string(), z.boolean()).describe("Complete map: facet slug → true/false."),
          none: z.boolean().describe("true = this work governs no facet (every verdict false)."),
        })
        .optional()
        .describe(
          "REQUIRED where this Memex has a facet vocabulary: create_decision FAILS without a complete ballot. The facets this decision's subject touches, which surface the governing standards at creation so the resolution is informed by them. First call the `facets` tool (verb:'list') to read the vocabulary, then pass a true/false verdict for EVERY facet, or none:true for honest no-facet work.",
        ),
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
      // FACET BALLOT — REQUIRED at creation where the Memex has a vocabulary, so the
      // governing standards surface now (validate BEFORE creating, so no orphan decision).
      const hasBallot = input.facetBallot !== undefined;
      const ballot = parseBallotArg(input.facetBallot);
      const vocab = await requireBallotForMemex(
        memexId,
        // spec-499 dec-2: hand over the argument NAMES this call actually arrived with
        // (never their values) so an absent ballot is diagnosed — a near-miss key gets
        // named, and a genuine drop is evidenced by the names that did make it.
        { provided: hasBallot, ballot, receivedArgNames: Object.keys(input) },
        { noun: "decision", channel: ctx.channel },
      );
      const queryText = `${title}\n${context ?? ""}`;

      if (status === "candidate") {
        const decision = await proposeDecision(memexId, doc.id, {
          title,
          context: context ?? null,
          options,
          source: "agent",
        });
        const decRef = buildChildRef(slugs, doc, { type: "decisions", seq: decision.seq });
        // Store the ballot + surface the governing standards at creation (dec-6 routing).
        const readout = hasBallot
          ? await storeRouteAndReadout({
              memexId,
              specDocId: doc.id,
              noun: "decision",
              rowId: decision.id,
              ownerRef: decRef,
              queryText,
              ballot,
              vocab,
              ctx: reqCtx(ctx),
            })
          : "";
        if (ctx.verbose) {
          const state = await fullDocState(memexId, doc.id);
          const url = await ctx.workspaceUrl(memexId);
          return (await formatState(url, state, ctx)) + readout;
        }
        const optCount = Array.isArray(decision.options) ? decision.options.length : 0;
        return `Candidate decision proposed: ref: ${decRef} "${decision.title}" (${optCount} options).` + readout;
      }

      const decision = await createDecision(memexId, doc.id, title, context, "human", reqCtx(ctx));
      const decRef = buildChildRef(slugs, doc, { type: "decisions", seq: decision.seq });
      // Store the ballot + surface the governing standards at creation (dec-6 routing),
      // so the decision is formed with the implicated standards already in view.
      const readout = hasBallot
        ? await storeRouteAndReadout({
            memexId,
            specDocId: doc.id,
            noun: "decision",
            rowId: decision.id,
            ownerRef: decRef,
            queryText,
            ballot,
            vocab,
            ctx: reqCtx(ctx),
          })
        : "";
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return (await formatState(url, state, ctx)) + readout;
      }
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
      return `Decision created: ref: ${decRef} "${decision.title}"` + readout;
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
      // spec-445 dec-1 — edit a decision's facet classification through this existing tool
      // (no bespoke facet tool). An edit-in-place field: cannot combine with a status
      // transition; omit to leave facets unchanged.
      facetBallot: z
        .object({
          verdict: z.record(z.string(), z.boolean()).describe("Complete map: facet slug → true/false."),
          none: z.boolean().describe("true = this work governs no facet (every verdict false)."),
        })
        .optional()
        .describe(
          "OPTIONAL (edit-in-place). Re-cast this decision's facet classification: a COMPLETE verdict over the Memex's facet vocabulary (a true/false for EVERY facet, or none:true) that REPLACES the stored ballot and re-surfaces the governing standards. Cannot combine with a status transition. Call the `facets` tool (verb:'list') first.",
        ),
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
      // spec-445 dec-1 — a facet re-cast is an edit-in-place operation, orthogonal to the
      // content fields but subject to the same "not with a status transition" rule.
      const hasFacetEdit = input.facetBallot !== undefined;

      if (target && (hasEditFields || hasFacetEdit)) {
        throw new ValidationError(
          "update_decision: cannot combine a status transition with field/facet edits in one call; pick one mode.",
        );
      }
      if (!target && !hasEditFields && !hasFacetEdit) {
        throw new ValidationError(
          "update_decision requires either status (open/resolved/candidate/rejected to transition) or one of: title, context, resolution, chosenOptionIndex, facetBallot.",
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
          updated = await reopenDecision(memexId, entity.row.id, reqCtx(ctx));
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
        // Edit-in-place mode (content fields and/or a facet re-cast, spec-445). A
        // facet-only edit changes no content field, so read the row back for the response.
        updated = hasEditFields
          ? await updateDecisionFields(memexId, entity.row.id, fields)
          : await getDecision(memexId, entity.row.id, doc.id);
        mode = "updated";
      }

      // spec-445 dec-1 — edit the decision's facet classification: a COMPLETE verdict
      // REPLACES the stored ballot (decision_facet_ballots upserts one per decision) and
      // re-surfaces the governing standards — the same validate+store+route path
      // create_decision / resolve_decision take. A vocab-less Memex is a no-op.
      let facetEditReadout = "";
      if (hasFacetEdit) {
        const ballot = parseBallotArg(input.facetBallot);
        const vocab = await requireBallotForMemex(
          memexId,
          { provided: true, ballot },
          { noun: "decision", channel: ctx.channel },
        );
        if (vocab.length > 0) {
          const routeRef = buildChildRef(slugs, doc, { type: "decisions", seq: updated.seq });
          facetEditReadout = await storeRouteAndReadout({
            memexId,
            specDocId: updated.docId,
            noun: "decision",
            rowId: entity.row.id,
            ownerRef: routeRef,
            queryText: `${updated.title}\n${updated.resolution ?? ""}`,
            ballot,
            vocab,
            ctx: reqCtx(ctx),
          });
        }
      }

      if (ctx.verbose) {
        const state = await fullDocState(memexId, updated.docId);
        const url = await ctx.workspaceUrl(memexId);
        return (await formatState(url, state)) + facetEditReadout;
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
      return `Decision updated: ref: ${decRef} "${updated.title}" [${updated.status}]${facetEditReadout}`;
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
      // spec-423 dec-5/dec-6 — the facet ballot is declared ONCE, at create_decision
      // (now a hard requirement), so resolution REUSES that stored ballot rather than
      // forcing a fresh one. A ballot here is an OPTIONAL refinement that overrides the
      // stored one (dec-6: work-side routing only — never surfaced as binding precedent).
      facetBallot: z
        .object({
          verdict: z.record(z.string(), z.boolean()).describe("Complete map: facet slug → true/false."),
          none: z.boolean().describe("true = this work governs no facet (every verdict false)."),
        })
        .optional()
        .describe(
          "OPTIONAL refinement. The facet ballot is declared at create_decision and reused here to re-surface the governing standards — you do NOT need to re-cast it. Pass a complete ballot (a true/false verdict for EVERY facet, or none:true) ONLY to override the stored one; call the `facets` tool (verb:'list') first to read the vocabulary.",
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
      // FACET BALLOT at resolution — the ballot is declared ONCE at create_decision (a
      // hard requirement), so resolution NEVER forces one: it REUSES the stored creation
      // ballot to re-surface the governing standards, landing the resolution pointed at
      // them (footer-only, spec-423 dec-5/dec-6). A fresh ballot here is an OPTIONAL
      // refinement that overrides the stored one (still validated for completeness). A
      // legacy/candidate decision with no stored ballot simply routes nothing — no fail.
      const hasBallot = input.facetBallot !== undefined;
      const ballot = parseBallotArg(input.facetBallot);
      const storedFacets = hasBallot ? [] : await decisionBallotTrueFacets(entity.row.id);
      let vocab: Awaited<ReturnType<typeof requireBallotForMemex>> = [];
      if (hasBallot) {
        // Only a PROVIDED ballot is validated (completeness + known keys); its absence
        // is never an error at resolution.
        vocab = await requireBallotForMemex(memexId, { provided: true, ballot }, { noun: "decision", channel: ctx.channel });
      }
      const decision = await resolveDecision(memexId, entity.row.id, resolution, chosenOptionIndex, reqCtx(ctx));
      const decRef = buildChildRef(slugs, doc, { type: "decisions", seq: decision.seq });
      const decQueryText = `${decision.title}\n${decision.resolution ?? resolution ?? ""}`;
      // A fresh ballot is stored + routed; otherwise re-surface the standards from the
      // stored creation ballot; an empty-vocab decision routes nothing.
      const readout = hasBallot
        ? await storeRouteAndReadout({
            memexId,
            specDocId: decision.docId,
            noun: "decision",
            rowId: entity.row.id,
            ownerRef: decRef,
            queryText: decQueryText,
            ballot,
            vocab,
            ctx: reqCtx(ctx),
          })
        : storedFacets.length > 0
          ? await routeAndReadout({
              memexId,
              ownerRef: decRef,
              noun: "decision",
              queryText: decQueryText,
              facetKeys: storedFacets,
              occasion: "created",
            })
          : "";
      if (ctx.verbose) {
        const state = await fullDocState(memexId, decision.docId);
        const url = await ctx.workspaceUrl(memexId);
        return (await formatState(url, state, ctx)) + readout;
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
      return `Decision resolved: ref: ${decRef} "${decision.title}" — ${decision.resolution}.${hint}${readout}`;
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
      const decision = await approveDecision(memexId, entity.row.id, reqCtx(ctx));
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
      const decision = await rejectDecision(memexId, entity.row.id, reason, reqCtx(ctx));
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
];
