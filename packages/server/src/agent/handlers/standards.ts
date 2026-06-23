// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).

import {
  z,
} from "zod";
import {
  and,
} from "drizzle-orm";
import {
  buildChildRef,
  memexSlugsById,
} from "../../mcp/refs.js";
import {
  flagDrift,
  proposeStandardChange,
} from "../../services/standards.js";
import {
  VERBOSE_FIELD,
  buildStandardCommentRef,
  resolveStandardSectionRef,
  type ToolCtx,
  type ToolSpec,
} from "./shared.js";

export const standardsTools: ToolSpec[] = [
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

];
