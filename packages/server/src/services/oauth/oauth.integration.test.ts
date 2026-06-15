import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../../db/connection.js";
import {
  users,
  oauthClients,
  oauthAuthorizationCodes,
  oauthRefreshTokens,
} from "../../db/schema.js";
import { upsertUserByEmail } from "../users.js";
import {
  registerClient,
  getClientByClientId,
  verifyClientSecret,
  isPublicClient,
  revokeClient,
} from "./clients.js";
import { mintAuthCode, consumeAuthCode } from "./codes.js";
import {
  mintRefreshToken,
  rotateRefreshToken,
  revokeChain,
  revokeRefreshToken,
  RefreshTokenReuseError,
  __setRotateMintHook,
} from "./refresh-tokens.js";
import { createHash, randomBytes } from "node:crypto";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-253 dec-1 — DCR must accept RFC 8252 §7.1 private-use URI schemes
// (cursor://, vscode://, …) while still rejecting dangerous web schemes.
const AC_6 = "mindset-prod/memex-building-itself/specs/spec-253/acs/ac-6";
const AC_7 = "mindset-prod/memex-building-itself/specs/spec-253/acs/ac-7";
// spec-253 dec-3 — VS Code's https://vscode.dev/redirect relay registers unchanged.
const AC_10 = "mindset-prod/memex-building-itself/specs/spec-253/acs/ac-10";
// spec-253 dec-1/dec-4 — PKCE stays mandatory; DCR abuse controls hold for custom schemes.
const AC_8 = "mindset-prod/memex-building-itself/specs/spec-253/acs/ac-8";
const AC_11 = "mindset-prod/memex-building-itself/specs/spec-253/acs/ac-11";
// spec-253 scope ACs — the manager-level outcomes these mechanism tests collectively
// prove. A test may tag both its implementation AC and the scope AC it satisfies.
const AC_1 = "mindset-prod/memex-building-itself/specs/spec-253/acs/ac-1";
const AC_2 = "mindset-prod/memex-building-itself/specs/spec-253/acs/ac-2";
const AC_3 = "mindset-prod/memex-building-itself/specs/spec-253/acs/ac-3";
const AC_5 = "mindset-prod/memex-building-itself/specs/spec-253/acs/ac-5";

// PKCE helpers (RFC 7636 §4).
function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const userIds: string[] = [];
const clientRowIds: string[] = [];

afterAll(async () => {
  if (clientRowIds.length) {
    await db.delete(oauthClients).where(inArray(oauthClients.id, clientRowIds)).catch(() => {});
  }
  if (userIds.length) {
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {});
  }
});

async function makeTestUser(): Promise<string> {
  const user = await upsertUserByEmail(`oauth-test-${Date.now()}-${Math.random()}@test.dev`);
  userIds.push(user.id);
  return user.id;
}

async function registerAndTrack(input: Parameters<typeof registerClient>[0]) {
  const reg = await registerClient(input);
  const client = await getClientByClientId(reg.clientId);
  if (client) clientRowIds.push(client.id);
  return { reg, client: client! };
}

describe("OAuth integration: client registration (DCR)", () => {
  it("registers a confidential client and stores a hashed secret", async () => {
    tagAc(AC_2); // scope ac-2: https:// registration unchanged
    const { reg, client } = await registerAndTrack({
      clientName: "Test client",
      redirectUris: ["https://example.com/cb"],
    });
    expect(reg.clientId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(reg.clientSecret).toBeDefined();
    expect(reg.registrationAccessToken).toBeDefined();
    expect(client.clientSecretHash).not.toBe(reg.clientSecret); // hashed, not stored
    expect(verifyClientSecret(client, reg.clientSecret!)).toBe(true);
    expect(verifyClientSecret(client, "wrong-secret")).toBe(false);
    expect(isPublicClient(client)).toBe(false);
  });

  it("public clients omit the secret (PKCE-only)", async () => {
    const { reg, client } = await registerAndTrack({
      clientName: "Public client",
      redirectUris: ["http://localhost:54321/cb"],
      tokenEndpointAuthMethod: "none",
    });
    expect(reg.clientSecret).toBeUndefined();
    expect(client.clientSecretHash).toBeNull();
    expect(isPublicClient(client)).toBe(true);
    // verifyClientSecret on a public client always returns false — there's
    // nothing to compare against.
    expect(verifyClientSecret(client, "anything")).toBe(false);
  });

  it("rejects non-https redirect_uri except loopback", async () => {
    await expect(
      registerClient({
        clientName: "Bad",
        redirectUris: ["http://example.com/cb"],
      }),
    ).rejects.toThrow(/must be https/);
  });

  it("accepts http://localhost loopback (Claude Desktop pattern)", async () => {
    tagAc(AC_2); // scope ac-2: loopback registration unchanged
    await expect(
      registerAndTrack({
        clientName: "Loopback",
        redirectUris: ["http://localhost:8765/cb"],
        tokenEndpointAuthMethod: "none",
      }),
    ).resolves.toBeDefined();
  });

  it("rejects redirect_uri with a fragment", async () => {
    await expect(
      registerClient({
        clientName: "Bad",
        redirectUris: ["https://example.com/cb#frag"],
      }),
    ).rejects.toThrow(/fragment/);
  });

  it("revoked clients are not returned by getClientByClientId", async () => {
    const { reg, client } = await registerAndTrack({
      clientName: "Soon-revoked",
      redirectUris: ["https://example.com/cb"],
    });
    await revokeClient(client.id);
    expect(await getClientByClientId(reg.clientId)).toBeNull();
  });

  it("rejects more than 10 redirect_uris", async () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `https://example.com/cb${i}`);
    await expect(
      registerClient({
        clientName: "Too many redirects",
        redirectUris: tooMany,
      }),
    ).rejects.toThrow(/maximum of 10/);
  });

  // spec-253 dec-1 / dec-3: native IDEs (Cursor, VS Code, Windsurf, Zed)
  // register an RFC 8252 §7.1 private-use URI scheme as their OAuth callback.
  // DCR must accept these (and VS Code's https relay) while still rejecting
  // dangerous web schemes and malformed URIs.
  const ACCEPTED_REDIRECTS: Array<[string, string]> = [
    ["cursor (private-use scheme)", "cursor://anysphere.cursor-mcp/oauth/callback"],
    ["vscode (private-use scheme)", "vscode://anysphere.augment/auth/callback"],
    ["windsurf (private-use scheme)", "windsurf://codeium.windsurf/callback"],
    ["reverse-DNS scheme", "com.example.app:/oauth/cb"],
  ];
  for (const [label, uri] of ACCEPTED_REDIRECTS) {
    it(`ac-6: accepts ${label} at registration`, async () => {
      tagAc(AC_6);
      tagAc(AC_1); // scope ac-1: a native IDE's private-use scheme registers at DCR
      const { reg } = await registerAndTrack({
        clientName: `Native ${label}`,
        redirectUris: [uri],
        tokenEndpointAuthMethod: "none",
      });
      expect(reg.clientId).toBeTruthy();
    });
  }

  it("ac-10: accepts VS Code's https://vscode.dev/redirect relay unchanged", async () => {
    tagAc(AC_10);
    const { reg } = await registerAndTrack({
      clientName: "VS Code relay",
      redirectUris: ["https://vscode.dev/redirect"],
      tokenEndpointAuthMethod: "none",
    });
    expect(reg.clientId).toBeTruthy();
  });

  const REJECTED_REDIRECTS: Array<[string, string, RegExp]> = [
    ["javascript: scheme", "javascript:alert(1)", /private-use URI scheme/],
    ["data: scheme", "data:text/html,<b>x</b>", /private-use URI scheme/],
    ["file: scheme", "file:///etc/passwd", /private-use URI scheme/],
    ["vbscript: scheme", "vbscript:msgbox(1)", /private-use URI scheme/],
    ["ms-msdt: scheme (Follina handler)", "ms-msdt:/id PCWDiagnostic", /private-use URI scheme/],
    ["intent: scheme (Android)", "intent://evil/#Intent;scheme=x;end", /private-use URI scheme|fragment/],
    ["bare http to non-loopback host", "http://evil.example.com/cb", /must be https/],
    ["a non-absolute string", "/relative/callback", /absolute URI/],
  ];
  for (const [label, uri, matcher] of REJECTED_REDIRECTS) {
    it(`ac-7: rejects ${label}`, async () => {
      tagAc(AC_7);
      tagAc(AC_3); // scope ac-3: dangerous/malformed redirect URIs rejected with a clear error
      await expect(
        registerClient({ clientName: `Bad ${label}`, redirectUris: [uri] }),
      ).rejects.toThrow(matcher);
    });
  }

  it("ac-6: new URL() parses a private-use scheme without throwing (parse-behaviour lock)", () => {
    tagAc(AC_6);
    const parsed = new URL("cursor://anysphere.cursor-mcp/oauth/callback");
    expect(parsed.protocol).toBe("cursor:");
    expect(parsed.hash).toBe("");
  });

  it("ac-11: the 10-redirect_uri cap still applies to custom-scheme URIs", async () => {
    tagAc(AC_11);
    tagAc(AC_5); // scope ac-5: the 10-redirect_uri cap still holds
    const tooMany = Array.from({ length: 11 }, (_, i) => `cursor://anysphere.cursor-mcp/cb${i}`);
    await expect(
      registerClient({ clientName: "Too many custom schemes", redirectUris: tooMany }),
    ).rejects.toThrow(/maximum of 10/);
  });
});

// spec-253 ac-8: widening the redirect_uri validator must not weaken PKCE —
// S256 stays mandatory at both mint and consume, which is the control that
// makes custom-scheme redirects safe (RFC 8252 §8.6).
describe("OAuth integration: PKCE stays mandatory after custom-scheme widening (spec-253 ac-8)", () => {
  it("ac-8: mintAuthCode rejects a non-S256 (plain) code_challenge_method", async () => {
    tagAc(AC_8);
    tagAc(AC_5); // scope ac-5: PKCE S256 stays mandatory

    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "PKCE plain reject",
      redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
      tokenEndpointAuthMethod: "none",
    });
    await expect(
      mintAuthCode({
        clientId: client.id,
        userId,
        orgId: null,
        redirectUri: "cursor://anysphere.cursor-mcp/oauth/callback",
        codeChallenge: "abc",
        codeChallengeMethod: "plain",
        scopes: ["memex.full"],
      }),
    ).rejects.toThrow(/S256/);
  });

  it("ac-8: consumeAuthCode rejects a mismatched PKCE verifier (custom-scheme client)", async () => {
    tagAc(AC_8);
    tagAc(AC_5); // scope ac-5: PKCE S256 verification stays mandatory

    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "PKCE verify custom",
      redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
      tokenEndpointAuthMethod: "none",
    });
    const { challenge } = makePkce();
    const minted = await mintAuthCode({
      clientId: client.id,
      userId,
      orgId: null,
      redirectUri: "cursor://anysphere.cursor-mcp/oauth/callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scopes: ["memex.full"],
    });
    await expect(
      consumeAuthCode({
        code: minted.code,
        codeVerifier: randomBytes(32).toString("base64url"),
        expectedClientId: client.id,
        expectedRedirectUri: "cursor://anysphere.cursor-mcp/oauth/callback",
      }),
    ).rejects.toThrow(/PKCE verifier mismatch/);
  });
});

describe("OAuth integration: authorization codes + PKCE", () => {
  it("mint → consume round-trip with valid PKCE returns the user + scopes", async () => {
    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "Code test",
      redirectUris: ["https://example.com/cb"],
    });
    const { verifier, challenge } = makePkce();

    const minted = await mintAuthCode({
      clientId: client.id,
      userId,
      orgId: null,
      redirectUri: "https://example.com/cb",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scopes: ["memex.full"],
    });

    const consumed = await consumeAuthCode({
      code: minted.code,
      codeVerifier: verifier,
      expectedClientId: client.id,
      expectedRedirectUri: "https://example.com/cb",
    });

    expect(consumed.userId).toBe(userId);
    expect(consumed.scopes).toEqual(["memex.full"]);
  });

  it("PKCE verifier mismatch is rejected", async () => {
    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "PKCE mismatch",
      redirectUris: ["https://example.com/cb"],
    });
    const { challenge } = makePkce();
    const wrongVerifier = randomBytes(32).toString("base64url");

    const minted = await mintAuthCode({
      clientId: client.id,
      userId,
      orgId: null,
      redirectUri: "https://example.com/cb",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scopes: ["memex.full"],
    });

    await expect(
      consumeAuthCode({
        code: minted.code,
        codeVerifier: wrongVerifier,
        expectedClientId: client.id,
        expectedRedirectUri: "https://example.com/cb",
      }),
    ).rejects.toThrow(/PKCE verifier mismatch/);
  });

  it("redirect_uri mismatch is rejected", async () => {
    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "Redirect mismatch",
      redirectUris: ["https://example.com/cb"],
    });
    const { verifier, challenge } = makePkce();

    const minted = await mintAuthCode({
      clientId: client.id,
      userId,
      orgId: null,
      redirectUri: "https://example.com/cb",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scopes: ["memex.full"],
    });

    await expect(
      consumeAuthCode({
        code: minted.code,
        codeVerifier: verifier,
        expectedClientId: client.id,
        expectedRedirectUri: "https://attacker.example/cb",
      }),
    ).rejects.toThrow(/redirect_uri mismatch/);
  });

  it("code is single-use — second consume fails", async () => {
    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "Single use",
      redirectUris: ["https://example.com/cb"],
    });
    const { verifier, challenge } = makePkce();
    const minted = await mintAuthCode({
      clientId: client.id,
      userId,
      orgId: null,
      redirectUri: "https://example.com/cb",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scopes: ["memex.full"],
    });

    await consumeAuthCode({
      code: minted.code,
      codeVerifier: verifier,
      expectedClientId: client.id,
      expectedRedirectUri: "https://example.com/cb",
    });
    await expect(
      consumeAuthCode({
        code: minted.code,
        codeVerifier: verifier,
        expectedClientId: client.id,
        expectedRedirectUri: "https://example.com/cb",
      }),
    ).rejects.toThrow(/already used/);
  });

  it("rejects code_challenge_method=plain (OAuth 2.1 requires S256)", async () => {
    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "Plain check",
      redirectUris: ["https://example.com/cb"],
    });
    await expect(
      mintAuthCode({
        clientId: client.id,
        userId,
        orgId: null,
        redirectUri: "https://example.com/cb",
        codeChallenge: "x".repeat(43),
        codeChallengeMethod: "plain" as "S256", // bypass TS to test runtime guard
        scopes: ["memex.full"],
      }),
    ).rejects.toThrow(/S256/);
  });
});

describe("OAuth integration: refresh-token rotation + reuse detection", () => {
  it("mint → rotate preserves chain and user/scopes; old token becomes consumed", async () => {
    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "Rotation",
      redirectUris: ["https://example.com/cb"],
    });

    const first = await mintRefreshToken({
      clientId: client.id,
      userId,
      orgId: null,
      scopes: ["memex.full"],
    });

    const rotated = await rotateRefreshToken({
      refreshToken: first.refreshToken,
      expectedClientId: client.id,
    });

    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    expect(rotated.chainId).toBe(first.chainId);
    expect(rotated.userId).toBe(userId);
    expect(rotated.scopes).toEqual(["memex.full"]);
  });

  it("reuse of a consumed token → revokes chain + throws RefreshTokenReuseError", async () => {
    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "Reuse",
      redirectUris: ["https://example.com/cb"],
    });

    const first = await mintRefreshToken({
      clientId: client.id,
      userId,
      orgId: null,
      scopes: ["memex.full"],
    });
    const second = await rotateRefreshToken({
      refreshToken: first.refreshToken,
      expectedClientId: client.id,
    });

    // Replaying `first` should now trigger reuse detection.
    await expect(
      rotateRefreshToken({ refreshToken: first.refreshToken, expectedClientId: client.id }),
    ).rejects.toBeInstanceOf(RefreshTokenReuseError);

    // After reuse, every row in the chain must be revoked — including the
    // legitimately-rotated `second` token. That logs the user out across all
    // sessions in this chain, which is the intended behaviour.
    const chainRows = await db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.chainId, first.chainId));
    expect(chainRows.length).toBe(2);
    expect(chainRows.every((r) => r.revokedAt !== null)).toBe(true);

    // Even the freshly-rotated `second` token must now fail.
    await expect(
      rotateRefreshToken({ refreshToken: second.refreshToken, expectedClientId: client.id }),
    ).rejects.toThrow(/revoked/);
  });

  it("user has two independent chains — revoking one does NOT touch the other (dec-7c)", async () => {
    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "Two devices",
      redirectUris: ["https://example.com/cb"],
    });

    // Two independent /token exchanges (e.g. claude.ai + Claude Desktop).
    const chainA = await mintRefreshToken({ clientId: client.id, userId, orgId: null, scopes: ["memex.full"] });
    const chainB = await mintRefreshToken({ clientId: client.id, userId, orgId: null, scopes: ["memex.full"] });
    expect(chainA.chainId).not.toBe(chainB.chainId);

    // Compromise chain A by triggering reuse.
    const rotatedA = await rotateRefreshToken({
      refreshToken: chainA.refreshToken,
      expectedClientId: client.id,
    });
    await expect(
      rotateRefreshToken({ refreshToken: chainA.refreshToken, expectedClientId: client.id }),
    ).rejects.toBeInstanceOf(RefreshTokenReuseError);

    // Chain B must still rotate cleanly — user's other device unaffected.
    const rotatedB = await rotateRefreshToken({
      refreshToken: chainB.refreshToken,
      expectedClientId: client.id,
    });
    expect(rotatedB.chainId).toBe(chainB.chainId);
    // Silence unused-var lint for rotatedA.
    expect(rotatedA.chainId).toBe(chainA.chainId);
  });

  it("revokeRefreshToken targets only the presented token, not the chain", async () => {
    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "Per-token revoke",
      redirectUris: ["https://example.com/cb"],
    });
    const first = await mintRefreshToken({
      clientId: client.id,
      userId,
      orgId: null,
      scopes: ["memex.full"],
    });
    const second = await rotateRefreshToken({
      refreshToken: first.refreshToken,
      expectedClientId: client.id,
    });

    await revokeRefreshToken(second.refreshToken, client.id);

    // The second token is revoked but the chain isn't wholesale revoked —
    // the first is consumed (not "revoked"), so it stays in its prior state.
    const rows = await db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.chainId, first.chainId));
    const secondRow = rows.find((r) => r.id !== undefined && r.tokenHash !== undefined);
    expect(secondRow).toBeDefined();
    const revoked = rows.filter((r) => r.revokedAt !== null);
    expect(revoked.length).toBe(1); // only `second`
  });

  it("revokeChain idempotent — second call is a no-op", async () => {
    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "Idempotent revoke",
      redirectUris: ["https://example.com/cb"],
    });
    const first = await mintRefreshToken({
      clientId: client.id,
      userId,
      orgId: null,
      scopes: ["memex.full"],
    });
    await revokeChain(first.chainId);
    await revokeChain(first.chainId); // must not throw
    const rows = await db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.chainId, first.chainId));
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it("revokeRefreshToken scoped by client — other client's token cannot be revoked (RFC 7009 §2.1)", async () => {
    const userId = await makeTestUser();
    const { client: clientA } = await registerAndTrack({
      clientName: "Revoke-scope A",
      redirectUris: ["https://example.com/cb"],
    });
    const { client: clientB } = await registerAndTrack({
      clientName: "Revoke-scope B",
      redirectUris: ["https://example.com/cb"],
    });
    const issued = await mintRefreshToken({
      clientId: clientA.id,
      userId,
      orgId: null,
      scopes: ["memex.full"],
    });

    // Client B presents Client A's token — must silently no-op (no leak).
    await revokeRefreshToken(issued.refreshToken, clientB.id);
    const [stillAlive] = await db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.chainId, issued.chainId));
    expect(stillAlive.revokedAt).toBeNull();

    // Client A presents its own token — revokes.
    await revokeRefreshToken(issued.refreshToken, clientA.id);
    const [revoked] = await db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.chainId, issued.chainId));
    expect(revoked.revokedAt).not.toBeNull();
  });

  it("rotation rolls back on mid-tx crash — old token still usable (t-30)", async () => {
    const userId = await makeTestUser();
    const { client } = await registerAndTrack({
      clientName: "Rollback",
      redirectUris: ["https://example.com/cb"],
    });
    const first = await mintRefreshToken({
      clientId: client.id,
      userId,
      orgId: null,
      scopes: ["memex.full"],
    });

    // Fault-inject between consume and mint. Throwing inside the tx rolls
    // back the consume, so `first` should remain unconsumed and reusable.
    __setRotateMintHook(async () => {
      throw new Error("simulated mid-tx crash");
    });
    try {
      await expect(
        rotateRefreshToken({ refreshToken: first.refreshToken, expectedClientId: client.id }),
      ).rejects.toThrow(/simulated mid-tx crash/);
    } finally {
      __setRotateMintHook(undefined);
    }

    // The consume must have rolled back: only the original row exists (no
    // orphaned successor) and it is NOT marked consumed.
    const rows = await db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.chainId, first.chainId));
    expect(rows.length).toBe(1);
    expect(rows[0].consumedAt).toBeNull();
    expect(rows[0].revokedAt).toBeNull();

    // And the old token is usable for a retry — proves end-to-end recovery.
    const rotated = await rotateRefreshToken({
      refreshToken: first.refreshToken,
      expectedClientId: client.id,
    });
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    expect(rotated.chainId).toBe(first.chainId);
  });
});
