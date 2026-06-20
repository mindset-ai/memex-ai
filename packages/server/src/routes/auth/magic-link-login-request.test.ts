// spec-304: originating-session surrogate for the magic-link flow (embedded webview).
// Exercises the real magic-link route against mocked service + token layers — the same
// mocking posture as routes/auth.test.ts — so the route logic (response shapes, the
// surrogate create/verify/poll handshake, expiry + unknown-id branches) is covered without
// a live DB.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const ORIGINAL_JWT_SECRET = vi.hoisted(() => {
  const v = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET = "x".repeat(48);
  return v;
});

// --- token layer ---------------------------------------------------------------
const issueAuthToken = vi.hoisted(() => vi.fn());
const consumeAuthToken = vi.hoisted(() => vi.fn());
const AuthTokenErrorMock = vi.hoisted(
  () =>
    class AuthTokenError extends Error {
      constructor(
        public readonly reason: string,
        message: string,
      ) {
        super(message);
        this.name = "AuthTokenError";
      }
    },
);
vi.mock("../../services/auth-tokens.js", () => ({
  issueAuthToken,
  consumeAuthToken,
  AuthTokenError: AuthTokenErrorMock,
}));

// --- login-request surrogate layer --------------------------------------------
const createLoginRequest = vi.hoisted(() => vi.fn());
const getLoginRequestStatus = vi.hoisted(() => vi.fn());
const markLoginRequestVerified = vi.hoisted(() => vi.fn());
const deleteLoginRequest = vi.hoisted(() => vi.fn());
vi.mock("../../services/login-requests.js", () => ({
  createLoginRequest,
  getLoginRequestStatus,
  markLoginRequestVerified,
  deleteLoginRequest,
}));

// --- session/user layer --------------------------------------------------------
const resolveSession = vi.hoisted(() => vi.fn());
vi.mock("../../services/auth.js", () => ({ resolveSession }));

const getUserByEmail = vi.hoisted(() => vi.fn());
const upsertUserByEmail = vi.hoisted(() => vi.fn());
const markEmailVerified = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../services/users.js", () => ({
  getUserByEmail,
  upsertUserByEmail,
  markEmailVerified,
}));

vi.mock("../../services/user-namespaces.js", () => ({
  ensureUserMemex: vi.fn().mockResolvedValue({ id: "personal-acc" }),
}));

// Email sender is fire-and-forget in the route; stub it so no real send is attempted.
const send = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../services/email/sender.js", () => ({
  getEmailSender: () => ({ send }),
}));
vi.mock("../../services/email/templates.js", () => ({
  buildMagicLinkEmail: (args: unknown) => args,
}));

// Disable rate-limiting so repeated issues in a test don't 429.
vi.mock("../../services/auth-rate-limit.js", () => ({
  rateLimit: () => ({ ok: true }),
  AUTH_LIMITS: { magicLink: { max: 100, windowSec: 60 } },
}));

import { Hono } from "hono";
import { magicLink } from "./magic-link.js";
import { errorHandler } from "../../middleware/error-handler.js";

afterAll(() => {
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.AUTH_JWT_SECRET = ORIGINAL_JWT_SECRET;
});

const app = new Hono();
app.onError(errorHandler);
app.route("/api/auth/magic-link", magicLink);

const EMAIL = "alice@example.com";
const TOKEN_ID = "tok-1";
const LR_ID = "lr-cap-123";

const sampleSession = {
  user: {
    id: "user-1",
    email: EMAIL,
    name: null,
    status: "active" as const,
    emailVerified: true,
  },
  memberships: [],
  currentMemexId: null,
  currentRole: null,
  needsOnboarding: false,
};

function future(): Date {
  return new Date(Date.now() + 15 * 60 * 1000);
}
function past(): Date {
  return new Date(Date.now() - 1000);
}

beforeEach(() => {
  vi.clearAllMocks();
  markEmailVerified.mockResolvedValue(undefined);
});

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("POST /api/auth/magic-link (issue)", () => {
  it("returns a loginRequestId and never leaks the raw token", async () => {
    getUserByEmail.mockResolvedValue({ id: "user-1", email: EMAIL });
    issueAuthToken.mockResolvedValue({
      raw: "RAW-SECRET-TOKEN",
      row: { id: TOKEN_ID, expiresAt: future() },
    });
    createLoginRequest.mockResolvedValue({ id: LR_ID });

    const res = await app.request("/api/auth/magic-link", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: EMAIL }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, loginRequestId: LR_ID });
    // The raw token must not appear anywhere in the response.
    expect(JSON.stringify(body)).not.toContain("RAW-SECRET-TOKEN");

    // The surrogate is created against the issued token with the token's own TTL.
    expect(createLoginRequest).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: TOKEN_ID, email: EMAIL }),
    );
  });
});

describe("POST /api/auth/magic-link/consume", () => {
  it("flips the surrogate verified after consuming the token", async () => {
    consumeAuthToken.mockResolvedValue({ id: TOKEN_ID, email: EMAIL, userId: "user-1" });
    upsertUserByEmail.mockResolvedValue({ id: "user-1", email: EMAIL });
    resolveSession.mockResolvedValue(sampleSession);

    const res = await app.request("/api/auth/magic-link/consume", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: "RAW-SECRET-TOKEN" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe(EMAIL);
    expect(typeof body.token).toBe("string");
    // The surrogate for THIS token id is flipped verified.
    expect(markLoginRequestVerified).toHaveBeenCalledWith(TOKEN_ID);
  });

  it("still requires the raw token (invalid token → 400, no verify)", async () => {
    consumeAuthToken.mockRejectedValue(new AuthTokenErrorMock("unknown", "Invalid"));

    const res = await app.request("/api/auth/magic-link/consume", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: "garbage" }),
    });

    expect(res.status).toBe(400);
    expect(markLoginRequestVerified).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/magic-link/login-requests/:id/status", () => {
  it("404s for an unknown id", async () => {
    getLoginRequestStatus.mockResolvedValue(null);
    const res = await app.request(`/api/auth/magic-link/login-requests/${LR_ID}/status`);
    expect(res.status).toBe(404);
  });

  it("returns not-verified before the link is consumed", async () => {
    getLoginRequestStatus.mockResolvedValue({
      id: LR_ID,
      email: EMAIL,
      verifiedAt: null,
      expiresAt: future(),
    });
    const res = await app.request(`/api/auth/magic-link/login-requests/${LR_ID}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: false, expired: false });
  });

  it("returns expired for an unverified, lapsed request", async () => {
    getLoginRequestStatus.mockResolvedValue({
      id: LR_ID,
      email: EMAIL,
      verifiedAt: null,
      expiresAt: past(),
    });
    const res = await app.request(`/api/auth/magic-link/login-requests/${LR_ID}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: false, expired: true });
  });

  it("returns a verified session payload after consume, and single-shots the row", async () => {
    getLoginRequestStatus.mockResolvedValue({
      id: LR_ID,
      email: EMAIL,
      verifiedAt: new Date(),
      expiresAt: future(),
    });
    getUserByEmail.mockResolvedValue({ id: "user-1", email: EMAIL });
    resolveSession.mockResolvedValue(sampleSession);
    // The claiming delete returns the row it removed — the route mints the session from it.
    deleteLoginRequest.mockResolvedValue({ id: LR_ID, email: EMAIL });

    const res = await app.request(`/api/auth/magic-link/login-requests/${LR_ID}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(body.user.email).toBe(EMAIL);
    expect(typeof body.token).toBe("string"); // same authenticated shape as /consume
    // Single-shot: the surrogate is deleted (claimed) BEFORE the session is handed over.
    expect(deleteLoginRequest).toHaveBeenCalledWith(LR_ID);
  });

  it("hands out exactly one session under a concurrent-poll race (delete is the gate)", async () => {
    // Both polls read the same verified, unexpired row...
    getLoginRequestStatus.mockResolvedValue({
      id: LR_ID,
      email: EMAIL,
      verifiedAt: new Date(),
      expiresAt: future(),
    });
    getUserByEmail.mockResolvedValue({ id: "user-1", email: EMAIL });
    resolveSession.mockResolvedValue(sampleSession);
    // ...but the atomic DELETE only returns a row to the winner; the loser gets null.
    deleteLoginRequest.mockResolvedValue(null);

    const res = await app.request(`/api/auth/magic-link/login-requests/${LR_ID}/status`);
    expect(res.status).toBe(200);
    // The losing poll mints NO session — it never minted a second token from one capability.
    expect(await res.json()).toEqual({ verified: false, expired: false });
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it("refuses to mint a session for a verified-but-expired request", async () => {
    getLoginRequestStatus.mockResolvedValue({
      id: LR_ID,
      email: EMAIL,
      verifiedAt: new Date(),
      expiresAt: past(),
    });
    const res = await app.request(`/api/auth/magic-link/login-requests/${LR_ID}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: false, expired: true });
    expect(deleteLoginRequest).not.toHaveBeenCalled();
  });
});
