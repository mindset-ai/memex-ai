// /api/namespaces/* — namespace-keyed endpoints.
//
// Mounted flat at /api/namespaces in app.ts (caller-scoped, like orgsRouter).
//
//   GET   /api/namespaces/check?slug=foo                 — namespace slug availability
//   PATCH /api/namespaces/:id/slug                       — rename slug (30-day cooldown)
//   GET   /api/namespaces/:namespaceId/home              — kind-aware home payload (t-4)
//   POST  /api/namespaces/:namespaceId/memexes           — create a sibling memex (t-5)
//   GET   /api/namespaces/:namespaceId/memexes/check     — per-namespace memex slug (t-6)
//
// Per dec-7 of doc-19 (URL hygiene cleanup), check + slug-rename moved from
// /api/orgs/... since they're namespace-keyed, not org-keyed.

import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { namespaceAccessGate } from "../middleware/permissions.js";
import {
  renameNamespaceSlug,
  getNamespaceHome,
} from "../services/namespaces.js";
import {
  createMemex,
  isMemexSlugAvailable,
  MemexCreationError,
} from "../services/memexes.js";
import { isSlugAvailable, validateSlugFormat } from "../services/shared/slug.js";
import { ConflictError, ValidationError } from "../types/errors.js";

export const namespacesRouter = new Hono<SessionEnv>();

namespacesRouter.use("*", sessionMiddleware);

// GET /api/namespaces/check?slug=foo — fast availability check for live signup
// validation. Returns { available, reason? } so the form can render the right
// affordance (red border + "taken" / "reserved" / "invalid format").
namespacesRouter.get("/check", async (c) => {
  const slug = c.req.query("slug")?.trim().toLowerCase() ?? "";
  const format = validateSlugFormat(slug);
  if (!format.valid) {
    return c.json({ available: false, reason: format.error });
  }
  const available = await isSlugAvailable(slug);
  if (!available) {
    return c.json({ available: false, reason: "taken" });
  }
  return c.json({ available: true });
});

// PATCH /api/namespaces/:id/slug — rename a namespace slug. Caller
// authorization is enforced inside the service: org admins for org namespaces;
// the owner for user namespaces.
namespacesRouter.patch("/:id/slug", async (c) => {
  const user = c.get("user");
  const namespaceId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.slug !== "string") {
    return c.json({ error: "slug is required" }, 400);
  }
  try {
    const updated = await renameNamespaceSlug({
      namespaceId,
      newSlug: body.slug,
      userId: user.id,
    });
    return c.json({ namespace: updated });
  } catch (err) {
    if (err instanceof ValidationError) {
      // Cooldown violation surfaces as 429 (the user can retry later); other
      // validation errors are 400.
      const isCooldown = err.message.toLowerCase().includes("cooldown");
      return c.json(
        {
          error: err.message,
          code: isCooldown ? "cooldown_active" : "validation_error",
        },
        isCooldown ? 429 : 400,
      );
    }
    if (err instanceof ConflictError) {
      return c.json({ error: err.message, code: "slug_unavailable" }, 409);
    }
    throw err;
  }
});

// GET /api/namespaces/:namespaceId/home — kind-aware home payload (doc-19 t-4).
// Returns the discriminated-union shape described in services/namespaces.ts.
namespacesRouter.get("/:namespaceId/home", namespaceAccessGate, async (c) => {
  const user = c.get("user");
  const namespaceId = c.req.param("namespaceId");
  const home = await getNamespaceHome(namespaceId, user.id);
  if (!home) return c.json({ error: "Namespace not found" }, 404);
  return c.json(home);
});

// GET /api/namespaces/:namespaceId/memexes/check?slug=foo — per-namespace
// slug availability for the Add Memex form (doc-19 t-6).
namespacesRouter.get(
  "/:namespaceId/memexes/check",
  namespaceAccessGate,
  async (c) => {
    const namespaceId = c.req.param("namespaceId");
    const slug = c.req.query("slug") ?? "";
    const result = await isMemexSlugAvailable(namespaceId, slug);
    return c.json(result);
  },
);

// POST /api/namespaces/:namespaceId/memexes — create a Memex inside the
// namespace (doc-19 t-5). Caller must be an active org member (the
// namespaceAccessGate enforces membership; the service layer enforces
// kind='org' and re-checks the active membership).
namespacesRouter.post("/:namespaceId/memexes", namespaceAccessGate, async (c) => {
  const user = c.get("user");
  const namespaceId = c.req.param("namespaceId");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.slug !== "string") {
    return c.json({ error: "slug is required", code: "validation_error" }, 400);
  }
  const name = typeof body.name === "string" ? body.name : undefined;

  try {
    const memex = await createMemex(
      {
        namespaceId,
        slug: body.slug,
        name,
        callerUserId: user.id,
      },
      { channel: "rest_ui" },
    );
    return c.json({ memex }, 201);
  } catch (err) {
    if (err instanceof MemexCreationError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message, code: "validation_error" }, 400);
    }
    if (err instanceof ConflictError) {
      return c.json({ error: err.message, code: "slug_taken" }, 409);
    }
    throw err;
  }
});
