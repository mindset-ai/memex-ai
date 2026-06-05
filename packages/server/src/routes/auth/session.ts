import { Hono } from "hono";
import {
  resolveSession,
  MemexAccessError,
  DisabledUserError,
} from "../../services/auth.js";
import { updateUserProfile } from "../../services/users.js";
import { sessionMiddleware, type SessionEnv } from "../../middleware/session.js";
import type { MemexResolverEnv } from "../../middleware/memex-resolver.js";
import { readJsonBody, requireString } from "../validation.js";

export const session = new Hono<MemexResolverEnv & SessionEnv>();

// GET /api/auth/me — current session as resolved by the middleware
session.get("/me", sessionMiddleware, async (c) => {
  const user = c.get("user");
  const requestedAccountId = c.get("currentMemexId");

  try {
    let resolved = await resolveSession(user.id, requestedAccountId);
    // Same tenant-override as /sso/google: prefer the resolved tenant for currentMemexId
    // when the user is a member, so the response matches "where they are".
    if (!requestedAccountId) {
      const tenantMemex = c.get("memex");
      if (tenantMemex) {
        const match = resolved.memberships.find((m) => m.memexId === tenantMemex.id);
        if (match) {
          resolved = { ...resolved, currentMemexId: match.memexId, currentRole: match.role };
        }
      }
    }
    return c.json(resolved);
  } catch (err) {
    if (err instanceof DisabledUserError) {
      return c.json({ error: "User is disabled" }, 403);
    }
    if (err instanceof MemexAccessError) {
      return c.json({ error: "Forbidden", message: err.message }, 403);
    }
    throw err;
  }
});

// PATCH /api/auth/profile
// Body: { name: string }
// Sets the user's display name (onboarding step). Returns the refreshed session.
session.patch("/profile", sessionMiddleware, async (c) => {
  const user = c.get("user");
  const body = await readJsonBody<{ name?: unknown }>(c);
  const name = requireString(body?.name, "name", { trim: true, maxLength: 100 });

  await updateUserProfile(user.id, { name });
  const resolved = await resolveSession(user.id, c.get("currentMemexId"));
  return c.json(resolved);
});

// POST /api/auth/switch-account
// Body: { memexId: string }
// Validates the user has membership in the target memex and returns the updated session.
// The client navigates to the new memex's path-based URL on subsequent requests.
session.post("/switch-account", sessionMiddleware, async (c) => {
  const user = c.get("user");
  const body = await readJsonBody<{ memexId?: unknown }>(c);
  const memexId = requireString(body?.memexId, "memexId");

  try {
    const resolved = await resolveSession(user.id, memexId);
    return c.json(resolved);
  } catch (err) {
    if (err instanceof MemexAccessError) {
      return c.json({ error: "Forbidden", message: err.message }, 403);
    }
    throw err;
  }
});
