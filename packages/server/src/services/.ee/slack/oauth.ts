// Slack OAuth v2 flow + token storage (doc-23 T-4).
//
// Three concerns live here:
//   1. CSRF state-token signing/verification — short-lived HMAC over userId
//   2. OAuth code exchange (oauth.v2.access) and token revocation (auth.revoke)
//   3. Persistence into user_slack_tokens via mutate(), envelope-encrypted via crypto.ts
//
// Env vars required for the OAuth flow to function in production:
//   SLACK_CLIENT_ID            Slack app's public client ID (sent in auth URL)
//   SLACK_CLIENT_SECRET        Slack app's secret (used in code exchange)
//   SLACK_OAUTH_REDIRECT_URI   Absolute callback URL Slack redirects back to
//
// Routes read these from process.env and 503 if missing, so the module loads cleanly
// even in environments that haven't configured Slack.

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import { db } from "../../../db/connection.js";
import { userSlackTokens } from "../../../db/schema.js";
import { encryptToken, decryptToken } from "./crypto.js";
import { mutate } from "../../mutate.js";
import { getSecret as getStateSecret } from "../../auth-jwt.js";

const STATE_TOKEN_TTL_SEC = 10 * 60; // 10 minutes

// The CSRF state token is signed with the shared AUTH_JWT_SECRET via the single
// resolver in auth-jwt.ts (throws in production if unset; one gated dev fallback).

// ──────────────────────────────────────────────────────────────────────────
// State token — HMAC over `<userId>|<orgId>|<expiresAt>` so the callback can
// verify the request originated from a /start invocation tied to this user+org.
// Format: <base64url(userId)>.<base64url(orgId)>.<expiresAt>.<base64url(hmac)>
// ──────────────────────────────────────────────────────────────────────────

// Personal connections are represented as orgId=null. The state token encodes
// null as the literal sentinel "personal" so the 4-part token format is stable.
const PERSONAL_SENTINEL = "personal";

export function makeStateToken(userId: string, orgId: string | null): string {
  const orgPart = orgId ?? PERSONAL_SENTINEL;
  const expiresAt = Math.floor(Date.now() / 1000) + STATE_TOKEN_TTL_SEC;
  const payload = `${userId}|${orgPart}|${expiresAt}`;
  const sig = createHmac("sha256", getStateSecret()).update(payload).digest("base64url");
  const userPartB64 = Buffer.from(userId).toString("base64url");
  const orgPartB64 = Buffer.from(orgPart).toString("base64url");
  return `${userPartB64}.${orgPartB64}.${expiresAt}.${sig}`;
}

export function verifyStateToken(token: string): { userId: string; orgId: string | null } | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userPartB64, orgPartB64, expiresAtRaw, sig] = parts;

  const expiresAt = parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAt)) return null;
  if (expiresAt < Math.floor(Date.now() / 1000)) return null;

  let userId: string;
  let orgRaw: string;
  try {
    userId = Buffer.from(userPartB64, "base64url").toString("utf8");
    orgRaw = Buffer.from(orgPartB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!userId || !orgRaw) return null;

  const payload = `${userId}|${orgRaw}|${expiresAt}`;
  const expected = createHmac("sha256", getStateSecret()).update(payload).digest("base64url");

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  return { userId, orgId: orgRaw === PERSONAL_SENTINEL ? null : orgRaw };
}

// ──────────────────────────────────────────────────────────────────────────
// OAuth code exchange + token revoke
// ──────────────────────────────────────────────────────────────────────────

export interface SlackOAuthResult {
  accessToken: string; // xoxp- user token
  slackUserId: string;
  slackWorkspaceId: string;
  scope: string;
  botUserId?: string; // present when the app has bot scopes installed
}

export class SlackOAuthError extends Error {
  constructor(public readonly code: string, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "SlackOAuthError";
  }
}

export async function exchangeOAuthCode(code: string): Promise<SlackOAuthResult> {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new SlackOAuthError("not_configured", "Slack OAuth env vars are missing");
  }

  // oauth.v2.access is the bootstrap endpoint — pass client_id/secret in the body,
  // no auth header. The SDK accepts a tokenless WebClient for this exact case.
  const client = new WebClient();
  const response = await client.oauth.v2.access({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  if (!response.ok) {
    throw new SlackOAuthError(
      response.error ?? "exchange_failed",
      `oauth.v2.access returned ok=false: ${response.error ?? "unknown"}`,
      response,
    );
  }

  const accessToken = response.authed_user?.access_token;
  const slackUserId = response.authed_user?.id;
  const teamId = response.team?.id;
  if (!accessToken) {
    throw new SlackOAuthError(
      response.error ?? "exchange_failed",
      "oauth.v2.access did not return a user access token",
      response,
    );
  }
  if (!slackUserId || !teamId) {
    throw new SlackOAuthError(
      "incomplete_response",
      "oauth.v2.access response missing authed_user.id or team.id",
      response,
    );
  }

  return {
    accessToken,
    slackUserId,
    slackWorkspaceId: teamId,
    scope: response.authed_user?.scope ?? "",
    botUserId: response.bot_user_id ?? undefined,
  };
}

/**
 * Best-effort token revocation against Slack. Failures are swallowed because the
 * caller still needs to mark the row revoked locally regardless of Slack-side state.
 */
export async function revokeOnSlack(accessToken: string): Promise<boolean> {
  try {
    const client = new WebClient(accessToken);
    const response = await client.auth.revoke();
    return response.ok === true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// user_slack_tokens persistence — all writes through mutate() per std-8
// ──────────────────────────────────────────────────────────────────────────

export interface StoreTokenParams {
  userId: string;
  orgId: string | null;
  slackUserId: string;
  slackWorkspaceId: string;
  accessToken: string;
  scope: string;
  botUserId?: string;
}

/**
 * Insert a new user_slack_tokens row, or overwrite an existing one (reconnect).
 * Resets `revoked_at` to NULL on reconnect. Keyed on (user_id, org_id).
 */
export async function storeUserSlackToken(params: StoreTokenParams): Promise<void> {
  const encrypted = await encryptToken(params.accessToken);
  // Drizzle's customType maps Uint8Array → Buffer for the driver; the schema layer
  // handles it. We can pass Uint8Array values directly.
  await mutate(
    {},
    { memexId: "", userId: params.userId, entity: "user_slack_token", action: "created" },
    async () => {
      await db
        .insert(userSlackTokens)
        .values({
          userId: params.userId,
          orgId: params.orgId,
          slackUserId: params.slackUserId,
          slackWorkspaceId: params.slackWorkspaceId,
          slackBotUserId: params.botUserId ?? null,
          scope: params.scope,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          wrappedDek: encrypted.wrappedDek,
        })
        .onConflictDoUpdate({
          target: [userSlackTokens.userId, userSlackTokens.orgId],
          set: {
            slackUserId: params.slackUserId,
            slackWorkspaceId: params.slackWorkspaceId,
            slackBotUserId: params.botUserId ?? null,
            scope: params.scope,
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            wrappedDek: encrypted.wrappedDek,
            updatedAt: sql`now()`,
            revokedAt: null, // explicit reset on reconnect
          },
        });
    },
  );
}

/**
 * Look up the user's Slack token for a specific org (decrypted).
 * Returns null if no row exists or the row is already revoked.
 */
export async function getUserSlackAccessToken(userId: string, orgId: string | null): Promise<string | null> {
  const orgWhere = orgId ? eq(userSlackTokens.orgId, orgId) : isNull(userSlackTokens.orgId);
  const row = await db.query.userSlackTokens.findFirst({
    where: and(eq(userSlackTokens.userId, userId), orgWhere),
  });
  if (!row || row.revokedAt) return null;
  return decryptToken({
    ciphertext: row.ciphertext,
    iv: row.iv,
    wrappedDek: row.wrappedDek,
  });
}

export interface SlackConnectionStatus {
  connected: boolean;
  workspaceName?: string;
  displayName?: string;
  slackWorkspaceId?: string;
}

export async function getSlackConnectionStatus(userId: string, orgId: string | null): Promise<SlackConnectionStatus> {
  const accessToken = await getUserSlackAccessToken(userId, orgId);
  if (!accessToken) return { connected: false };

  try {
    const client = new WebClient(accessToken);
    const result = await client.auth.test();
    return {
      connected: true,
      workspaceName: result.team as string | undefined,
      displayName: result.user as string | undefined,
      slackWorkspaceId: result.team_id as string | undefined,
    };
  } catch {
    await markUserSlackTokenRevoked(userId, orgId);
    return { connected: false };
  }
}

export async function getSlackBotUserId(userId: string, orgId: string | null): Promise<string | null> {
  const orgWhere = orgId ? eq(userSlackTokens.orgId, orgId) : isNull(userSlackTokens.orgId);
  const row = await db.query.userSlackTokens.findFirst({
    where: and(eq(userSlackTokens.userId, userId), orgWhere),
    columns: { slackBotUserId: true, revokedAt: true },
  });
  if (!row || row.revokedAt) return null;
  return row.slackBotUserId ?? null;
}

export async function markUserSlackTokenRevoked(userId: string, orgId: string | null): Promise<void> {
  const orgWhere = orgId ? eq(userSlackTokens.orgId, orgId) : isNull(userSlackTokens.orgId);
  await mutate(
    {},
    { memexId: "", userId, entity: "user_slack_token", action: "deleted" },
    async () => {
      await db
        .update(userSlackTokens)
        .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(userSlackTokens.userId, userId), orgWhere));
    },
  );
}

/**
 * Returns true if the user has OTHER active (non-revoked) tokens connected to the
 * same Slack workspace as the token being disconnected. Used to guard revokeOnSlack:
 * Slack's auth.revoke kills ALL tokens for the same user+app+workspace, so we must
 * skip the Slack-side revoke when other connections would be collateral damage.
 */
export async function hasOtherActiveTokensForWorkspace(
  userId: string,
  orgId: string | null,
  workspaceId: string,
): Promise<boolean> {
  // Exclude the row currently being disconnected.
  const excludeSelf = orgId ? ne(userSlackTokens.orgId, orgId) : isNotNull(userSlackTokens.orgId);
  const row = await db.query.userSlackTokens.findFirst({
    where: and(
      eq(userSlackTokens.userId, userId),
      eq(userSlackTokens.slackWorkspaceId, workspaceId),
      excludeSelf,
      isNull(userSlackTokens.revokedAt),
    ),
    columns: { userId: true },
  });
  return row !== undefined;
}
