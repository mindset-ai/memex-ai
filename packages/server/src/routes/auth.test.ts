import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// OAuth mock must land before auth.ts module load — the /sso/google path still verifies
// Google ID tokens via OAuth2Client. The session-middleware path uses our JWT (below).
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

const mockVerifyIdToken = vi.hoisted(() => vi.fn());
vi.mock("google-auth-library", () => ({
  OAuth2Client: class MockOAuth2Client {
    verifyIdToken = mockVerifyIdToken;
  },
}));

const handleSsoLogin = vi.hoisted(() => vi.fn());
const resolveSession = vi.hoisted(() => vi.fn());

const MemexAccessErrorMock = vi.hoisted(
  () =>
    class MemexAccessError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "MemexAccessError";
      }
    },
);
const DisabledUserErrorMock = vi.hoisted(
  () =>
    class DisabledUserError extends Error {
      constructor(email: string) {
        super(`User ${email} is disabled and cannot sign in`);
        this.name = "DisabledUserError";
      }
    },
);

vi.mock("../services/auth.js", () => ({
  handleSsoLogin,
  resolveSession,
  MemexAccessError: MemexAccessErrorMock,
  DisabledUserError: DisabledUserErrorMock,
}));

const getUserById = vi.hoisted(() => vi.fn());
const getUserByEmail = vi.hoisted(() => vi.fn());
// Default empty — sessionMiddleware calls listMemberships to resolve the user's personal
// account even without a tenant header, so undefined would crash the .find() call.
const listMemberships = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const upsertUserByEmail = vi.hoisted(() => vi.fn());
const updateUserProfile = vi.hoisted(() => vi.fn());
const createUserWithPassword = vi.hoisted(() => vi.fn());
const markEmailVerified = vi.hoisted(() => vi.fn().mockImplementation((id: string) => ({ id })));
const setUserPasswordHash = vi.hoisted(() => vi.fn());

vi.mock("../services/users.js", () => ({
  getUserById,
  getUserByEmail,
  listMemberships,
  upsertUserByEmail,
  updateUserProfile,
  createUserWithPassword,
  markEmailVerified,
  setUserPasswordHash,
  listMembershipsMatchingDomain: vi.fn(),
}));

vi.mock("../services/personal-memexes.js", () => ({
  ensureUserMemex: vi.fn().mockResolvedValue({ id: "personal-acc" }),
  PERSONAL_ACCOUNT_NAME: "Personal Memex",
  personalSubdomain: (userId: string) => `personal-${userId}`,
}));

import { Hono } from "hono";
import { auth } from "./auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { signSessionToken } from "../services/auth-jwt.js";

const MemexAccessError = MemexAccessErrorMock;
const DisabledUserError = DisabledUserErrorMock;

afterAll(() => {
  if (ORIGINAL_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.AUTH_JWT_SECRET = ORIGINAL_JWT_SECRET;
});

const app = new Hono();
app.onError(errorHandler);
app.route("/api/auth", auth);

const sampleUser = {
  id: "user-1",
  email: "alice@example.com",
  name: null,
  status: "active" as const,
  passwordHash: null,
  emailVerifiedAt: new Date(),
  namespaceId: "personal-user-1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const sampleSession = {
  user: {
    id: "user-1",
    email: "alice@example.com",
    name: null,
    status: "active" as const,
    emailVerified: true,
  },
  memberships: [],
  currentMemexId: null,
  currentRole: null,
  needsOnboarding: true,
};

function authedHeaders(userId = sampleUser.id): { Authorization: string; "Content-Type": string } {
  return {
    Authorization: `Bearer ${signSessionToken(userId)}`,
    "Content-Type": "application/json",
  };
}

describe("POST /api/auth/sso/google", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the session payload (with a fresh server-issued JWT) from handleSsoLogin", async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "alice@example.com", email_verified: true }),
    });
    handleSsoLogin.mockResolvedValue(sampleSession);

    const res = await app.request("/api/auth/sso/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "tok" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe(sampleSession.user.email);
    expect(body.user.emailVerified).toBe(true);
    expect(typeof body.token).toBe("string");
    expect(handleSsoLogin).toHaveBeenCalledWith({ email: "alice@example.com", hd: undefined }, null);
  });

  it("forwards hd claim to handleSsoLogin", async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "alice@acme.com", email_verified: true, hd: "acme.com" }),
    });
    handleSsoLogin.mockResolvedValue(sampleSession);

    await app.request("/api/auth/sso/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "tok" }),
    });

    expect(handleSsoLogin).toHaveBeenCalledWith(
      { email: "alice@acme.com", hd: "acme.com" },
      null,
    );
  });

  it("forwards requested memexId to handleSsoLogin", async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "a@a.com", email_verified: true }),
    });
    handleSsoLogin.mockResolvedValue(sampleSession);

    await app.request("/api/auth/sso/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "tok", memexId: "acc-123" }),
    });

    expect(handleSsoLogin).toHaveBeenCalledWith({ email: "a@a.com", hd: undefined }, "acc-123");
  });

  it("returns 400 when idToken is missing", async () => {
    const res = await app.request("/api/auth/sso/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 when Google token verification fails", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("expired"));
    const res = await app.request("/api/auth/sso/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "expired-token" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when payload has no email", async () => {
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "g-2" }) });
    const res = await app.request("/api/auth/sso/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "tok" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when handleSsoLogin throws MemexAccessError", async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "a@a.com", email_verified: true }),
    });
    handleSsoLogin.mockRejectedValue(new MemexAccessError("not a member"));

    const res = await app.request("/api/auth/sso/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "tok", memexId: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 when handleSsoLogin throws DisabledUserError", async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "a@a.com", email_verified: true }),
    });
    handleSsoLogin.mockRejectedValue(new DisabledUserError("a@a.com"));

    const res = await app.request("/api/auth/sso/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "tok" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/auth/me", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the resolved session for an authenticated user", async () => {
    getUserById.mockResolvedValue(sampleUser);
    resolveSession.mockResolvedValue(sampleSession);

    const res = await app.request("/api/auth/me", { headers: authedHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(sampleSession);
  });

  it("returns 401 when no Authorization header is present", async () => {
    const res = await app.request("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 when user sub doesn't resolve to a DB row", async () => {
    getUserById.mockResolvedValue(undefined);
    const res = await app.request("/api/auth/me", { headers: authedHeaders("u-ghost") });
    expect(res.status).toBe(401);
  });

  it("returns 403 when user is disabled", async () => {
    getUserById.mockResolvedValue({ ...sampleUser, status: "disabled" });
    const res = await app.request("/api/auth/me", { headers: authedHeaders() });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/auth/switch-account", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the new session when membership is valid", async () => {
    getUserById.mockResolvedValue(sampleUser);
    resolveSession.mockResolvedValue({
      ...sampleSession,
      currentMemexId: "acc-2",
      currentRole: "administrator",
    });

    const res = await app.request("/api/auth/switch-account", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ memexId: "acc-2" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentMemexId).toBe("acc-2");
    expect(body.currentRole).toBe("administrator");
  });

  it("returns 400 when memexId is missing", async () => {
    getUserById.mockResolvedValue(sampleUser);

    const res = await app.request("/api/auth/switch-account", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 when target account isn't a membership", async () => {
    getUserById.mockResolvedValue(sampleUser);
    resolveSession.mockRejectedValue(new MemexAccessError("not a member"));

    const res = await app.request("/api/auth/switch-account", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ memexId: "other" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/auth/profile", () => {
  beforeEach(() => vi.clearAllMocks());

  function authed() {
    getUserById.mockResolvedValue(sampleUser);
  }

  it("returns updated session when name is valid", async () => {
    authed();
    const updatedSession = {
      ...sampleSession,
      user: { ...sampleSession.user, name: "Alice" },
      needsOnboarding: false,
    };
    updateUserProfile.mockResolvedValue({ ...sampleUser, name: "Alice" });
    resolveSession.mockResolvedValue(updatedSession);

    const res = await app.request("/api/auth/profile", {
      method: "PATCH",
      headers: authedHeaders(),
      body: JSON.stringify({ name: "Alice" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.name).toBe("Alice");
    expect(body.needsOnboarding).toBe(false);
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/auth/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when name is missing", async () => {
    authed();
    const res = await app.request("/api/auth/profile", {
      method: "PATCH",
      headers: authedHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when name is empty string", async () => {
    authed();
    const res = await app.request("/api/auth/profile", {
      method: "PATCH",
      headers: authedHeaders(),
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when name exceeds 100 characters", async () => {
    authed();
    const res = await app.request("/api/auth/profile", {
      method: "PATCH",
      headers: authedHeaders(),
      body: JSON.stringify({ name: "A".repeat(101) }),
    });
    expect(res.status).toBe(400);
  });
});
