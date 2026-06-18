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
import { ValidationError } from "../../types/errors.js";

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

// spec-305 dec-5: validate the developer/designer/PM triangle. Returns the
// normalised barycentric weights {dev,design,pm} (sum 1), or undefined when absent
// (a user who skips the triangle). Throws ValidationError on a malformed shape.
function parseRoleCoords(
  raw: unknown,
): { dev: number; design: number; pm: number } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") throw new ValidationError("roleCoords must be an object");
  const r = raw as Record<string, unknown>;
  const weights = (["dev", "design", "pm"] as const).map((k) => {
    const v = r[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new ValidationError(`roleCoords.${k} must be a non-negative number`);
    }
    return v;
  });
  const sum = weights[0] + weights[1] + weights[2];
  if (sum <= 0) throw new ValidationError("roleCoords must have a positive sum");
  return { dev: weights[0] / sum, design: weights[1] / sum, pm: weights[2] / sum };
}

// PATCH /api/auth/profile
// Body: { name: string, roleCoords?: { dev, design, pm } }
// The journey's identity step (spec-305 dec-2/dec-4/dec-5): confirm/set the display
// name, optionally place the role triangle, and stamp identity_confirmed_at so
// needsOnboarding clears. Returns the refreshed session.
session.patch("/profile", sessionMiddleware, async (c) => {
  const user = c.get("user");
  const body = await readJsonBody<{ name?: unknown; roleCoords?: unknown }>(c);
  const name = requireString(body?.name, "name", { trim: true, maxLength: 100 });
  const roleCoords = parseRoleCoords(body?.roleCoords);

  await updateUserProfile(user.id, { name, roleCoords, confirmIdentity: true });
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
