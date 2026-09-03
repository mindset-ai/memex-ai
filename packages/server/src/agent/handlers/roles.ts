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
  promoteToEditor,
  demoteToReviewer,
  resolveRole,
  listEditors,
  type DocRole,
} from "../../services/doc-members.js";
import {
  assign,
  unassign,
} from "../../services/doc-assignees.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  VERBOSE_FIELD,
  reqCtx,
  resolveRefArg,
  type ToolSpec,
} from "./shared.js";
import { getUserByEmail, getUserById } from "../../services/users.js";

// ── Moved here from shared.ts by spec-546 t-2: this file is the symbol's only
// consumer, so it lives with its consumer and is private [per std-51].
// spec-118: resolve a tool's USER target. Tools accept either an email
// (contains '@' — resolved against the users table) or a user UUID (looked up
// to confirm it exists). There is no separate user-lookup tool; callers pass an
// email or id directly. A miss is a ValidationError so Claude can correct the
// argument rather than silently mutating the wrong user.
// Resolve an email-or-uuid user argument to the user record. Returns id + email
// so callers can render the EMAIL in terse output — std-10 forbids raw UUIDs in
// the response body, so handlers must never echo the resolved id.
async function resolveUserArg(
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


export const rolesTools: ToolSpec[] = [
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
];
