// /api/:namespace/:memex/memexes/* — per-Memex settings + public read surface.
//
// spec-111 t-5. Two responsibilities on one router, with PER-VERB middleware:
//
//   1. PATCH /:id { visibility } — flip the Memex visibility (public|private).
//      Owner/admin-gated via STRICT sessionMiddleware (401s anonymous) + adminGate
//      (403s non-admins of the resolved memex's org). The write goes through the
//      `updateMemexVisibility` service, which routes through `mutate()` and emits
//      a `memex`/`updated` event on the unified bus per std-8. The change takes
//      effect on the next read immediately (no cache between the write and
//      `canReadMemex`'s load).
//
//   2. GET /:id — the public-readable Memex view, behind the PERMISSIVE session
//      layer (`publicSessionMiddleware`), so anonymous callers reach the handler
//      with `currentUserId = null`. The handler gates on `canReadMemex`: public
//      memexes are readable by everyone (incl. anonymous); private memexes return
//      404 to non-members/anonymous — identical to a non-existent memex (std-7,
//      no enumeration leak).
//
// Mounted ONCE in app.ts at /api/:namespace/:memex/memexes. We attach the
// session/auth middleware with HONO METHOD ROUTING (`.on('GET', …)` /
// `.on('PATCH', …)`) rather than a method-agnostic `.use('*')`, so the strict
// admin stack NEVER runs for a public GET and the permissive layer never runs
// for a write. That separation is the whole point — a single `.use('*')` would
// leak one verb's policy onto the other.

import { Hono } from "hono";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import {
  type SessionEnv,
  sessionMiddleware,
  publicSessionMiddleware,
} from "../middleware/session.js";
import { adminGate } from "../middleware/permissions.js";
import { canReadMemex, canWriteMemex } from "../mcp/auth.js";
import {
  getMemexById,
  isMemexVisibility,
  updateMemexVisibility,
} from "../services/memexes.js";
import { recordPublicMemexVisit } from "../services/users.js";
import { ValidationError } from "../types/errors.js";

type Env = MemexResolverEnv & SessionEnv;

export const memexesRouter = new Hono<Env>();

// Path-collision context (read alongside the ctx.memex guards below):
//
// This router mounts at /api/:namespace/:memex/memexes, whose pattern ALSO
// matches sibling routes like /api/namespaces/:namespaceId/memexes/check (the
// namespacesRouter surface). For those, `namespaces` is a reserved API root, so
// memexResolver deliberately does NOT resolve a tenant memex (ctx.memex stays
// unset). Every middleware + handler below therefore guards on ctx.memex: when
// it's unset this request isn't ours, so we fall through with next() and Hono
// propagates the un-answered next() to the next matching app-level router
// (namespacesRouter). Guarding the AUTH middleware too means the strict admin
// stack never fires on a borrowed /api/namespaces/... request.

// Per-verb middleware. `.on(method, path, …handlers)` scopes the stack to that
// verb only — GET gets the permissive (anonymous-friendly) session, PATCH gets
// the strict session + admin gate. No `.use('*')`, so neither stack bleeds onto
// the other verb. Each guards on ctx.memex so a borrowed /api/namespaces/...
// request passes through without triggering auth.
memexesRouter.on("GET", "/*", async (c, next) => {
  if (!c.get("memex")) return next();
  return publicSessionMiddleware(c, next);
});
memexesRouter.on("PATCH", "/*", async (c, next) => {
  if (!c.get("memex")) return next();
  return sessionMiddleware(c, next);
});
memexesRouter.on("PATCH", "/*", async (c, next) => {
  if (!c.get("memex")) return next();
  return adminGate(c, next);
});

// GET / — slug-based readability probe for the path-resolved Memex. Unlike
// GET /:id (which needs the UUID), this resolves the Memex from the URL tenant
// (memexResolver, anonymous-friendly), so an anonymous React client that only
// knows /<namespace>/<memex> can ask "may I read this?". The UI uses it to
// decide, for a visitor with no session, whether to render the read-only public
// shell (public → 200) or bounce to the login screen (private/unknown → 404).
// Same std-7 posture as GET /:id: private is indistinguishable from missing.
memexesRouter.get("/", async (c, next) => {
  const memex = c.get("memex");
  if (!memex) return next();

  const userId = c.get("currentUserId");

  const allowed = await canReadMemex(userId, memex.id).catch(() => false);
  if (!allowed) return c.json({ error: "Not found" }, 404);

  return c.json({
    memex: {
      id: memex.id,
      namespaceId: memex.namespaceId,
      slug: memex.slug,
      name: memex.name,
      visibility: memex.visibility,
    },
  });
});

// GET /:id — read a single Memex's public-facing shape. Anonymous-friendly:
// public memexes are visible to everyone; private memexes 404 for non-members
// and anonymous callers (std-7 — indistinguishable from "doesn't exist").
memexesRouter.get("/:id", async (c, next) => {
  // Collision guard (see the /* middleware above): only own this request when
  // memexResolver actually resolved a /<namespace>/<memex>/ prefix. Otherwise
  // fall through to the next matching app-level router (e.g. namespacesRouter's
  // /api/namespaces/:id/memexes/check).
  if (!c.get("memex")) return next();

  const id = c.req.param("id");
  const userId = c.get("currentUserId");

  // canReadMemex loads the memex itself; if it's missing OR the caller can't
  // read it, we return the SAME 404. We never branch on "exists but private"
  // vs "doesn't exist" — that distinction is exactly what std-7 forbids leaking.
  const allowed = await canReadMemex(userId, id).catch(() => false);
  if (!allowed) return c.json({ error: "Not found" }, 404);

  const memex = await getMemexById(id);
  if (!memex) return c.json({ error: "Not found" }, 404);

  // spec-111 t-6 (ac-9): pin the public Memex on the visitor's account so it
  // surfaces in the read-only "Visited" group. Gated to the exact case the
  // helper expects (it does NOT re-check authz): the Memex is PUBLIC and the
  // caller is a signed-in NON-member. Anonymous callers (userId === null) and
  // members (canWriteMemex) are excluded. Fire-and-forget — a pin failure must
  // never fail the read. The helper is idempotent (ON CONFLICT DO NOTHING) and
  // emits silently on re-visit per std-8.
  if (userId && memex.visibility === "public") {
    const isMember = await canWriteMemex(userId, id).catch(() => false);
    if (!isMember) {
      await recordPublicMemexVisit(userId, id).catch(() => {
        /* pin is best-effort; never fail the read */
      });
    }
  }

  return c.json({
    memex: {
      id: memex.id,
      namespaceId: memex.namespaceId,
      slug: memex.slug,
      name: memex.name,
      visibility: memex.visibility,
    },
  });
});

// PATCH /:id { visibility: 'public' | 'private' } — flip Memex visibility.
//
// The `:id` MUST be the memex resolved from the URL path (the one adminGate
// authorized via currentMemexId). Editing a DIFFERENT memex through this route
// is rejected with 404 — the admin gate only proves admin rights on the
// path-resolved memex, never on an arbitrary id in the body/param.
memexesRouter.patch("/:id", async (c, next) => {
  // Collision guard — see the GET handler. No tenant memex resolved ⇒ not ours.
  if (!c.get("memex")) return next();

  const id = c.req.param("id");
  const currentMemexId = c.get("currentMemexId");

  // adminGate guarantees currentMemexId is set + role==='administrator'. Guard
  // that the targeted :id is that same memex (std-7: don't let an admin of memex
  // A mutate memex B by passing B's id here — 404, not 403).
  if (!currentMemexId || currentMemexId !== id) {
    return c.json({ error: "Not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || !isMemexVisibility(body.visibility)) {
    return c.json(
      { error: "visibility must be 'public' or 'private'", code: "validation_error" },
      400,
    );
  }

  try {
    const updated = await updateMemexVisibility(id, body.visibility, {
      channel: "rest_ui",
    });
    return c.json({
      memex: {
        id: updated.id,
        namespaceId: updated.namespaceId,
        slug: updated.slug,
        name: updated.name,
        visibility: updated.visibility,
      },
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      // Memex disappeared between gate and write — surface as 404 (std-7).
      return c.json({ error: "Not found" }, 404);
    }
    throw err;
  }
});
