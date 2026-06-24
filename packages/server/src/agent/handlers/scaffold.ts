// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).
//
// spec-360: the scaffold-assistant authoring tool. `propose_scaffold_change`
// is AGENT-ONLY (never on MCP) — tool-specs.ts lists it in
// AGENT_ONLY_SERVER_TOOLS and excludes it from the manifest cross-check.

import {
  z,
} from "zod";
import {
  eq,
  and,
} from "drizzle-orm";
import {
  db,
} from "../../db/connection.js";
import {
  orgMemberships,
} from "../../db/schema.js";
import {
  filterOrgBlocksForMemex,
  listScaffoldAdditions,
  resolveScaffoldOwner,
} from "../../services/scaffold-additions.js";
import {
  listOrgScaffoldAdditionsCached,
} from "../../services/scaffold-additions-cache.js";
import {
  BASE_SCAFFOLD,
  validateScaffoldChange,
  describeScaffoldTarget,
  encodeScaffoldProposal,
  type GuidanceBlock,
  type GuidanceTarget,
  type GuidanceEmphasis,
  type ScaffoldProposal,
} from "@memex/shared";
import {
  type ToolSpec,
} from "./shared.js";

export const scaffoldTools: ToolSpec[] = [
  // ── Scaffold assistant (spec-360) ─────────────────────────
  // propose_scaffold_change — the propose-then-confirm authoring tool for the
  // `scaffold` agent mode (dec-2/dec-3/dec-9). It WRITES NOTHING: it admin-gates
  // the caller (ac-3), validates the requested change against the real scaffold
  // (dec-9/ac-12), and returns a STRUCTURED PROPOSAL (ac-7) the React surface
  // renders composed in the live preview for the admin to approve. The actual
  // write on approval goes through the existing admin-gated scaffold-additions
  // routes (ac-8) — there is no write path in this handler.
  {
    name: "propose_scaffold_change",
    annotations: {
      title: "Propose a scaffold guidance change",
      readOnlyHint: true,
      destructiveHint: false,
    },
    description:
      "Propose a change to your ORG's scaffold guidance — add, edit, disable, enable, or delete — for an administrator to approve. " +
      "This tool WRITES NOTHING: it returns a concrete proposal that is shown composed on the timeline; only the admin's explicit approval applies it. " +
      "The base scaffold is read-only — you can only author org additions. " +
      "A new addition is scoped either org-wide (every Memex in the org — the default) or to THIS Memex only (`scope: 'memex'`); ask the admin which they want when it isn't obvious. " +
      "Authoring is administrator-only and the server enforces it: a non-admin gets a refusal, so don't promise a change you can't make. " +
      "Validate first — the tool refuses an IMPOSSIBLE target (e.g. a tool that doesn't run in the named phase) and pushes back on an INCOHERENT one (empty text, an untargeted org-global that dilutes every nudge, or a duplicate of base guidance). " +
      "For edit/disable/enable/delete, pass the `blockId` of the existing org block (the ids are listed in your scaffold context).",
    schema: {
      operation: z
        .enum(["add", "edit", "disable", "enable", "delete"])
        .describe(
          "What to do: 'add' a new org block (needs target + text + rationale); 'edit' an existing block's text (needs blockId + text); 'disable'/'enable' a block (needs blockId); 'delete' a block (needs blockId).",
        ),
      target: z
        .object({
          phase: z.string().optional(),
          tool: z.string().optional(),
          transition: z.string().optional(),
          button: z.string().optional(),
        })
        .optional()
        .describe(
          "For 'add': where the guidance attaches. Any subset of phase/tool/transition/button; an absent dimension matches every value. Scope it — an empty target rides every nudge and is pushed back.",
        ),
      text: z
        .string()
        .optional()
        .describe("For 'add'/'edit': the guidance text the agent will read."),
      rationale: z
        .string()
        .optional()
        .describe(
          "For 'add': a short note to admins on why this exists. Never sent to the agent.",
        ),
      emphasis: z
        .enum(["do", "dont"])
        .optional()
        .describe("For 'add': optional emphasis — frame the guidance as a do or a don't."),
      scope: z
        .enum(["org", "memex"])
        .optional()
        .describe(
          "For 'add': the scope. 'org' (DEFAULT) applies the guidance to every Memex in the org; 'memex' applies it to THIS Memex only. Ask the admin which they want when it's not obvious; default to 'org' for org-wide policy.",
        ),
      blockId: z
        .string()
        .optional()
        .describe(
          "For 'edit'/'disable'/'enable'/'delete': the id of the existing org block to change (from your scaffold context).",
        ),
    },
    async handler(input, ctx) {
      const memexId = await ctx.resolveMemex();
      // spec-360 follow-up: owner-aware authoring gate. An ORG memex resolves
      // {kind:'org'} and is admin-gated (below); a PERSONAL memex resolves
      // {kind:'personal'} and its OWNER may author on their own workspace (they
      // are the admin of it). resolveMemex already proved the caller can access
      // this memex; for a personal memex that access IS owner access (a personal
      // namespace has exactly one member — the owner).
      const owner = await resolveScaffoldOwner(memexId);

      // dec-3 / ac-3 — the authoring gate, server-enforced HERE in the handler.
      // Non-admin members and complete non-members get the SAME refusal (no
      // existence leak, std-7): the message never reveals whether the org exists
      // or what membership the caller holds.
      const REFUSED =
        "I can't make that change — authoring this org's scaffold guidance is limited to organization administrators, and the server enforces that. I'm happy to explain anything about the scaffold, though.";
      if (!owner) return REFUSED;
      if (owner.kind === "org") {
        const membership = await db.query.orgMemberships.findFirst({
          where: and(
            eq(orgMemberships.userId, ctx.userId),
            eq(orgMemberships.orgId, owner.orgId),
            eq(orgMemberships.status, "active"),
          ),
        });
        if (!membership || membership.role !== "administrator") return REFUSED;
      }
      // Personal owner: resolveMemex already verified the caller owns this
      // personal workspace — no further gate needed.

      const operation = input.operation as ScaffoldProposal["operation"];
      // All owner rows for this memex view (org-wide + per-memex), INCLUDING
      // disabled ones, so an enable/edit/delete can reference a disabled block.
      // Org uses the b-68 cache (hot path); personal reads fresh (low-frequency).
      const ownerBlocks =
        owner.kind === "org"
          ? await listOrgScaffoldAdditionsCached(owner.orgId)
          : await listScaffoldAdditions(owner);
      const orgBlocks = filterOrgBlocksForMemex(ownerBlocks, memexId);

      if (operation === "add") {
        const target = (input.target ?? {}) as GuidanceTarget;
        const text = ((input.text as string | undefined) ?? "").trim();
        const rationale = ((input.rationale as string | undefined) ?? "").trim();
        const v = validateScaffoldChange(BASE_SCAFFOLD, target, text);
        if (v.outcome === "impossible") {
          return `I won't propose that — ${v.reason}`;
        }
        if (v.outcome === "incoherent") {
          return `Before I propose that — ${v.reason} ${v.suggestion}`;
        }
        if (rationale.length === 0) {
          return "An addition needs a short rationale — a note to admins explaining why it exists (the agent never sees it). Tell me the reason and I'll draft the proposal.";
        }
        const scope = input.scope === "memex" ? "memex" : "org";
        const scopeNote = scope === "memex" ? " (this Memex only)" : "";
        const proposal: ScaffoldProposal = {
          operation: "add",
          target,
          text,
          rationale,
          scope,
          summary: `Add org guidance ${describeScaffoldTarget(target)}${scopeNote}.`,
        };
        if (input.emphasis) proposal.emphasis = input.emphasis as GuidanceEmphasis;
        return encodeScaffoldProposal(proposal);
      }

      // edit / disable / enable / delete reference an existing org block by id.
      const blockId = (input.blockId as string | undefined)?.trim();
      if (!blockId) {
        return `A ${operation} needs the id of the existing org block to change — the ids are listed in your scaffold context.`;
      }
      const block = orgBlocks.find(
        (b) => (b as GuidanceBlock & { id?: string }).id === blockId,
      );
      if (!block) {
        return `There is no org guidance block with id "${blockId}" in this workspace. Check the ids in your scaffold context.`;
      }

      if (operation === "edit") {
        const text = ((input.text as string | undefined) ?? "").trim();
        const v = validateScaffoldChange(BASE_SCAFFOLD, block.target, text);
        if (v.outcome === "impossible") return `I won't propose that edit — ${v.reason}`;
        if (v.outcome === "incoherent") {
          return `Before I propose that edit — ${v.reason} ${v.suggestion}`;
        }
        const proposal: ScaffoldProposal = {
          operation: "edit",
          blockId,
          target: block.target,
          text,
          before: { text: block.text, target: block.target },
          summary: `Edit the org guidance ${describeScaffoldTarget(block.target)}.`,
        };
        return encodeScaffoldProposal(proposal);
      }

      if (operation === "disable" || operation === "enable") {
        const proposal: ScaffoldProposal = {
          operation,
          blockId,
          target: block.target,
          before: { enabled: block.enabled, text: block.text, target: block.target },
          summary: `${operation === "enable" ? "Enable" : "Disable"} the org guidance ${describeScaffoldTarget(block.target)}.`,
        };
        return encodeScaffoldProposal(proposal);
      }

      // delete
      const proposal: ScaffoldProposal = {
        operation: "delete",
        blockId,
        target: block.target,
        before: { text: block.text, target: block.target },
        summary: `Delete the org guidance ${describeScaffoldTarget(block.target)}.`,
      };
      return encodeScaffoldProposal(proposal);
    },
  },
];
