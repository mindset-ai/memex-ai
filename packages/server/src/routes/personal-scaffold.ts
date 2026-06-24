// /api/:namespace/:memex/scaffold/* — read the merged scaffold for a PERSONAL
// Memex, and administer the owner's per-namespace GuidanceBlock additions
// (spec-360 follow-up).
//
// This is the personal-namespace sibling of routes/scaffold.ts (the org surface
// at /api/orgs/:orgId/scaffold/*). The owner of a personal namespace IS the
// admin of their own workspace, so they get the full add/edit/disable/delete
// surface — the same model as an org admin, owned by the personal namespace.
//
// Endpoints (mounted under /api/:namespace/:memex/scaffold):
//
//   GET    .../scaffold                       — merged Inspect payload
//   POST   .../scaffold/additions             — owner: create addition
//   PATCH  .../scaffold/additions/:id          — owner: update addition
//   DELETE .../scaffold/additions/:id          — owner: delete addition
//   POST   .../scaffold/additions/:id/toggle   — owner: flip enabled
//
// Auth model (std-7 — unauthorized resource access returns 404, NEVER 403):
//   The caller MUST be the personal namespace's owner_user_id, and the namespace
//   MUST be kind:'user'. Anything else — an org namespace, a stranger, even the
//   owner of a DIFFERENT personal namespace — gets a 404, indistinguishable from
//   a non-existent route. Mirrors routes/handhold.ts:44's ownership precedent.
//   STRICT sessionMiddleware 401s an anonymous caller before the handler runs;
//   the owner gate below narrows from "any member" to "the personal owner".
//
// Tenant isolation: the owner only ever sees/touches rows owned by THEIR
// namespace (namespace_id = the resolved namespace). The owner-keyed service
// queries + the cross-tenant guards below enforce this — an id from another
// namespace 404s.

import { Hono } from "hono";
import type { Context } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import type { Namespace } from "../db/schema.js";
import {
  createScaffoldAddition,
  deleteScaffoldAddition,
  listScaffoldAdditions,
  rowBelongsToOwner,
  toggleScaffoldAddition,
  updateScaffoldAddition,
  type ScaffoldOwner,
} from "../services/scaffold-additions.js";
import { db } from "../db/connection.js";
import { orgScaffoldAdditions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { BASE_SCAFFOLD } from "@memex/shared";
import type {
  GuidanceEmphasis,
  GuidanceTarget,
  Phase,
  Transition,
} from "@memex/shared";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { readJsonBody } from "./validation.js";

type Env = MemexResolverEnv & SessionEnv;

// ──────────────────────────────────────────────────────────────────────────
// Owner gate. The personal namespace's owner is the only writer/reader. Returns
// the ScaffoldOwner on success, or null on any miss (→ uniform 404).
// ──────────────────────────────────────────────────────────────────────────

function resolvePersonalOwner(c: Context<Env>): ScaffoldOwner | null {
  const currentUserId = c.get("currentUserId") as string | null;
  const namespace = c.get("namespace") as Namespace | null | undefined;
  if (
    !namespace ||
    namespace.kind !== "user" ||
    namespace.ownerUserId !== currentUserId
  ) {
    return null;
  }
  return { kind: "personal", namespaceId: namespace.id };
}

function notFound(c: Context<Env>) {
  return c.json({ error: "Not found" }, 404);
}

// ──────────────────────────────────────────────────────────────────────────
// Body parsing — identical contract to routes/scaffold.ts. `source`/`kind` are
// never read off the body (the table is the discriminator, dec-3). Personal
// rows carry NO per-memex scope: a personal namespace holds exactly one memex,
// so account-wide and per-memex coincide; `memexId` on the body is ignored.
// ──────────────────────────────────────────────────────────────────────────

interface RawTarget {
  phase?: unknown;
  tool?: unknown;
  transition?: unknown;
  button?: unknown;
}

const VALID_PHASES: ReadonlySet<string> = new Set([
  "draft",
  "specify",
  "build",
  "verify",
  "done",
]);
const VALID_TRANSITIONS: ReadonlySet<string> = new Set([
  "specify",
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

export const personalScaffoldRouter = new Hono<Env>();

// STRICT session — these are reads + mutations on the owner's own workspace.
// Anonymous → 401; the owner gate below then narrows to the personal owner.
personalScaffoldRouter.use("/*", sessionMiddleware);

// GET .../scaffold — merged Inspect payload. Owner-only (404 otherwise).
personalScaffoldRouter.get("/", async (c) => {
  const owner = resolvePersonalOwner(c);
  if (!owner) return notFound(c);
  const blocks = await listScaffoldAdditions(owner);
  return c.json({ base: BASE_SCAFFOLD, org: blocks });
});

// POST .../scaffold/additions — owner-only create.
personalScaffoldRouter.post("/additions", async (c) => {
  const owner = resolvePersonalOwner(c);
  if (!owner) return notFound(c);

  const user = c.get("user");
  const body = await readJsonBody<Record<string, unknown>>(c);
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

  const createInput: Parameters<typeof createScaffoldAddition>[1] = {
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

  const created = await createScaffoldAddition(owner, createInput, { channel: "rest_ui" });
  return c.json(created, 201);
});

// PATCH .../scaffold/additions/:id — owner-only update.
personalScaffoldRouter.patch("/additions/:id", async (c) => {
  const owner = resolvePersonalOwner(c);
  if (!owner) return notFound(c);
  const id = c.req.param("id");

  const body = await readJsonBody<Record<string, unknown>>(c);
  if ("source" in body) {
    throw new ValidationError("source is not a writable field (the table is the discriminator)");
  }
  if ("kind" in body) {
    throw new ValidationError("kind is not a writable field");
  }

  const input: Parameters<typeof updateScaffoldAddition>[1] = {};
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

  // Cross-tenant guard: confirm the row belongs to THIS namespace BEFORE writing,
  // so an id owned by another namespace (or an org) 404s without mutating.
  if (!(await rowIsOwnedBy(id, owner))) return notFound(c);

  try {
    const updated = await updateScaffoldAddition(id, input, { channel: "rest_ui" });
    return c.json(updated);
  } catch (err) {
    if (err instanceof NotFoundError) return notFound(c);
    throw err;
  }
});

// DELETE .../scaffold/additions/:id — owner-only delete.
personalScaffoldRouter.delete("/additions/:id", async (c) => {
  const owner = resolvePersonalOwner(c);
  if (!owner) return notFound(c);
  const id = c.req.param("id");

  if (!(await rowIsOwnedBy(id, owner))) return notFound(c);
  try {
    await deleteScaffoldAddition(id, { channel: "rest_ui" });
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof NotFoundError) return notFound(c);
    throw err;
  }
});

// POST .../scaffold/additions/:id/toggle — owner-only enabled flip.
personalScaffoldRouter.post("/additions/:id/toggle", async (c) => {
  const owner = resolvePersonalOwner(c);
  if (!owner) return notFound(c);
  const id = c.req.param("id");

  const body = await readJsonBody<Record<string, unknown>>(c);
  if (typeof body.enabled !== "boolean") {
    throw new ValidationError("enabled must be a boolean");
  }

  if (!(await rowIsOwnedBy(id, owner))) return notFound(c);
  try {
    const updated = await toggleScaffoldAddition(id, body.enabled, { channel: "rest_ui" });
    return c.json(updated);
  } catch (err) {
    if (err instanceof NotFoundError) return notFound(c);
    throw err;
  }
});

// Cross-tenant guard helper: does row `id` belong to `owner`'s namespace? A
// missing row OR a row owned by another tenant both answer false → 404.
async function rowIsOwnedBy(id: string, owner: ScaffoldOwner): Promise<boolean> {
  const row = await db.query.orgScaffoldAdditions.findFirst({
    where: eq(orgScaffoldAdditions.id, id),
  });
  if (!row) return false;
  return rowBelongsToOwner(row, owner);
}
