import { beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────────────

const tokenFindFirst = vi.fn();
const cacheFindFirst = vi.fn();
const cacheInsertValues = vi.fn();
const cacheOnConflict = vi.fn();
const mutateFn = vi.fn();

vi.mock("../../../db/connection.js", () => ({
  db: {
    query: {
      userSlackTokens: { findFirst: tokenFindFirst },
      slackUserCache: { findFirst: cacheFindFirst },
    },
    insert: () => ({ values: cacheInsertValues }),
  },
}));

vi.mock("./crypto.js", () => ({
  decryptToken: vi.fn(async () => "xoxp-fake-token"),
}));

vi.mock("../../mutate.js", () => ({
  mutate: (...args: unknown[]) => mutateFn(...args),
}));

const usersList = vi.fn();
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    users = { list: usersList };
  },
}));

const {
  resolveSlackUser,
  matchUsers,
  normalizeQuery,
  SlackUserResolutionError,
} = await import("./users.js");

beforeEach(() => {
  tokenFindFirst.mockReset();
  cacheFindFirst.mockReset();
  cacheInsertValues.mockReset();
  cacheOnConflict.mockReset();
  cacheInsertValues.mockReturnValue({ onConflictDoUpdate: cacheOnConflict });
  mutateFn.mockReset();
  // Default mutate stub: just call the fn argument (third positional arg).
  mutateFn.mockImplementation(
    async (_ctx: unknown, _key: unknown, fn: () => Promise<unknown>) => fn(),
  );
  usersList.mockReset();
});

const FAKE_USER_ID = "00000000-0000-0000-0000-000000000001";
const FAKE_ORG_ID = "00000000-0000-0000-0000-000000000002";
const WORKSPACE_ID = "T0123456789";

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: FAKE_USER_ID,
    slackUserId: "U_ME",
    slackWorkspaceId: WORKSPACE_ID,
    scope: "chat:write,users:read",
    ciphertext: new Uint8Array(),
    iv: new Uint8Array(),
    wrappedDek: new Uint8Array(),
    revokedAt: null,
    ...overrides,
  };
}

function slackMember(
  id: string,
  displayName: string,
  realName: string = "",
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    deleted: false,
    is_bot: false,
    profile: { display_name: displayName, real_name: realName },
    ...extra,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// normalizeQuery
// ──────────────────────────────────────────────────────────────────────────

describe("normalizeQuery", () => {
  it("strips leading @, trims, lowercases", () => {
    expect(normalizeQuery("@Christine")).toBe("christine");
    expect(normalizeQuery("  @ChRiStInE  ")).toBe("christine");
    expect(normalizeQuery("christine")).toBe("christine");
  });

  it("handles empty / whitespace-only input", () => {
    expect(normalizeQuery("")).toBe("");
    expect(normalizeQuery("   ")).toBe("");
    expect(normalizeQuery("@")).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// matchUsers — exact wins over fuzzy
// ──────────────────────────────────────────────────────────────────────────

describe("matchUsers", () => {
  const directory = [
    { id: "U1", displayName: "christine", realName: "christine lee" },
    { id: "U2", displayName: "chris", realName: "chris jones" },
    { id: "U3", displayName: "alice", realName: "alice walker" },
  ];

  it("returns the single exact match when display_name matches", () => {
    expect(matchUsers(directory, "christine")).toEqual([
      { id: "U1", displayName: "christine" },
    ]);
  });

  it("returns the single exact match when real_name matches", () => {
    expect(matchUsers(directory, "alice walker")).toEqual([
      { id: "U3", displayName: "alice" },
    ]);
  });

  it("returns fuzzy substring matches when no exact match exists", () => {
    // "chris" is exact for U2's display_name → exact wins
    const result = matchUsers(directory, "chris");
    expect(result).toEqual([{ id: "U2", displayName: "chris" }]);
  });

  it("returns multiple fuzzy matches when no exact match exists", () => {
    // "chr" is a substring of both "christine" and "chris" — no exact match
    const result = matchUsers(directory, "chr");
    expect(result.map((m) => m.id).sort()).toEqual(["U1", "U2"]);
  });

  it("returns empty array when nothing matches", () => {
    expect(matchUsers(directory, "zzzzz")).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// resolveSlackUser — not-connected guards
// ──────────────────────────────────────────────────────────────────────────

describe("resolveSlackUser — not_connected", () => {
  it("throws not_connected when no token row exists", async () => {
    tokenFindFirst.mockResolvedValueOnce(undefined);
    await expect(resolveSlackUser(FAKE_USER_ID, FAKE_ORG_ID, "christine")).rejects.toMatchObject({
      code: "not_connected",
    });
    expect(usersList).not.toHaveBeenCalled();
  });

  it("throws not_connected when token row is revoked", async () => {
    tokenFindFirst.mockResolvedValueOnce(tokenRow({ revokedAt: new Date() }));
    await expect(resolveSlackUser(FAKE_USER_ID, FAKE_ORG_ID, "christine")).rejects.toMatchObject({
      code: "not_connected",
    });
  });

  it("throws not_found on empty query (after normalization)", async () => {
    tokenFindFirst.mockResolvedValueOnce(tokenRow());
    await expect(resolveSlackUser(FAKE_USER_ID, FAKE_ORG_ID, "@")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// resolveSlackUser — cache hit path
// ──────────────────────────────────────────────────────────────────────────

describe("resolveSlackUser — cache", () => {
  it("returns cached id without calling users.list when entry is fresh", async () => {
    tokenFindFirst.mockResolvedValueOnce(tokenRow());
    cacheFindFirst.mockResolvedValueOnce({
      slackWorkspaceId: WORKSPACE_ID,
      displayName: "christine",
      slackUserId: "U_CACHED",
      updatedAt: new Date(),
    });

    const result = await resolveSlackUser(FAKE_USER_ID, FAKE_ORG_ID, "@Christine");
    expect(result).toEqual({
      slackUserId: "U_CACHED",
      workspaceId: WORKSPACE_ID,
      source: "cache",
    });
    expect(usersList).not.toHaveBeenCalled();
    expect(cacheInsertValues).not.toHaveBeenCalled();
  });

  it("bypasses stale cache (>7d) and refreshes from API", async () => {
    tokenFindFirst.mockResolvedValueOnce(tokenRow());
    // The TTL filter is part of the WHERE clause — stale rows return as findFirst miss
    cacheFindFirst.mockResolvedValueOnce(undefined);
    usersList.mockResolvedValueOnce({
      ok: true,
      members: [slackMember("U_FRESH", "christine")],
    });

    const result = await resolveSlackUser(FAKE_USER_ID, FAKE_ORG_ID, "christine");
    expect(result).toEqual({
      slackUserId: "U_FRESH",
      workspaceId: WORKSPACE_ID,
      source: "api",
    });
    expect(usersList).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// resolveSlackUser — Slack directory lookup
// ──────────────────────────────────────────────────────────────────────────

describe("resolveSlackUser — Slack lookup", () => {
  it("fetches via users.list, caches the match, and returns the id", async () => {
    tokenFindFirst.mockResolvedValueOnce(tokenRow());
    cacheFindFirst.mockResolvedValueOnce(undefined);
    usersList.mockResolvedValueOnce({
      ok: true,
      members: [
        slackMember("U_OTHER", "alice"),
        slackMember("U_CHRIS", "christine", "Christine Lee"),
      ],
    });

    const result = await resolveSlackUser(FAKE_USER_ID, FAKE_ORG_ID, "@christine");
    expect(result.slackUserId).toBe("U_CHRIS");
    expect(result.source).toBe("api");

    // Cache was written via mutate({silent:true})
    expect(mutateFn).toHaveBeenCalledTimes(1);
    const [, key, , opts] = mutateFn.mock.calls[0];
    expect(key).toMatchObject({
      memexId: "",
      entity: "slack_user_cache",
      action: "created",
    });
    expect(opts).toEqual({ silent: true });

    // Upsert called with the normalised display name
    expect(cacheInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        slackWorkspaceId: WORKSPACE_ID,
        displayName: "christine",
        slackUserId: "U_CHRIS",
      }),
    );
  });

  it("skips deleted and bot accounts", async () => {
    tokenFindFirst.mockResolvedValueOnce(tokenRow());
    cacheFindFirst.mockResolvedValueOnce(undefined);
    usersList.mockResolvedValueOnce({
      ok: true,
      members: [
        slackMember("U_DEAD", "christine", "", { deleted: true }),
        slackMember("U_BOT", "christine", "", { is_bot: true }),
        slackMember("U_REAL", "christine"),
      ],
    });

    const result = await resolveSlackUser(FAKE_USER_ID, FAKE_ORG_ID, "christine");
    expect(result.slackUserId).toBe("U_REAL");
  });

  it("paginates users.list when next_cursor is returned", async () => {
    tokenFindFirst.mockResolvedValueOnce(tokenRow());
    cacheFindFirst.mockResolvedValueOnce(undefined);
    usersList.mockResolvedValueOnce({
      ok: true,
      members: [slackMember("U_PAGE1", "alice")],
      response_metadata: { next_cursor: "cursor-2" },
    });
    usersList.mockResolvedValueOnce({
      ok: true,
      members: [slackMember("U_PAGE2", "christine")],
      response_metadata: { next_cursor: "" }, // empty = last page
    });

    const result = await resolveSlackUser(FAKE_USER_ID, FAKE_ORG_ID, "christine");
    expect(result.slackUserId).toBe("U_PAGE2");
    expect(usersList).toHaveBeenCalledTimes(2);
    expect(usersList.mock.calls[1][0]).toMatchObject({ cursor: "cursor-2" });
  });

  it("throws not_found when no user matches", async () => {
    tokenFindFirst.mockResolvedValueOnce(tokenRow());
    cacheFindFirst.mockResolvedValueOnce(undefined);
    usersList.mockResolvedValueOnce({
      ok: true,
      members: [slackMember("U_ALICE", "alice")],
    });

    await expect(
      resolveSlackUser(FAKE_USER_ID, FAKE_ORG_ID, "christine"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(cacheInsertValues).not.toHaveBeenCalled();
  });

  it("throws ambiguous with candidate list when fuzzy match returns multiple", async () => {
    tokenFindFirst.mockResolvedValueOnce(tokenRow());
    cacheFindFirst.mockResolvedValueOnce(undefined);
    usersList.mockResolvedValueOnce({
      ok: true,
      members: [
        slackMember("U_C1", "chris.smith"),
        slackMember("U_C2", "chris.jones"),
        slackMember("U_C3", "alice"),
      ],
    });

    const err = await resolveSlackUser(FAKE_USER_ID, FAKE_ORG_ID, "chris").catch((e) => e);
    expect(err).toBeInstanceOf(SlackUserResolutionError);
    expect(err.code).toBe("ambiguous");
    expect(err.candidates).toHaveLength(2);
    expect(err.candidates.map((c: { id: string }) => c.id).sort()).toEqual([
      "U_C1",
      "U_C2",
    ]);
    expect(cacheInsertValues).not.toHaveBeenCalled();
  });

  it("throws when Slack users.list returns ok:false", async () => {
    tokenFindFirst.mockResolvedValueOnce(tokenRow());
    cacheFindFirst.mockResolvedValueOnce(undefined);
    usersList.mockResolvedValueOnce({ ok: false, error: "missing_scope" });

    await expect(
      resolveSlackUser(FAKE_USER_ID, FAKE_ORG_ID, "christine"),
    ).rejects.toThrow(/missing_scope/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// SlackUserResolutionError shape
// ──────────────────────────────────────────────────────────────────────────

describe("SlackUserResolutionError", () => {
  it("carries code and optional candidates", () => {
    const candidates = [{ id: "U1", displayName: "alice" }];
    const err = new SlackUserResolutionError("ambiguous", "msg", candidates);
    expect(err.code).toBe("ambiguous");
    expect(err.candidates).toBe(candidates);
    expect(err.name).toBe("SlackUserResolutionError");
  });
});
