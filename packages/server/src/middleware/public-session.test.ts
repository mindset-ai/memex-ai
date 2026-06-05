import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-111 t-3 — permissive (public-read) session layer. Mirrors the env +
// mocking posture of session.test.ts so publicSessionMiddleware runs the same
// Bearer→user resolution as the strict middleware, but resolves userId=null
// (instead of 401) when no/invalid token is present.

const ORIGINAL_CLIENT_ID = vi.hoisted(() => {
  const v = process.env.GOOGLE_CLIENT_ID;
  // Set GOOGLE_CLIENT_ID so isDevMode() is false — we want to exercise the real
  // Bearer-token path, not the dev@memex.ai auto-login fallback.
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
import { publicSessionMiddleware, type SessionEnv } from "./session.js";
import { signSessionToken } from "../services/auth-jwt.js";

beforeAll(() => {
  expect(process.env.AUTH_JWT_SECRET).toHaveLength(48);
});
afterAll(() => {
  if (ORIGINAL_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.AUTH_JWT_SECRET = ORIGINAL_JWT_SECRET;
});

// A read route guarded by the permissive layer. Reports the resolved seam
// (currentUserId) plus whether a full user row is present.
const app = new Hono<SessionEnv>();
app.use("/*", publicSessionMiddleware);
app.get("/public-read", (c) => {
  const user = c.get("user");
  return c.json({
    currentUserId: c.get("currentUserId"),
    hasUser: user !== undefined && user !== null,
    userEmail: user?.email ?? null,
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
  namespaceId: "personal-acc-1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function auth(userId = sampleUser.id): { Authorization: string } {
  return { Authorization: `Bearer ${signSessionToken(userId)}` };
}

describe("publicSessionMiddleware (spec-111 t-3 — anonymous read)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves currentUserId=null (not 401) when NO Authorization header is present", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-111/acs/ac-6");

    const res = await app.request("/public-read");

    // The crux of t-3: anonymous request is NOT rejected — it proceeds with a
    // null userId seam for the read gate to consume.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentUserId).toBeNull();
    expect(body.hasUser).toBe(false);
    // getUserById is never reached on the anonymous path.
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("resolves currentUserId=null (not 401) when the Bearer token is INVALID/expired", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-111/acs/ac-6");

    const res = await app.request("/public-read", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });

    // An unparseable token is treated as anonymous on the permissive path,
    // mirroring the share.ts "token resolves identity, gate decides" split —
    // no 401, the read gate downstream decides public vs private.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentUserId).toBeNull();
    expect(body.hasUser).toBe(false);
  });

  it("resolves the user when a VALID token is presented (seam is the user id, full context resolved)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-111/acs/ac-6");

    getUserById.mockResolvedValue(sampleUser);
    listMemberships.mockResolvedValue([
      { memexId: "acc-1", slug: "acme", name: "Acme", role: "administrator" as const },
    ]);

    const res = await app.request("/public-read", { headers: auth() });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentUserId).toBe(sampleUser.id);
    expect(body.hasUser).toBe(true);
    expect(body.userEmail).toBe(sampleUser.email);
    // A member browsing keeps full write context (single-membership auto-resolve).
    expect(body.currentMemexId).toBe("acc-1");
    expect(body.currentRole).toBe("administrator");
  });

  it("resolves currentUserId=null when a well-formed token names a user that no longer exists", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-111/acs/ac-6");

    getUserById.mockResolvedValue(undefined);

    const res = await app.request("/public-read", { headers: auth() });

    // Strict middleware 401s here; permissive degrades to anonymous so a public
    // read can still proceed.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentUserId).toBeNull();
    expect(body.hasUser).toBe(false);
  });

  it("does NOT 404 a token-bearing NON-member on a path memex — defers to the read gate", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-111/acs/ac-6");

    getUserById.mockResolvedValue(sampleUser);
    // User is authenticated but has NO membership in the path memex.
    listMemberships.mockResolvedValue([]);

    const probeApp = new Hono<SessionEnv>();
    // Simulate memexResolver having stamped a path memex on context.
    probeApp.use("/*", async (c, next) => {
      c.set("memex", {
        id: "path-memex-99",
        slug: "their-memex",
        name: "Their Memex",
        namespaceId: "ns-other",
        visibility: "public",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
      return next();
    });
    probeApp.use("/*", publicSessionMiddleware);
    probeApp.get("/public-read", (c) =>
      c.json({
        currentUserId: c.get("currentUserId"),
        currentMemexId: c.get("currentMemexId"),
        currentRole: c.get("currentRole"),
      }),
    );

    const res = await probeApp.request("/public-read", { headers: auth() });

    // The membership-404 that strict sessionMiddleware would return is NOT
    // applied here — visibility (public→read, private→404) is the read gate's
    // call (t-2/t-5). This layer only owns the userId resolution.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentUserId).toBe(sampleUser.id);
    expect(body.currentMemexId).toBeNull();
    expect(body.currentRole).toBeNull();
  });
});
