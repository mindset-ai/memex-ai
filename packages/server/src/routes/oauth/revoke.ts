// POST /api/oauth/revoke — RFC 7009 token revocation.
//
// Accepts a refresh token (we don't track access tokens — they're stateless
// JWTs and expire in 1h on their own). Client-authenticated, per-token (not
// per-chain) per dec-7(c) — user-initiated revoke kills one device session,
// not all of the user's chains.

import { Hono } from "hono";
import {
  getClientByClientId,
  verifyClientSecret,
  isPublicClient,
} from "../../services/oauth/clients.js";
import { revokeRefreshToken } from "../../services/oauth/refresh-tokens.js";

export const revoke = new Hono();

revoke.post("/", async (c) => {
  // Body is form-encoded per RFC 7009 §2.1, but accept JSON too for parity
  // with /token.
  const contentType = c.req.header("Content-Type") ?? "";
  let body: Record<string, string> = {};
  if (contentType.startsWith("application/json")) {
    const parsed = await c.req.json().catch(() => null);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, string>;
  } else {
    const text = await c.req.text();
    body = Object.fromEntries(new URLSearchParams(text).entries());
  }

  // Authenticate client (mirrors /token shape).
  const auth = c.req.header("Authorization");
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const [id, secret] = decoded.split(":");
      clientId = id;
      clientSecret = secret;
    } catch {
      // fall through to body params
    }
  }
  if (!clientId && typeof body.client_id === "string") {
    clientId = body.client_id;
    clientSecret = typeof body.client_secret === "string" ? body.client_secret : undefined;
  }
  if (!clientId) {
    return c.json({ error: "invalid_client", error_description: "client_id missing" }, 401);
  }

  const client = await getClientByClientId(clientId);
  if (!client) {
    // RFC 7009 §2.2 — server MAY respond 200 even when the request is
    // invalid, to avoid leaking which tokens exist. But unauthenticated
    // attempts ARE rejected with 401.
    return c.json({ error: "invalid_client" }, 401);
  }
  if (!isPublicClient(client)) {
    if (!clientSecret || !verifyClientSecret(client, clientSecret)) {
      return c.json({ error: "invalid_client" }, 401);
    }
  }

  const tokenStr = body.token;
  const tokenTypeHint = body.token_type_hint;
  if (!tokenStr || typeof tokenStr !== "string") {
    return c.json({ error: "invalid_request", error_description: "token is required" }, 400);
  }
  // We only persist refresh tokens; access tokens are stateless JWTs that
  // expire on their own. RFC 7009 §2.1 says treat unknown token types as
  // a no-op success.
  if (tokenTypeHint && tokenTypeHint !== "refresh_token" && tokenTypeHint !== "access_token") {
    return c.json({}, 200);
  }

  await revokeRefreshToken(tokenStr, client.id);
  // RFC 7009 §2.2 — always return 200 on a well-formed call. Don't leak
  // whether the token existed.
  return c.body(null, 200);
});
