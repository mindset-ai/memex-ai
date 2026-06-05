import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────────────

const dbInsertValues = vi.fn();
const dbInsertOnConflict = vi.fn();
const dbUpdateSet = vi.fn();
const dbUpdateWhere = vi.fn();
const findFirst = vi.fn();
const mutateFn = vi.fn();

vi.mock("../../../db/connection.js", () => ({
  db: {
    query: { userSlackTokens: { findFirst } },
    insert: () => ({ values: dbInsertValues }),
    update: () => ({ set: dbUpdateSet }),
  },
}));

vi.mock("./crypto.js", () => ({
  encryptToken: vi.fn(async (raw: string) => ({
    ciphertext: new TextEncoder().encode(`enc:${raw}`),
    iv: new Uint8Array([1, 2, 3]),
    wrappedDek: new Uint8Array([4, 5, 6]),
  })),
  decryptToken: vi.fn(async () => "xoxp-fake-token"),
}));

vi.mock("../../mutate.js", () => ({
  mutate: (...args: unknown[]) => mutateFn(...args),
}));

const oauthAccess = vi.fn();
const authRevoke = vi.fn();
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    oauth = { v2: { access: oauthAccess } };
    auth = { revoke: authRevoke };
  },
}));

const {
  makeStateToken,
  verifyStateToken,
  exchangeOAuthCode,
  revokeOnSlack,
  storeUserSlackToken,
  markUserSlackTokenRevoked,
  SlackOAuthError,
} = await import("./oauth.js");

beforeEach(() => {
  dbInsertValues.mockReset();
  dbInsertOnConflict.mockReset();
  dbInsertValues.mockReturnValue({ onConflictDoUpdate: dbInsertOnConflict });
  dbUpdateSet.mockReset();
  dbUpdateWhere.mockReset();
  dbUpdateSet.mockReturnValue({ where: dbUpdateWhere });
  findFirst.mockReset();
  mutateFn.mockReset();
  mutateFn.mockImplementation(async (_ctx: unknown, _key: unknown, fn: () => Promise<unknown>) => fn());
  oauthAccess.mockReset();
  authRevoke.mockReset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const FAKE_USER_ID = "00000000-0000-0000-0000-000000000001";
const FAKE_ORG_ID = "00000000-0000-0000-0000-000000000002";

// ──────────────────────────────────────────────────────────────────────────
// State tokens
// ──────────────────────────────────────────────────────────────────────────

describe("state token round-trip", () => {
  it("verifies a fresh token back to { userId, orgId }", () => {
    const token = makeStateToken(FAKE_USER_ID, FAKE_ORG_ID);
    expect(verifyStateToken(token)).toEqual({ userId: FAKE_USER_ID, orgId: FAKE_ORG_ID });
  });

  it("rejects a malformed token", () => {
    expect(verifyStateToken("not-a-token")).toBeNull();
    expect(verifyStateToken("")).toBeNull();
    expect(verifyStateToken("only.two")).toBeNull();
    expect(verifyStateToken("only.three.parts")).toBeNull();
  });

  it("rejects a token with tampered signature", () => {
    const token = makeStateToken(FAKE_USER_ID, FAKE_ORG_ID);
    const parts = token.split(".");
    parts[3] = "X".repeat(parts[3].length); // overwrite sig (now index 3)
    expect(verifyStateToken(parts.join("."))).toBeNull();
  });

  it("rejects a token with tampered userId", () => {
    const token = makeStateToken(FAKE_USER_ID, FAKE_ORG_ID);
    const parts = token.split(".");
    parts[0] = Buffer.from("attacker-user-id").toString("base64url");
    expect(verifyStateToken(parts.join("."))).toBeNull();
  });

  it("rejects a token with tampered orgId", () => {
    const token = makeStateToken(FAKE_USER_ID, FAKE_ORG_ID);
    const parts = token.split(".");
    parts[1] = Buffer.from("attacker-org-id").toString("base64url");
    expect(verifyStateToken(parts.join("."))).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = makeStateToken(FAKE_USER_ID, FAKE_ORG_ID);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000); // 11 min in the future, past TTL
    expect(verifyStateToken(token)).toBeNull();
    vi.useRealTimers();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// exchangeOAuthCode
// ──────────────────────────────────────────────────────────────────────────

describe("exchangeOAuthCode", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_CLIENT_ID", "test-client-id");
    vi.stubEnv("SLACK_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("SLACK_OAUTH_REDIRECT_URI", "https://memex.test/callback");
  });

  it("returns the user access token + IDs + scope on success", async () => {
    oauthAccess.mockResolvedValueOnce({
      ok: true,
      authed_user: {
        id: "U123",
        access_token: "xoxp-test-user-token",
        scope: "chat:write,users:read,channels:read",
      },
      team: { id: "T456" },
    });
    const result = await exchangeOAuthCode("test-code");
    expect(result).toEqual({
      accessToken: "xoxp-test-user-token",
      slackUserId: "U123",
      slackWorkspaceId: "T456",
      scope: "chat:write,users:read,channels:read",
    });
    expect(oauthAccess).toHaveBeenCalledWith({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      code: "test-code",
      redirect_uri: "https://memex.test/callback",
    });
  });

  it("throws not_configured when env vars are missing", async () => {
    vi.unstubAllEnvs();
    await expect(exchangeOAuthCode("any-code")).rejects.toMatchObject({
      name: "SlackOAuthError",
      code: "not_configured",
    });
    expect(oauthAccess).not.toHaveBeenCalled();
  });

  it("throws when Slack returns ok:false", async () => {
    oauthAccess.mockResolvedValueOnce({ ok: false, error: "invalid_code" });
    await expect(exchangeOAuthCode("bad-code")).rejects.toMatchObject({
      code: "invalid_code",
    });
  });

  it("throws when authed_user.access_token is missing", async () => {
    oauthAccess.mockResolvedValueOnce({
      ok: true,
      authed_user: { id: "U123" }, // missing access_token
      team: { id: "T456" },
    });
    await expect(exchangeOAuthCode("c")).rejects.toBeInstanceOf(SlackOAuthError);
  });

  it("throws incomplete_response when team.id is missing", async () => {
    oauthAccess.mockResolvedValueOnce({
      ok: true,
      authed_user: { id: "U123", access_token: "xoxp-t" },
      // no team
    });
    await expect(exchangeOAuthCode("c")).rejects.toMatchObject({
      code: "incomplete_response",
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// revokeOnSlack
// ──────────────────────────────────────────────────────────────────────────

describe("revokeOnSlack", () => {
  it("returns true when Slack confirms revocation", async () => {
    authRevoke.mockResolvedValueOnce({ ok: true, revoked: true });
    expect(await revokeOnSlack("xoxp-test")).toBe(true);
  });

  it("returns false when Slack responds ok:false", async () => {
    authRevoke.mockResolvedValueOnce({ ok: false, error: "invalid_auth" });
    expect(await revokeOnSlack("xoxp-bad")).toBe(false);
  });

  it("returns false on network error (swallows the throw)", async () => {
    authRevoke.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await revokeOnSlack("xoxp-t")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// storeUserSlackToken — upsert semantics + mutate() emit
// ──────────────────────────────────────────────────────────────────────────

describe("storeUserSlackToken", () => {
  it("upserts via insert(...).onConflictDoUpdate and emits user_slack_token.created", async () => {
    await storeUserSlackToken({
      userId: FAKE_USER_ID,
      orgId: FAKE_ORG_ID,
      slackUserId: "U1",
      slackWorkspaceId: "T1",
      accessToken: "xoxp-fresh",
      scope: "chat:write",
    });

    expect(mutateFn).toHaveBeenCalledTimes(1);
    const [, key] = mutateFn.mock.calls[0];
    expect(key).toMatchObject({
      memexId: "",
      userId: FAKE_USER_ID,
      entity: "user_slack_token",
      action: "created",
    });

    // INSERT values shape
    expect(dbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: FAKE_USER_ID,
        slackUserId: "U1",
        slackWorkspaceId: "T1",
        scope: "chat:write",
      }),
    );

    // The conflict branch must include revokedAt: null (reconnect resets the revoke flag).
    expect(dbInsertOnConflict).toHaveBeenCalledTimes(1);
    const conflictArg = dbInsertOnConflict.mock.calls[0][0] as {
      set: { revokedAt: null | unknown };
    };
    expect(conflictArg.set.revokedAt).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// markUserSlackTokenRevoked
// ──────────────────────────────────────────────────────────────────────────

describe("markUserSlackTokenRevoked", () => {
  it("sets revoked_at via update() and emits user_slack_token.deleted", async () => {
    await markUserSlackTokenRevoked(FAKE_USER_ID, FAKE_ORG_ID);

    expect(mutateFn).toHaveBeenCalledTimes(1);
    const [, key] = mutateFn.mock.calls[0];
    expect(key).toMatchObject({
      memexId: "",
      userId: FAKE_USER_ID,
      entity: "user_slack_token",
      action: "deleted",
    });

    expect(dbUpdateSet).toHaveBeenCalledTimes(1);
    const setArg = dbUpdateSet.mock.calls[0][0] as { revokedAt: unknown };
    expect(setArg.revokedAt).toBeDefined(); // sql`now()` token
  });
});
