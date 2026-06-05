// b-31 t-25 / t-26 — OAuth /token error-shape regression.
//
// Asserts that the token endpoint does NOT leak information through differing
// error responses for adjacent failure modes:
//
//   t-25 (client auth): an unknown client_id and a known client_id with a
//   bogus client_secret must produce BYTE-IDENTICAL responses. Otherwise an
//   attacker can probe for valid client_ids.
//
//   t-26 (refresh-token state): an unknown refresh token and an expired
//   refresh token must produce BYTE-IDENTICAL responses. Otherwise an
//   attacker can distinguish "never existed" from "expired" / "revoked" /
//   "client mismatch" and infer state.
//
// Requires OAUTH_ENABLED=1 (set in beforeAll) and DATABASE_URL pointed at a
// Postgres with the 0045_add_oauth migration applied.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  users,
  oauthClients,
  oauthRefreshTokens,
} from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { registerClient } from "../services/oauth/clients.js";
import { mintRefreshToken } from "../services/oauth/refresh-tokens.js";

const originalFlag = process.env.OAUTH_ENABLED;

beforeAll(() => {
  process.env.OAUTH_ENABLED = "1";
});

afterAll(() => {
  if (originalFlag === undefined) delete process.env.OAUTH_ENABLED;
  else process.env.OAUTH_ENABLED = originalFlag;
});

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

// Compare full HTTP response shape — status, headers we care about, body bytes.
// We don't fold in Date / Set-Cookie noise; just the bits a probing attacker
// could distinguish.
async function snapshot(res: Response): Promise<{ status: number; body: string }> {
  return { status: res.status, body: await res.text() };
}

describe("security: OAuth /token error shapes", () => {
  it("t-25: unknown client_id and bad client_secret return byte-identical responses", async () => {
    const { app } = await import("../app.js");

    // Register a real client so we have a known client_id for case (b).
    const reg = await registerClient({
      clientName: "oauth-error-shapes t-25",
      redirectUris: ["https://test.example/cb"],
    });
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, reg.clientId));
    clientRowIds.push(client.id);

    // (a) unknown client_id — invent one that doesn't exist.
    const resUnknown = await app.fetch(
      new Request("https://memex.ai/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: "doesnt-matter",
          code_verifier: "doesnt-matter",
          redirect_uri: "https://test.example/cb",
          client_id: "totally-unknown-client-id-xxxxx",
          client_secret: "any-bogus-secret",
        }),
      }),
    );

    // (b) known client_id with bogus secret.
    const resBadSecret = await app.fetch(
      new Request("https://memex.ai/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: "doesnt-matter",
          code_verifier: "doesnt-matter",
          redirect_uri: "https://test.example/cb",
          client_id: reg.clientId,
          client_secret: "not-the-real-secret",
        }),
      }),
    );

    const a = await snapshot(resUnknown);
    const b = await snapshot(resBadSecret);

    // Status MUST match exactly. RFC 6749 §5.2 → 401 for invalid_client.
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.status).toBe(b.status);

    // Body MUST be byte-identical — no leaked discriminator.
    expect(a.body).toBe(b.body);

    // Sanity: the body shape is what we expect (generic).
    const parsed = JSON.parse(a.body);
    expect(parsed.error).toBe("invalid_client");
    expect(parsed.error_description).toBe("client authentication failed");
  });

  it("t-26: unknown refresh token and expired refresh token return byte-identical responses", async () => {
    const { app } = await import("../app.js");

    // Need a real (confidential) client + user to mint a real refresh token
    // for case (b). Then we expire it via a direct UPDATE.
    const reg = await registerClient({
      clientName: "oauth-error-shapes t-26",
      redirectUris: ["https://test.example/cb"],
    });
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, reg.clientId));
    clientRowIds.push(client.id);

    const user = await upsertUserByEmail(`oauth-error-shapes-${Date.now()}@test.dev`);
    userIds.push(user.id);

    const minted = await mintRefreshToken({
      clientId: client.id,
      userId: user.id,
      orgId: null,
      scopes: ["memex.full"],
    });

    // Force-expire the row by setting expires_at to the past. Direct UPDATE —
    // the service doesn't expose a way to backdate.
    await db
      .update(oauthRefreshTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(oauthRefreshTokens.chainId, minted.chainId));

    // (a) totally-unknown refresh token.
    const resUnknown = await app.fetch(
      new Request("https://memex.ai/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "this-token-does-not-exist-anywhere",
          client_id: reg.clientId,
          client_secret: reg.clientSecret,
        }),
      }),
    );

    // (b) real token, but expired.
    const resExpired = await app.fetch(
      new Request("https://memex.ai/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: minted.refreshToken,
          client_id: reg.clientId,
          client_secret: reg.clientSecret,
        }),
      }),
    );

    const a = await snapshot(resUnknown);
    const b = await snapshot(resExpired);

    // Both should be 400 invalid_grant per the route's ValidationError branch.
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(a.status).toBe(b.status);

    // Body MUST be byte-identical — no leaked discriminator between
    // "not found" and "expired".
    expect(a.body).toBe(b.body);

    const parsed = JSON.parse(a.body);
    expect(parsed.error).toBe("invalid_grant");
    expect(parsed.error_description).toBe("invalid_grant: refresh token rejected");
  });
});
