import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const ORIGINAL_CLIENT_ID = vi.hoisted(() => {
  const v = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  return v;
});
const ORIGINAL_JWT_SECRET = vi.hoisted(() => {
  const v = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET = "x".repeat(48);
  return v;
});

const getUserById = vi.hoisted(() => vi.fn());
const getUserByEmail = vi.hoisted(() => vi.fn());
const listMemberships = vi.hoisted(() => vi.fn());
const upsertUserByEmail = vi.hoisted(() => vi.fn());

vi.mock("../services/users.js", () => ({
  getUserById,
  getUserByEmail,
  listMemberships,
  upsertUserByEmail,
  listMembershipsMatchingDomain: vi.fn(),
}));

// Lazy-provision is exercised by integration tests; unit tests mock it out so fixtures
// don't need to simulate the DB round-trip.
vi.mock("../services/user-namespaces.js", () => ({
  ensureUserNamespace: vi.fn().mockResolvedValue({
    namespace: { id: "ns-1", slug: "alice", kind: "user", ownerUserId: "u1" },
    memex: { id: "personal-u1", slug: "personal", name: "Personal Memex", namespaceId: "ns-1" },
  }),
  ensureUserMemex: vi.fn().mockResolvedValue({ id: "personal-u1" }),
  PERSONAL_MEMEX_NAME: "Personal Memex",
}));

import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "./session.js";
import { signSessionToken } from "../services/auth-jwt.js";

afterAll(() => {
  if (ORIGINAL_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.AUTH_JWT_SECRET = ORIGINAL_JWT_SECRET;
});

const activeUser = {
  id: "u1",
  email: "alice@example.com",
  name: "Alice",
  status: "active" as const,
  passwordHash: null,
  emailVerifiedAt: new Date(),
  // Populated so the session middleware's lazy-provision branch is a no-op for these unit
  // tests (ensureUserMemex would otherwise try to hit the real DB from a mocked env).
  namespaceId: "personal-u1",
  createdAt: new Date(),
  updatedAt: new Date(),
};
const disabledUser = { ...activeUser, id: "u2", email: "disabled@example.com", status: "disabled" as const };

const app = new Hono<SessionEnv>();
app.use("/*", sessionMiddleware);
app.get("/test", (c) => {
  return c.json({
    userId: c.get("user").id,
    currentMemexId: c.get("currentMemexId"),
    currentRole: c.get("currentRole"),
  });
});

function authFor(userId: string): { Authorization: string } {
  return { Authorization: `Bearer ${signSessionToken(userId)}` };
}

// t-14: session middleware edge cases deferred from t-8 / t-9.
describe("sessionMiddleware — disabled user rejection (t-14)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 when the user row has status=disabled (SSO-level lockout)", async () => {
    getUserById.mockResolvedValue(disabledUser);

    const res = await app.request("/test", { headers: authFor(disabledUser.id) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("User is disabled");
  });
});

describe("sessionMiddleware — auto-resolution edges", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-resolves single membership to currentMemexId", async () => {
    getUserById.mockResolvedValue(activeUser);
    listMemberships.mockResolvedValue([
      { memexId: "acc-b", slug: "b", name: "B", role: "administrator" as const },
    ]);

    const res = await app.request("/test", { headers: authFor(activeUser.id) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentMemexId).toBe("acc-b");
    expect(body.currentRole).toBe("administrator");
  });

  it("leaves currentMemexId null when the user has multiple memberships and no path memex", async () => {
    getUserById.mockResolvedValue(activeUser);
    listMemberships.mockResolvedValue([
      { memexId: "acc-a", slug: "a", name: "A", role: "member" as const },
      { memexId: "acc-b", slug: "b", name: "B", role: "administrator" as const },
    ]);

    const res = await app.request("/test", { headers: authFor(activeUser.id) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentMemexId).toBeNull();
    expect(body.currentRole).toBeNull();
  });

  it("leaves currentMemexId null when the user has zero memberships", async () => {
    getUserById.mockResolvedValue(activeUser);
    listMemberships.mockResolvedValue([]);

    const res = await app.request("/test", { headers: authFor(activeUser.id) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentMemexId).toBeNull();
    expect(body.currentRole).toBeNull();
  });

  it("rejects an invalid Bearer token with 401", async () => {
    const res = await app.request("/test", { headers: { Authorization: "Bearer garbage" } });
    expect(res.status).toBe(401);
  });

  it("rejects when the token's sub resolves to no user (e.g. user was deleted)", async () => {
    getUserById.mockResolvedValue(undefined);

    const res = await app.request("/test", { headers: authFor("u-ghost") });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toMatch(/sign in/i);
  });
});
