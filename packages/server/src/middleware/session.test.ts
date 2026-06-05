import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

// Pre-import env stubbing so session.ts + auth-jwt.ts capture the right config at module load.
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
// Default to empty — the middleware calls listMemberships to resolve personal memexes
// even when no tenant header is present, so undefined would crash the .find() call.
const listMemberships = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const upsertUserByEmail = vi.hoisted(() => vi.fn());

vi.mock("../services/users.js", () => ({
  getUserById,
  getUserByEmail,
  listMemberships,
  upsertUserByEmail,
  listMembershipsMatchingDomain: vi.fn(),
}));

vi.mock("../services/user-namespaces.js", () => ({
  ensureUserNamespace: vi.fn().mockResolvedValue({
    namespace: { id: "ns-1", slug: "alice", kind: "user", ownerUserId: "user-1" },
    memex: { id: "personal-user-1", slug: "personal", name: "Personal Memex", namespaceId: "ns-1" },
  }),
  ensureUserMemex: vi.fn().mockResolvedValue({ id: "personal-user-1" }),
  PERSONAL_MEMEX_NAME: "Personal Memex",
}));

import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "./session.js";
import { signSessionToken } from "../services/auth-jwt.js";

beforeAll(() => {
  // trigger hoisted env assignment — keep linter quiet.
  expect(process.env.AUTH_JWT_SECRET).toHaveLength(48);
});
afterAll(() => {
  if (ORIGINAL_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.AUTH_JWT_SECRET = ORIGINAL_JWT_SECRET;
});

const app = new Hono<SessionEnv>();
app.use("/*", sessionMiddleware);
app.get("/test", (c) => {
  const user = c.get("user");
  return c.json({
    userId: user.id,
    currentMemexId: c.get("currentMemexId"),
    currentRole: c.get("currentRole"),
  });
});

const sampleUser = {
  id: "user-1",
  email: "alice@example.com",
  name: "Alice",
  status: "active" as const,
  passwordHash: null,
  emailVerifiedAt: new Date(),
  // Populated so the session middleware's lazy-provision branch is a no-op for these unit
  // tests (ensureUserMemex would otherwise try to hit the real DB from a mocked env).
  namespaceId: "personal-acc-1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function auth(userId = sampleUser.id): { Authorization: string } {
  return { Authorization: `Bearer ${signSessionToken(userId)}` };
}

describe("sessionMiddleware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when Authorization header is missing", async () => {
    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when user is not found in DB", async () => {
    getUserById.mockResolvedValue(undefined);
    const res = await app.request("/test", { headers: auth() });
    expect(res.status).toBe(401);
  });

  it("returns 403 when user is disabled", async () => {
    getUserById.mockResolvedValue({ ...sampleUser, status: "disabled" });
    const res = await app.request("/test", { headers: auth() });
    expect(res.status).toBe(403);
  });

  it("sets user with null currentMemexId when user has multiple memberships and no path memex", async () => {
    getUserById.mockResolvedValue(sampleUser);
    listMemberships.mockResolvedValue([
      { memexId: "acc-1", slug: "acme", name: "Acme", role: "administrator" as const },
      { memexId: "acc-2", slug: "beta", name: "Beta", role: "member" as const },
    ]);

    const res = await app.request("/test", { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(sampleUser.id);
    expect(body.currentMemexId).toBeNull();
    expect(body.currentRole).toBeNull();
  });

  // b-38 F-6 — when a user joins a second org, auto-resolve becomes ambiguous.
  // Stash the list on context so downstream routes can return a structured 409
  // instead of a cryptic 400, letting the UI render the workspace picker
  // without a separate /api/me/namespaces round-trip.
  it("stamps availableMemexes on context when user has multiple memberships and no path memex (b-38 F-6)", async () => {
    getUserById.mockResolvedValue(sampleUser);
    const memberships = [
      { memexId: "acc-1", slug: "acme", name: "Acme", role: "administrator" as const },
      { memexId: "acc-2", slug: "beta", name: "Beta", role: "member" as const },
    ];
    listMemberships.mockResolvedValue(memberships);

    const probeApp = new Hono<SessionEnv>();
    probeApp.use("/*", sessionMiddleware);
    probeApp.get("/probe", (c) =>
      c.json({ availableMemexes: c.get("availableMemexes") ?? null }),
    );

    const res = await probeApp.request("/probe", { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.availableMemexes).toEqual(memberships);
  });

  it("does NOT stamp availableMemexes when user has exactly one membership (b-38 F-6)", async () => {
    getUserById.mockResolvedValue(sampleUser);
    listMemberships.mockResolvedValue([
      { memexId: "acc-1", slug: "acme", name: "Acme", role: "administrator" as const },
    ]);

    const probeApp = new Hono<SessionEnv>();
    probeApp.use("/*", sessionMiddleware);
    probeApp.get("/probe", (c) =>
      c.json({ availableMemexes: c.get("availableMemexes") ?? null }),
    );

    const res = await probeApp.request("/probe", { headers: auth() });
    const body = await res.json();
    expect(body.availableMemexes).toBeNull();
  });

  it("auto-resolves currentMemexId when user has exactly one membership", async () => {
    getUserById.mockResolvedValue(sampleUser);
    listMemberships.mockResolvedValue([
      {
        memexId: "acc-1",
        slug: "acme",
        name: "Acme",
        role: "administrator" as const,
      },
    ]);

    const res = await app.request("/test", { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentMemexId).toBe("acc-1");
    expect(body.currentRole).toBe("administrator");
  });

  it("accepts lowercase 'bearer' prefix is NOT supported (strict capital B)", async () => {
    const res = await app.request("/test", {
      headers: { Authorization: `bearer ${signSessionToken(sampleUser.id)}` },
    });
    expect(res.status).toBe(401);
  });
});

// b-38 F-1 — dev-auth bypass must require NODE_ENV !== 'production'. Without this
// guard, prod booting with a missing GOOGLE_CLIENT_ID (rotation slip, partial deploy,
// Secret Manager misconfig) silently authenticates every visitor as dev@memex.ai.
// Mirrors the auth-jwt.ts:43 pattern.
describe("sessionMiddleware — production dev-mode guard (b-38 F-1)", () => {
  beforeEach(() => vi.clearAllMocks());

  function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
    const original: Record<string, string | undefined> = {};
    return async () => {
      for (const key of Object.keys(env)) {
        original[key] = process.env[key];
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
      }
      try {
        await fn();
      } finally {
        for (const key of Object.keys(original)) {
          if (original[key] === undefined) delete process.env[key];
          else process.env[key] = original[key];
        }
      }
    };
  }

  const devUser = {
    ...sampleUser,
    id: "user-dev",
    email: "dev@memex.ai",
    namespaceId: "ns-dev",
  };

  it(
    "refuses to fall through to dev user when NODE_ENV=production and GOOGLE_CLIENT_ID is missing",
    withEnv(
      { NODE_ENV: "production", GOOGLE_CLIENT_ID: undefined },
      async () => {
        // Make the dev-fallback path succeed if reached, so the ONLY reason to
        // fail is the new production guard.
        upsertUserByEmail.mockResolvedValue(devUser);
        getUserById.mockResolvedValue(devUser);
        listMemberships.mockResolvedValue([]);

        const res = await app.request("/test");
        // Pre-fix: 200 (dev fallback authenticated as dev@memex.ai).
        // Post-fix: 500 (guard throws because prod requires GOOGLE_CLIENT_ID).
        expect(res.status).toBe(500);
      },
    ),
  );

  it(
    "still uses dev fallback when NODE_ENV is not production and GOOGLE_CLIENT_ID is missing",
    withEnv(
      { NODE_ENV: "development", GOOGLE_CLIENT_ID: undefined },
      async () => {
        upsertUserByEmail.mockResolvedValue(devUser);
        getUserById.mockResolvedValue(devUser);
        listMemberships.mockResolvedValue([]);

        const res = await app.request("/test");
        expect(res.status).toBe(200);
      },
    ),
  );

  it(
    "uses normal JWT flow when GOOGLE_CLIENT_ID is set, regardless of NODE_ENV",
    withEnv(
      { NODE_ENV: "production", GOOGLE_CLIENT_ID: "real-client-id" },
      async () => {
        getUserById.mockResolvedValue(sampleUser);
        const res = await app.request("/test", { headers: auth() });
        expect(res.status).toBe(200);
      },
    ),
  );
});
