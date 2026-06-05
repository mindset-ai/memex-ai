// Slack OAuth routes (doc-23 T-4).
//
//   GET    /api/auth/slack/start     → 302 to slack.com/oauth/v2/authorize
//   GET    /api/auth/slack/callback  → exchange code, encrypt + upsert row, redirect to /settings/integrations
//   DELETE /api/auth/slack           → call Slack auth.revoke, mark row revoked
//
// Auth notes:
// - /start accepts ?token=<jwt> for browser navigation (no header support on <a href> links)
// - /callback is sessionless: user identity comes from the CSRF state token (verifyStateToken)

import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { sessionMiddleware, type SessionEnv } from "../../../middleware/session.js";
import type { MemexResolverEnv } from "../../../middleware/memex-resolver.js";
import { buildAppBaseUrl } from "../../../services/shared/tenant-url.js";
import { verifySessionToken, InvalidTokenError } from "../../../services/auth-jwt.js";
import { getUserById } from "../../../services/users.js";
import { db } from "../../../db/connection.js";
import { orgMemberships, orgs, userSlackTokens } from "../../../db/schema.js";
import {
  makeStateToken,
  verifyStateToken,
  exchangeOAuthCode,
  storeUserSlackToken,
  getUserSlackAccessToken,
  getSlackConnectionStatus,
  markUserSlackTokenRevoked,
  hasOtherActiveTokensForWorkspace,
  revokeOnSlack,
  SlackOAuthError,
} from "../../../services/.ee/slack/oauth.js";

const SLACK_USER_SCOPES = "chat:write,users:read,channels:read";
const SLACK_BOT_SCOPES = "chat:write"; // minimal bot scope — creates a bot user so bot_user_id is returned

export const slack = new Hono<MemexResolverEnv & SessionEnv>();

// ──────────────────────────────────────────────────────────────────────────
// GET /api/auth/slack
// Returns one Slack connection status entry per org the session user belongs
// to. auth.test is called in parallel for orgs that have a token. Auto-revokes
// if Slack reports the token as invalid.
// ──────────────────────────────────────────────────────────────────────────

slack.get("/", sessionMiddleware, async (c) => {
  const user = c.get("user");
  const memberships = await db
    .select({ orgId: orgMemberships.orgId, orgName: orgs.name })
    .from(orgMemberships)
    .innerJoin(orgs, eq(orgMemberships.orgId, orgs.id))
    .where(and(eq(orgMemberships.userId, user.id), eq(orgMemberships.status, "active")));

  const [personalStatus, ...orgStatuses] = await Promise.all([
    getSlackConnectionStatus(user.id, null).then((s) => ({ orgId: null, orgName: "Personal", personal: true, ...s })),
    ...memberships.map(async ({ orgId, orgName }) => {
      const status = await getSlackConnectionStatus(user.id, orgId);
      return { orgId, orgName, personal: false, ...status };
    }),
  ]);
  return c.json([personalStatus, ...orgStatuses]);
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/auth/slack/start
// 302 to Slack's authorize page with a CSRF-bound state token.
// ──────────────────────────────────────────────────────────────────────────

slack.get("/start", async (c) => {
  const clientId = process.env.SLACK_CLIENT_ID;
  const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return c.json(
      {
        error: "not_configured",
        message:
          "Slack OAuth env vars are missing on the server (SLACK_CLIENT_ID, SLACK_OAUTH_REDIRECT_URI).",
      },
      503,
    );
  }

  // Accept token from ?token= query param — browser <a href> navigation cannot
  // set Authorization headers, so the client appends the JWT as a query param.
  const rawToken =
    c.req.query("token") ?? c.req.header("Authorization")?.slice(7);
  if (!rawToken) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }
  let user;
  try {
    const claims = verifySessionToken(rawToken);
    user = await getUserById(claims.sub);
    if (!user) return c.json({ error: "User not found" }, 401);
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    throw err;
  }

  const orgIdParam = c.req.query("org_id");
  // org_id absent or "personal" → personal connection; otherwise verify membership.
  let orgId: string | null = null;
  if (orgIdParam && orgIdParam !== "personal") {
    const membership = await db.query.orgMemberships.findFirst({
      where: and(eq(orgMemberships.userId, user.id), eq(orgMemberships.orgId, orgIdParam), eq(orgMemberships.status, "active")),
      columns: { id: true },
    });
    if (!membership) return c.json({ error: "not_org_member" }, 403);
    orgId = orgIdParam;
  }

  const state = makeStateToken(user.id, orgId);

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES);       // bot scopes → Slack returns bot_user_id
  url.searchParams.set("user_scope", SLACK_USER_SCOPES); // user scopes → xoxp- token for sending as user
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  return c.redirect(url.toString(), 302);
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/auth/slack/callback?code=...&state=...
// Slack redirects here after user approves. Exchange the code, persist the token,
// redirect to /settings/integrations.
// ──────────────────────────────────────────────────────────────────────────

slack.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return c.json({ error: "missing_code_or_state" }, 400);
  }

  // Callback arrives as a browser redirect from Slack — no Authorization header.
  // The CSRF state token encodes userId + orgId; resolve both from it directly.
  const verified = verifyStateToken(state);
  if (!verified) {
    return c.json({ error: "invalid_state" }, 400);
  }
  const { userId: verifiedUserId, orgId } = verified; // orgId is null for personal connections
  const user = await getUserById(verifiedUserId);
  if (!user) {
    return c.json({ error: "user_not_found" }, 400);
  }

  try {
    const oauthResult = await exchangeOAuthCode(code);
    await storeUserSlackToken({
      userId: user.id,
      orgId,
      slackUserId: oauthResult.slackUserId,
      slackWorkspaceId: oauthResult.slackWorkspaceId,
      accessToken: oauthResult.accessToken,
      scope: oauthResult.scope,
      botUserId: oauthResult.botUserId,
    });
    // Absolute redirect via `buildAppBaseUrl()` (reads APP_BASE_URL per std-2).
    // The previous `MEMEX_UI_BASE_URL` env var is unset on Cloud Run — it
    // silently fell back to `http://localhost:5173`, which is wrong in every
    // deployed env.
    const uiBase = buildAppBaseUrl();
    return c.redirect(`${uiBase}/settings/integrations?slack=connected`, 302);
  } catch (err) {
    const uiBase = buildAppBaseUrl();
    if (err instanceof SlackOAuthError) {
      return c.redirect(`${uiBase}/settings/integrations?slack=error&reason=${encodeURIComponent(err.code)}`, 302);
    }
    console.error("[slack/callback] unexpected error during OAuth exchange:", err);
    return c.redirect(`${uiBase}/settings/integrations?slack=error&reason=unknown`, 302);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// DELETE /api/auth/slack
// Revoke on Slack-side (best-effort), then mark the local row revoked unconditionally.
// ──────────────────────────────────────────────────────────────────────────

slack.delete("/", sessionMiddleware, async (c) => {
  const user = c.get("user");
  // org_id absent or "personal" → disconnect personal connection.
  const orgIdParam = c.req.query("org_id");
  const orgId: string | null = (orgIdParam && orgIdParam !== "personal") ? orgIdParam : null;

  const tokenRow = await db.query.userSlackTokens.findFirst({
    where: and(
      eq(userSlackTokens.userId, user.id),
      orgId ? eq(userSlackTokens.orgId, orgId) : isNull(userSlackTokens.orgId),
      isNull(userSlackTokens.revokedAt),
    ),
    columns: { slackWorkspaceId: true, ciphertext: true, iv: true, wrappedDek: true },
  });

  if (tokenRow) {
    // Slack's auth.revoke kills ALL tokens for the same user+app+workspace. Only revoke
    // on Slack's side if no other connections share this workspace — otherwise we'd
    // silently disconnect the user's other orgs too.
    const shared = await hasOtherActiveTokensForWorkspace(user.id, orgId, tokenRow.slackWorkspaceId);
    if (!shared) {
      const accessToken = await getUserSlackAccessToken(user.id, orgId);
      if (accessToken) await revokeOnSlack(accessToken);
    }
  }

  await markUserSlackTokenRevoked(user.id, orgId);
  return c.json({ revoked: true });
});
