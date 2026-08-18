// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).

import {
  z,
} from "zod";
import {
  buildChildRef,
  buildDocRef,
  memexSlugsById,
} from "../../mcp/refs.js";
import {
  flagDrift,
  proposeStandardChange,
  type ProposalOperationInput,
} from "../../services/standards.js";
import { acceptStandardChange } from "../../services/standard-accept.js";
import {
  createDocDraft,
} from "../../services/documents.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  MEMEX_DESC,
  VERBOSE_FIELD,
  buildStandardCommentRef,
  fullDocState,
  formatState,
  reqCtx,
  resolveRefArg,
  resolveStandardSectionRef,
  resolveDecisionRefArg,
  type ToolSpec,
} from "./shared.js";

export const standardsTools: ToolSpec[] = [
  {
    // spec-416 dec-1: the standards agent's DEDICATED standard-creation verb.
    // Deliberately has NO `docType` parameter — unlike create_doc (whose
    // free-string docType could mint a Spec / document / execution_plan), this
    // tool can only ever produce a STANDARD. That makes the spec-389 scope wall
    // (standards agent = author rules, never mint Specs/Issues/docs) hold BY
    // CONSTRUCTION, not by a guard that could regress. It is wired only into the
    // standards mode's allow-set (STANDARDS_SERVER_TOOLS) and is agent-only
    // (AGENT_ONLY_SERVER_TOOLS) — never registered on MCP, like
    // propose_scaffold_change. Creation routes through the agent's
    // render_confirmation gate (dec-2): the agent proposes, the user confirms,
    // THEN this handler fires. The handler delegates to the same createDocDraft
    // path create_doc uses with docType:'standard' — no duplicated logic.
    name: "create_standard",
    annotations: { title: "Create standard", readOnlyHint: false, destructiveHint: false },
    description:
      "Create a brand-new Standard (a durable team rule) from scratch. Pass `title` and `purpose` (the opening Rule narrative); flesh out the rest as clauses with `add_clause` / sections with `add_section` afterward. This is the ONLY way the standards agent mints a new doc — it can create Standards and nothing else (no Specs, free-form documents, execution-plans, or Issues). " +
      "Propose the creation through `render_confirmation` FIRST, showing the title + opening rule; never create until the user confirms. " +
      "**Run `search_memex({ query, kind: 'standard' })` first** to check an existing Standard doesn't already cover this — duplicate standards confuse the agent loop; surface any overlap in the confirmation before creating.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      title: z.string().describe("Standard title (1–500 chars) — the rule's headline."),
      purpose: z
        .string()
        .describe("The opening Rule narrative for the standard's Overview — what the rule is, in plain terms."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const args = input as { memex?: string; title: string; purpose?: string };
      const memexId = await ctx.resolveMemex(args.memex);
      if (!args.purpose) {
        throw new ValidationError("create_standard requires `purpose` (the opening Rule narrative).");
      }
      // Delegate to the SAME create path create_doc uses with docType:'standard'
      // (services/documents.ts: createDocDraft mints a std-N handle for standards).
      // No docType is accepted from the caller — it is pinned to 'standard' here,
      // which is what makes the scope boundary structural.
      // spec-449 dec-1: a Standard is born 'approved' (in force the moment it
      // exists) — the rule lives centrally in createDocDraft's docType branch, so
      // this path passes no explicit initialStatus.
      const doc = await createDocDraft(
        memexId,
        args.title,
        args.purpose,
        "standard",
        undefined,
        undefined,
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
      return `Standard created: ref: ${docRef} "${doc.title}".`;
    },
  },
  {
    name: "flag_drift",
    annotations: { title: "Flag Standard drift", readOnlyHint: false, destructiveHint: false },
    description:
      "Flag drift on a standard section — post a typed `drift` comment (sourced 'agent') describing the gap between the rule and observed reality. Drift often surfaces *mid-change*, not at the start of a task: stay watchful as you implement and flag the moment you see the gap. If a resolved decision prompted this observation, pass its `decisionRef` so the drift links back to that decision (it appears as a decision→standard edge on the knowledge graph). If the rule itself is wrong (not just out-of-sync with code), use `propose_standard_change` instead.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the standard section, e.g. `<ns>/<mx>/standards/std-7/sections/s-3` — the same `ref:` form get_doc / search_memex emit. NOT a UUID.",
        ),
      observation: z
        .string()
        .describe("What the agent observed that diverges from the standard rule"),
      decisionRef: z
        .string()
        .optional()
        .describe(
          "Optional canonical ref to the decision that triggered this drift, e.g. `<ns>/<mx>/specs/spec-N/decisions/dec-M` — pass it when a resolved decision prompted the observation so the drift links back to that decision. Omit for drift with no single triggering decision. NOT a UUID.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const observation = input.observation as string;
      const decisionRef = input.decisionRef as string | undefined;

      // spec-143 ac-14: address the section by canonical ref, not a raw UUID
      // (see resolveStandardSectionRef).
      const { memexId, sectionId } = await resolveStandardSectionRef(ctx, ref);
      // spec-497 dec-3: resolve the optional triggering-decision ref (same-memex
      // enforced) to stamp drift_decision_id for the knowledge-graph edge.
      const driftDecisionId = decisionRef
        ? (await resolveDecisionRefArg(ctx, decisionRef, memexId)).decisionId
        : null;
      // spec-156 W2 (FINDING 3): thread the invoking surface so the
      // standard_drift event is attributed to the actor (mcp vs in_app_agent)
      // instead of falling back to channel 'server' / actorKind 'system'.
      // Same idiom as the update_doc tag path above (tagCtx).
      const comment = await flagDrift(memexId, sectionId, observation, { driftDecisionId }, {
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
      "Propose a correction to a standard's RULE TEXT, at the clause grain. Name the clauses that should change and what they should say; the section is derived from them. Lands as a typed plan_revision comment (sourced 'agent') the standard owner reviews. Each entry in `operations` is one of three kinds: an edit (the clause's cl-N ref plus its new text), a delete (the ref alone), or an add (the ANCHOR clause's cl-N ref, which side of it to insert on, and the new text). Every entry in one call must target the same section — a proposal is one section's business. You do NOT supply the clause's current text: the server reads it from the live clause, and that reading is what lets the accept detect the clause changing underneath the proposal.",
    schema: {
      operations: z
        .array(
          z.object({
            op: z
              .enum(["edit", "delete", "add"])
              .describe("What this operation does to the target clause."),
            ref: z
              .string()
              .describe(
                "Canonical ref to the target clause, e.g. `<ns>/<mx>/standards/std-7/clauses/cl-12`. For `add`, this is the ANCHOR the new clause sits next to. NOT a UUID.",
              ),
            body: z
              .string()
              .optional()
              .describe("The clause's new text. Required for `edit` and `add`; omit for `delete`."),
            placement: z
              .enum(["before", "after"])
              .optional()
              .describe("`add` only: which side of the anchor the new clause goes. Defaults to `after`."),
          }),
        )
        .min(1)
        .describe("The ordered set of clause operations this proposal makes."),
      rationale: z
        .string()
        .optional()
        .describe("Why this change is needed (optional but strongly recommended)."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const rawOps = input.operations as Array<{
        op: "edit" | "delete" | "add";
        ref: string;
        body?: string;
        placement?: "before" | "after";
      }>;
      const rationale = input.rationale as string | undefined;

      // spec-530 t-2: every target is addressed by its canonical `cl-N` ref [per
      // std-10]; resolveRefArg rejects a raw UUID, exactly as the section-grained
      // contract did (spec-143 ac-14).
      let memexId: string | null = null;
      const operations = [] as ProposalOperationInput[];
      for (const raw of rawOps) {
        const resolved = await resolveRefArg(ctx, raw.ref);
        if (resolved.entity.kind !== "clause") {
          throw new ValidationError(
            `propose_standard_change targets clauses (cl-N); got ${resolved.entity.kind} for "${raw.ref}".`,
          );
        }
        memexId = resolved.memexId;
        const clauseId = resolved.entity.row.id;
        if (raw.op === "edit") {
          operations.push({ op: "edit", clauseId, after: raw.body ?? "" });
        } else if (raw.op === "delete") {
          operations.push({ op: "delete", clauseId });
        } else {
          operations.push({
            op: "add",
            anchorClauseId: clauseId,
            placement: raw.placement ?? "after",
            body: raw.body ?? "",
          });
        }
      }
      if (memexId === null) {
        throw new ValidationError("A proposal must carry at least one clause operation.");
      }
      // spec-156 W2 (FINDING 3): thread the invoking surface so the
      // standard_drift event carries channel/user attribution (mcp vs
      // in_app_agent), not the channel 'server' / actorKind 'system' default.
      const result = await proposeStandardChange(
        memexId,
        operations,
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
  {
    // spec-530 t-4 (dec-4): the transactional apply verb. It takes the proposal's
    // comment ref and NOTHING else — no bodies, no targets, no override (ac-11).
    // The proposal already carries what will be applied, so the agent cannot apply
    // something other than what the human reviewed. That is deliberate: the agent's
    // role here is judgement plus one gated call, not authorship.
    name: "accept_standard_change",
    annotations: { title: "Accept Standard change", readOnlyHint: false, destructiveHint: false },
    description:
      "Accept an open proposal (a `plan_revision` comment) and apply it to the Standard. Pass ONLY the proposal's comment ref — the proposal already carries which clauses change and what they should say, so there is nothing else to supply and no way to apply something different from what was proposed. Every clause operation lands, or none does, and the proposal is resolved 'accepted' in the same transaction. " +
      "If the rule text changed after the proposal was written, this REFUSES rather than overwriting that change, and names the clause and what it now says — relay that to the user and offer to re-propose against the current rule. " +
      "Propose this through `render_confirmation` FIRST, showing what will change; never apply until the user confirms. To REJECT instead, leave the rule alone and resolve the comment with `update_comment` (status `resolved`, resolution `'rejected'`).",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the proposal comment, e.g. `<ns>/<mx>/standards/std-7/comments/c-3` — the ref `list_comments` emits for a plan_revision. NOT a UUID.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;

      // std-10: the comment is addressed by its canonical c-N ref; resolveRefArg
      // rejects a raw UUID at the boundary.
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "comment") {
        throw new ValidationError(
          `accept_standard_change takes a proposal comment ref (c-N); got ${resolved.entity.kind} for "${ref}".`,
        );
      }
      // spec-156 W2 (FINDING 3): thread the invoking surface so the rule change is
      // attributed to the actor (mcp vs in_app_agent) rather than defaulting to
      // channel 'server' [per std-32] — "who accepted this rule change" is exactly
      // the question the activity contract exists to answer (ac-20).
      const result = await acceptStandardChange(
        resolved.memexId,
        resolved.entity.row.id,
        reqCtx(ctx),
      );

      // b-36 D-8: lead with the canonical `ref:` of the resolved proposal, never a
      // raw UUID.
      const slugs = await memexSlugsById(resolved.memexId);
      const commentRef = slugs
        ? buildChildRef(slugs, result.standard, { type: "comments", seq: result.comment.seq })
        : null;
      const sectionLabel = result.section.title ?? result.section.sectionType;
      const opCount = `${result.applied} clause operation${result.applied === 1 ? "" : "s"}`;
      if (ctx.verbose) {
        const state = await fullDocState(resolved.memexId, result.standard.id);
        const url = await ctx.workspaceUrl(resolved.memexId);
        const head = commentRef
          ? `Proposal accepted — applied ${opCount} to ${result.standard.handle} section "${sectionLabel}" (ref: ${commentRef}).`
          : `Proposal accepted — applied ${opCount} to ${result.standard.handle} section "${sectionLabel}".`;
        return `${head}\n\n${await formatState(url, state, ctx)}`;
      }
      return commentRef
        ? `Proposal accepted — applied ${opCount} to ${result.standard.handle} section "${sectionLabel}" (ref: ${commentRef}).`
        : `Proposal accepted — applied ${opCount} to ${result.standard.handle} section "${sectionLabel}".`;
    },
  },
  // (search_standards spec deleted by b-34 T-5 — replaced by the live
  // search_memex spec above.)

];
