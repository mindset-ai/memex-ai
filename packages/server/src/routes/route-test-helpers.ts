// Helpers for route-level mock tests (t-13). Lets a `routes/*.test.ts` construct a
// Hono app with the real route under test but STUBBED tenant/session middleware, so the
// test can focus on handler logic without dragging in a real DB.
//
// Usage pattern:
//   vi.mock("../middleware/session.js", () => ({ sessionMiddleware: passthroughMiddleware }));
//   vi.mock("../middleware/memex-resolver.js", () => ({ memexResolver: passthroughMiddleware }));
//   import { makeTestAppWithTenant } from "./route-test-helpers.js";
//   const app = makeTestAppWithTenant({ memexId: "test-account" });
//   app.route("/api/docs", docs);

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { errorHandler } from "../middleware/error-handler.js";

export interface TestTenantContext {
  memexId?: string;
  userId?: string;
  userEmail?: string;
  role?: "user" | "administrator";
  accessLevel?: "read" | "write";
}

// Injects stubbed `user`, `currentMemexId`, `currentRole` into the Hono context.
// Routes that read these via `requireMemexId` + session-derived values get
// fully-populated values without any real auth.
export function tenantStubMiddleware(ctx: TestTenantContext = {}) {
  const memexId = ctx.memexId ?? "00000000-0000-0000-0000-000000000001";
  const userId = ctx.userId ?? "00000000-0000-0000-0000-000000000010";
  const email = ctx.userEmail ?? "test@example.com";
  const role = ctx.role ?? "administrator";
  const accessLevel = ctx.accessLevel ?? "write";
  return createMiddleware(async (c, next) => {
    c.set("user", {
      id: userId,
      email,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    c.set("currentMemexId", memexId);
    c.set("currentRole", role);
    c.set("currentAccessLevel", accessLevel);
    return next();
  });
}

// Hono `use()` middleware that passes through without touching context. Useful as a
// vi.mock replacement for sessionMiddleware/memexResolver — the route still `.use()`s
// it but the stub before it (or inside the test) has already set the context vars.
export const passthroughMiddleware = createMiddleware(async (_c, next) => next());

export function makeTestAppWithTenant(ctx: TestTenantContext = {}): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("*", tenantStubMiddleware(ctx));
  return app;
}
