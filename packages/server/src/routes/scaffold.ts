// /api/orgs/:orgId/scaffold/* — read the merged scaffold for an Org, and
// administer per-Org GuidanceBlock additions (b-68 t-10).
//
// Endpoints (all mounted flat under /api/orgs/:orgId/scaffold):
//
//   GET    /api/orgs/:orgId/scaffold                        — merged Inspect payload
//   POST   /api/orgs/:orgId/scaffold/additions              — admin: create addition
//   PATCH  /api/orgs/:orgId/scaffold/additions/:id          — admin: update addition
//   DELETE /api/orgs/:orgId/scaffold/additions/:id          — admin: delete addition
//   POST   /api/orgs/:orgId/scaffold/additions/:id/toggle   — admin: flip enabled
//
// Auth model (per std-7 — unauthorized resource access returns 404, NEVER 403):
//   * Read (GET):  any row in org_memberships with status='active' for
//                  (principal, orgId). Non-member → 404.
//   * Writes:      org_memberships.role === 'administrator' AND status='active'.
//                  Non-admin (whether they're an ordinary member or a complete
//                  non-member) → 404. Returning 403 would leak the (orgId exists,
//                  caller has no admin grant) bit, defeating the std-7 contract.
//
// dec-3 invariant carried through here: the write endpoints accept ONLY the
// GuidanceBlock fields a caller is allowed to set (target, text, rationale,
// emphasis, enabled, order). `source` and `kind` are NEVER read off the body —
// the table itself is the `source: 'org'` discriminator, and the service
// layer hard-codes `kind: 'guidance_block'`. Any extra keys on the body are
// silently ignored. This is asserted under ac-11.
//
// The reusable adminGate in middleware/permissions.ts is path-prefix-coupled
// (reads ctx.currentMemexId from memexResolver) and returns 403, which would
// breach std-7. These routes therefore use a local org-scoped check below
// that consults org_memberships directly against the URL's :orgId.

import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { db } from "../db/connection.js";
import { orgMemberships } from "../db/schema.js";
import {
  createOrgScaffoldAddition,
  deleteOrgScaffoldAddition,
  listOrgScaffoldAdditions,
  toggleOrgScaffoldAddition,
  updateOrgScaffoldAddition,
} from "../services/scaffold-additions.js";
import { BASE_SCAFFOLD } from "@memex/shared";
import type {
  GuidanceEmphasis,
  GuidanceTarget,
  Phase,
  Transition,
} from "@memex/shared";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { readJsonBody } from "./validation.js";

// ──────────────────────────────────────────────────────────────────────────
// Membership helpers. The 404-on-unauthorized contract (std-7) means we can't
// distinguish "no such org" from "you're not a member" from "you're a member
// but not an admin" in the response — every miss flows through the same
// `notFound()` helper.
// ──────────────────────────────────────────────────────────────────────────

async function loadMembership(
  userId: string,
  orgId: string,
): Promise<{ role: "member" | "administrator" } | null> {
  const row = await db.query.orgMemberships.findFirst({
    where: and(
      eq(orgMemberships.userId, userId),
      eq(orgMemberships.orgId, orgId),
      eq(orgMemberships.status, "active"),
    ),
  });
  if (!row) return null;
  return { role: row.role as "member" | "administrator" };
}

// Uniform 404 response. Centralised so the body shape stays stable across
// every "unauthorized" exit. The error string is deliberately generic — it
// must NOT betray whether the org exists or what membership the caller has.
function notFound(c: Context<SessionEnv>) {
  return c.json({ error: "Not found" }, 404);
}

// ──────────────────────────────────────────────────────────────────────────
// Body parsing for the GuidanceBlock-write surface (POST + PATCH).
//
// dec-3: we explicitly do NOT read `source` or `kind` off the body. The
// table is the discriminator; the service layer stamps both fields in code.
// Extra body keys (including those) are silently dropped here — there is no
// code path that propagates them downstream.
// ──────────────────────────────────────────────────────────────────────────

interface RawTarget {
  phase?: unknown;
  tool?: unknown;
  transition?: unknown;
  button?: unknown;
}

const VALID_PHASES: ReadonlySet<string> = new Set([
  "draft",
  "plan",
  "build",
  "verify",
  "done",
]);
const VALID_TRANSITIONS: ReadonlySet<string> = new Set([
  "plan",
  "build",
  "verify",
  "done",
]);

function parseTarget(raw: unknown): GuidanceTarget {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("target must be an object");
  }
  const t = raw as RawTarget;
  const out: GuidanceTarget = {};
  if (t.phase !== undefined) {
    if (typeof t.phase !== "string" || !VALID_PHASES.has(t.phase)) {
      throw new ValidationError(`target.phase '${String(t.phase)}' is not a valid Phase`);
    }
    out.phase = t.phase as Phase;
  }
  if (t.tool !== undefined) {
    if (typeof t.tool !== "string" || t.tool.length === 0) {
      throw new ValidationError("target.tool must be a non-empty string");
    }
    out.tool = t.tool;
  }
  if (t.transition !== undefined) {
    if (typeof t.transition !== "string" || !VALID_TRANSITIONS.has(t.transition)) {
      throw new ValidationError(
        `target.transition '${String(t.transition)}' is not a valid Transition`,
      );
    }
    out.transition = t.transition as Transition;
  }
  if (t.button !== undefined) {
    if (typeof t.button !== "string" || t.button.length === 0) {
      throw new ValidationError("target.button must be a non-empty string");
    }
    out.button = t.button;
  }
  return out;
}

function parseEmphasis(raw: unknown): GuidanceEmphasis | undefined | null {
  if (raw === undefined) return undefined;
  if (raw === null) return null; // PATCH-only: explicit clear
  if (raw !== "do" && raw !== "dont") {
    throw new ValidationError(`emphasis must be 'do' or 'dont' (or null to clear)`);
  }
  return raw;
}

// ──────────────────────────────────────────────────────────────────────────
// Router.
// ──────────────────────────────────────────────────────────────────────────

export const scaffoldRouter = new Hono<SessionEnv>();

scaffoldRouter.use("*", sessionMiddleware);

// GET /api/orgs/:orgId/scaffold — merged Inspect payload.
// Any active member can read.
scaffoldRouter.get("/:orgId/scaffold", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const m = await loadMembership(user.id, orgId);
  if (!m) return notFound(c);
  // Org additions include disabled rows so the UI can render toggle state.
  const orgBlocks = await listOrgScaffoldAdditions(orgId);
  return c.json({
    base: BASE_SCAFFOLD,
    org: orgBlocks,
  });
});

// POST /api/orgs/:orgId/scaffold/additions — admin-only create.
scaffoldRouter.post("/:orgId/scaffold/additions", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const m = await loadMembership(user.id, orgId);
  if (!m || m.role !== "administrator") return notFound(c);

  const body = await readJsonBody<Record<string, unknown>>(c);
  // Reject any attempt to set `source` or `kind` defensively. dec-3 says the
  // table is the discriminator — a caller passing source/kind is either
  // confused or probing. Either way, the right response is "those fields are
  // not part of this surface".
  if ("source" in body) {
    throw new ValidationError("source is not a writable field (the table is the discriminator)");
  }
  if ("kind" in body) {
    throw new ValidationError("kind is not a writable field");
  }

  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    throw new ValidationError("text is required");
  }
  if (typeof body.rationale !== "string" || body.rationale.trim().length === 0) {
    throw new ValidationError("rationale is required");
  }
  const target = parseTarget(body.target);
  const emphasis = parseEmphasis(body.emphasis);

  // For POST we treat `null` emphasis as "not set" — only PATCH distinguishes
  // null-to-clear from undefined-leave-alone.
  const createInput: Parameters<typeof createOrgScaffoldAddition>[0] = {
    orgId,
    authorId: user.id,
    target,
    text: body.text,
    rationale: body.rationale,
  };
  if (emphasis !== undefined && emphasis !== null) createInput.emphasis = emphasis;
  if (typeof body.enabled === "boolean") createInput.enabled = body.enabled;
  if (typeof body.order === "number" && Number.isFinite(body.order)) {
    createInput.order = body.order;
  }

  const created = await createOrgScaffoldAddition(createInput, { channel: "rest_ui" });
  return c.json(created, 201);
});

// PATCH /api/orgs/:orgId/scaffold/additions/:id — admin-only update.
scaffoldRouter.patch("/:orgId/scaffold/additions/:id", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const id = c.req.param("id");
  const m = await loadMembership(user.id, orgId);
  if (!m || m.role !== "administrator") return notFound(c);

  const body = await readJsonBody<Record<string, unknown>>(c);
  if ("source" in body) {
    throw new ValidationError("source is not a writable field (the table is the discriminator)");
  }
  if ("kind" in body) {
    throw new ValidationError("kind is not a writable field");
  }

  const input: Parameters<typeof updateOrgScaffoldAddition>[1] = {};
  if (body.text !== undefined) {
    if (typeof body.text !== "string" || body.text.trim().length === 0) {
      throw new ValidationError("text must be a non-empty string");
    }
    input.text = body.text;
  }
  if (body.rationale !== undefined) {
    if (typeof body.rationale !== "string" || body.rationale.trim().length === 0) {
      throw new ValidationError("rationale must be a non-empty string");
    }
    input.rationale = body.rationale;
  }
  if (body.target !== undefined) input.target = parseTarget(body.target);
  const parsedEmphasis = parseEmphasis(body.emphasis);
  if (parsedEmphasis !== undefined) input.emphasis = parsedEmphasis;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      throw new ValidationError("enabled must be a boolean");
    }
    input.enabled = body.enabled;
  }
  if (body.order !== undefined) {
    if (typeof body.order !== "number" || !Number.isFinite(body.order)) {
      throw new ValidationError("order must be a finite number");
    }
    input.order = body.order;
  }

  // Cross-tenant guard: an admin of org A must NOT be able to PATCH a row
  // owned by org B even if they happen to know its UUID. We disambiguate by
  // checking the loaded row's orgId against the URL — but to stay std-7
  // compliant we fall through to the same 404 either way (the service
  // already throws NotFoundError when the id doesn't exist; we translate the
  // mismatch into the same shape).
  try {
    const updated = await updateOrgScaffoldAddition(id, input, { channel: "rest_ui" });
    if (updated.orgId !== orgId) return notFound(c);
    return c.json(updated);
  } catch (err) {
    if (err instanceof NotFoundError) return notFound(c);
    throw err;
  }
});

// DELETE /api/orgs/:orgId/scaffold/additions/:id — admin-only delete.
scaffoldRouter.delete("/:orgId/scaffold/additions/:id", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const id = c.req.param("id");
  const m = await loadMembership(user.id, orgId);
  if (!m || m.role !== "administrator") return notFound(c);

  // Cross-tenant guard: confirm the row belongs to this org before deleting.
  // Reads through the service so a missing row 404s consistently.
  try {
    const existing = await listOrgScaffoldAdditions(orgId);
    if (!existing.some((row) => row.id === id)) return notFound(c);
    await deleteOrgScaffoldAddition(id, { channel: "rest_ui" });
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof NotFoundError) return notFound(c);
    throw err;
  }
});

// POST /api/orgs/:orgId/scaffold/additions/:id/toggle — admin-only enabled flip.
// Convenience for the React UI's toggle switch; semantically equivalent to a
// PATCH with `{ enabled }` but lets the UI ship a single-purpose request.
scaffoldRouter.post("/:orgId/scaffold/additions/:id/toggle", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const id = c.req.param("id");
  const m = await loadMembership(user.id, orgId);
  if (!m || m.role !== "administrator") return notFound(c);

  const body = await readJsonBody<Record<string, unknown>>(c);
  if (typeof body.enabled !== "boolean") {
    throw new ValidationError("enabled must be a boolean");
  }

  try {
    const updated = await toggleOrgScaffoldAddition(id, body.enabled, { channel: "rest_ui" });
    if (updated.orgId !== orgId) return notFound(c);
    return c.json(updated);
  } catch (err) {
    if (err instanceof NotFoundError) return notFound(c);
    throw err;
  }
});
