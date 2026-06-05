// Unit tests for middleware/permissions.ts. The DB-dependent half of
// namespaceAccessGate is exercised via mocks here; full integration is
// covered by the /api/namespaces routes' integration tests.

import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirstNamespace = vi.hoisted(() => vi.fn());
const findFirstMembership = vi.hoisted(() => vi.fn());

vi.mock("../db/connection.js", () => ({
  db: {
    query: {
      namespaces: {
        findFirst: (...args: unknown[]) => findFirstNamespace(...args),
      },
      orgMemberships: {
        findFirst: (...args: unknown[]) => findFirstMembership(...args),
      },
    },
  },
}));

import { Hono } from "hono";
import { adminGate, namespaceAccessGate } from "./permissions.js";
import type { SessionEnv } from "./session.js";

function buildApp(routePath: string) {
  const app = new Hono<SessionEnv>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "user-1",
      email: "u@x.com",
      name: null,
      passwordHash: null,
      emailVerifiedAt: new Date(),
      status: "active",
      namespaceId: "ns-user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await next();
  });
  return app;
}

describe("adminGate", () => {
  it("returns 400 if no memex context is set", async () => {
    const app = buildApp("/x");
    app.use("*", async (c, next) => {
      c.set("currentMemexId", null);
      c.set("currentRole", null);
      await next();
    });
    app.get("/x", adminGate, (c) => c.json({ ok: true }));

    const res = await app.request("/x");
    expect(res.status).toBe(400);
  });

  // b-38 F-6 — When availableMemexes is set (user has multiple memberships, no path memex),
  // adminGate should return a structured 409 the UI can detect as "pick a workspace".
  it("returns 409 with availableMemexes when ambiguous (b-38 F-6)", async () => {
    const memberships = [
      {
        memexId: "acc-1",
        memexName: "Acme Main",
        slug: "acme",
        memexSlug: "main",
        name: "Acme",
        kind: "team" as const,
        role: "administrator" as const,
      },
      {
        memexId: "acc-2",
        memexName: "Beta Main",
        slug: "beta",
        memexSlug: "main",
        name: "Beta",
        kind: "team" as const,
        role: "member" as const,
      },
    ];
    const app = buildApp("/x");
    app.use("*", async (c, next) => {
      c.set("currentMemexId", null);
      c.set("currentRole", null);
      c.set("availableMemexes", memberships);
      await next();
    });
    app.get("/x", adminGate, (c) => c.json({ ok: true }));

    const res = await app.request("/x");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/multiple/i);
    expect(body.availableMemexes).toEqual(memberships);
  });

  it("returns 403 if caller is not administrator", async () => {
    const app = buildApp("/x");
    app.use("*", async (c, next) => {
      c.set("currentMemexId", "mx-1");
      c.set("currentRole", "member");
      await next();
    });
    app.get("/x", adminGate, (c) => c.json({ ok: true }));

    const res = await app.request("/x");
    expect(res.status).toBe(403);
  });

  it("passes through for administrator", async () => {
    const app = buildApp("/x");
    app.use("*", async (c, next) => {
      c.set("currentMemexId", "mx-1");
      c.set("currentRole", "administrator");
      await next();
    });
    app.get("/x", adminGate, (c) => c.json({ ok: true }));

    const res = await app.request("/x");
    expect(res.status).toBe(200);
  });
});

describe("namespaceAccessGate", () => {
  beforeEach(() => {
    findFirstNamespace.mockReset();
    findFirstMembership.mockReset();
  });

  it("returns 404 when namespace not found", async () => {
    findFirstNamespace.mockResolvedValueOnce(undefined);
    const app = buildApp("/x");
    app.get("/api/namespaces/:namespaceId/x", namespaceAccessGate, (c) => c.json({ ok: true }));

    const res = await app.request("/api/namespaces/missing/x");
    expect(res.status).toBe(404);
  });

  it("returns 404 for non-member of org namespace (std-7: no enumeration leak)", async () => {
    findFirstNamespace.mockResolvedValueOnce({
      id: "ns-1",
      slug: "acme",
      kind: "org",
      ownerOrgId: "org-1",
      ownerUserId: null,
    });
    findFirstMembership.mockResolvedValueOnce(undefined);
    const app = buildApp("/x");
    app.get("/api/namespaces/:namespaceId/x", namespaceAccessGate, (c) => c.json({ ok: true }));

    const res = await app.request("/api/namespaces/ns-1/x");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Namespace not found");
  });

  it("returns 404 for non-owner of personal namespace (std-7: no enumeration leak)", async () => {
    findFirstNamespace.mockResolvedValueOnce({
      id: "ns-2",
      slug: "alice",
      kind: "user",
      ownerOrgId: null,
      ownerUserId: "user-other",
    });
    const app = buildApp("/x");
    app.get("/api/namespaces/:namespaceId/x", namespaceAccessGate, (c) => c.json({ ok: true }));

    const res = await app.request("/api/namespaces/ns-2/x");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Namespace not found");
  });

  it("stamps currentNamespace + currentOrgId + currentNamespaceRole for org member", async () => {
    findFirstNamespace.mockResolvedValueOnce({
      id: "ns-1",
      slug: "acme",
      kind: "org",
      ownerOrgId: "org-1",
      ownerUserId: null,
    });
    findFirstMembership.mockResolvedValueOnce({
      userId: "user-1",
      orgId: "org-1",
      role: "member",
      status: "active",
    });
    const app = buildApp("/x");
    app.get("/api/namespaces/:namespaceId/x", namespaceAccessGate, (c) =>
      c.json({
        nsId: c.get("currentNamespace")?.id,
        orgId: c.get("currentOrgId"),
        role: c.get("currentNamespaceRole"),
      }),
    );

    const res = await app.request("/api/namespaces/ns-1/x");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ nsId: "ns-1", orgId: "org-1", role: "member" });
  });

  it("stamps currentNamespace for personal namespace owner", async () => {
    findFirstNamespace.mockResolvedValueOnce({
      id: "ns-2",
      slug: "alice",
      kind: "user",
      ownerOrgId: null,
      ownerUserId: "user-1",
    });
    const app = buildApp("/x");
    app.get("/api/namespaces/:namespaceId/x", namespaceAccessGate, (c) =>
      c.json({
        nsId: c.get("currentNamespace")?.id,
        orgId: c.get("currentOrgId"),
        role: c.get("currentNamespaceRole"),
      }),
    );

    const res = await app.request("/api/namespaces/ns-2/x");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ nsId: "ns-2" });
  });
});
