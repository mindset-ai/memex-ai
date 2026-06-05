// POST /api/oauth/token — the OAuth 2.1 token endpoint.
//
// Supports two grant types:
//   - authorization_code: exchanges a PKCE-verified code for an access+refresh
//     pair. First leg of the flow.
//   - refresh_token: rotates a refresh token, returns a fresh access+refresh
//     pair. Single-use; reuse detection per dec-7(c).

import { Hono } from "hono";
import {
  getClientByClientId,
  verifyClientSecret,
  isPublicClient,
} from "../../services/oauth/clients.js";
import { consumeAuthCode } from "../../services/oauth/codes.js";
import {
  mintRefreshToken,
  rotateRefreshToken,
  RefreshTokenReuseError,
} from "../../services/oauth/refresh-tokens.js";
import { signAccessToken } from "../../services/oauth/access-tokens.js";
import { ValidationError } from "../../types/errors.js";

export const token = new Hono();

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

// RFC 6749 §3.2 — the token endpoint accepts both form-encoded and JSON
// bodies in practice. MCP clients use JSON.
async function readBody(c: import("hono").Context): Promise<Record<string, string> | null> {
  const contentType = c.req.header("Content-Type") ?? "";
  if (contentType.startsWith("application/json")) {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return null;
    return body as Record<string, string>;
  }
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const text = await c.req.text();
    const params = new URLSearchParams(text);
    return Object.fromEntries(params.entries());
  }
  return null;
}

// RFC 6749 §2.3.1 — clients MAY authenticate via Authorization: Basic
// <base64(client_id:client_secret)> OR via body params. Returns the
// presented (client_id, client_secret) pair, or just client_id for public
// clients.
function readClientCreds(
  c: import("hono").Context,
  body: Record<string, string>,
): { clientId: string; clientSecret?: string } | null {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const [id, secret] = decoded.split(":");
      if (id) return { clientId: id, clientSecret: secret };
    } catch {
      // fall through to body-param path
    }
  }
  if (typeof body.client_id === "string") {
    return {
      clientId: body.client_id,
      clientSecret: typeof body.client_secret === "string" ? body.client_secret : undefined,
    };
  }
  return null;
}

token.post("/", async (c) => {
  const body = await readBody(c);
  if (!body) {
    return c.json({ error: "invalid_request", error_description: "body must be JSON or form" }, 400);
  }

  const creds = readClientCreds(c, body);
  if (!creds) {
    return c.json({ error: "invalid_client", error_description: "client_id missing" }, 401);
  }

  const client = await getClientByClientId(creds.clientId);
  if (!client) {
    // Generic response to prevent client_id enumeration. RFC 6749 §5.2 allows
    // collapsing all client-auth failures into a single shape.
    return c.json(
      { error: "invalid_client", error_description: "client authentication failed" },
      401,
    );
  }

  // Confidential clients MUST present client_secret; public clients (PKCE-only)
  // skip it entirely.
  if (!isPublicClient(client)) {
    if (!creds.clientSecret || !verifyClientSecret(client, creds.clientSecret)) {
      // Byte-identical to the unknown-client_id response above — prevents an
      // attacker from probing for valid client_ids by sending bogus secrets.
      return c.json(
        { error: "invalid_client", error_description: "client authentication failed" },
        401,
      );
    }
  }

  const grantType = body.grant_type;
  if (grantType === "authorization_code") {
    return handleAuthorizationCode(c, body, client.id);
  }
  if (grantType === "refresh_token") {
    return handleRefreshToken(c, body, client.id);
  }
  return c.json(
    {
      error: "unsupported_grant_type",
      error_description: "grant_type must be 'authorization_code' or 'refresh_token'",
    },
    400,
  );
});

async function handleAuthorizationCode(
  c: import("hono").Context,
  body: Record<string, string>,
  clientRowId: string,
) {
  const code = body.code;
  const codeVerifier = body.code_verifier;
  const redirectUri = body.redirect_uri;
  if (!code || !codeVerifier || !redirectUri) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "code, code_verifier, redirect_uri are required",
      },
      400,
    );
  }

  try {
    const consumed = await consumeAuthCode({
      code,
      codeVerifier,
      expectedClientId: clientRowId,
      expectedRedirectUri: redirectUri,
    });

    const accessToken = signAccessToken({
      userId: consumed.userId,
      orgId: consumed.orgId,
      clientId: clientRowId,
      scopes: consumed.scopes,
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    });
    const refresh = await mintRefreshToken({
      clientId: clientRowId,
      userId: consumed.userId,
      orgId: consumed.orgId,
      scopes: consumed.scopes,
    });

    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refresh.refreshToken,
      scope: consumed.scopes.join(" "),
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_grant", error_description: err.message }, 400);
    }
    throw err;
  }
}

async function handleRefreshToken(
  c: import("hono").Context,
  body: Record<string, string>,
  clientRowId: string,
) {
  const refreshToken = body.refresh_token;
  if (!refreshToken) {
    return c.json(
      { error: "invalid_request", error_description: "refresh_token is required" },
      400,
    );
  }

  try {
    const rotated = await rotateRefreshToken({
      refreshToken,
      expectedClientId: clientRowId,
    });
    const accessToken = signAccessToken({
      userId: rotated.userId,
      orgId: rotated.orgId,
      clientId: clientRowId,
      scopes: rotated.scopes,
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    });

    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: rotated.refreshToken,
      scope: rotated.scopes.join(" "),
    });
  } catch (err) {
    if (err instanceof RefreshTokenReuseError) {
      // Log as security event — stderr is captured by Cloud Run.
      console.error(`[OAuth refresh reuse] chain=${err.chainId} client=${clientRowId}`);
      return c.json(
        { error: "invalid_grant", error_description: "refresh token reuse detected; chain revoked" },
        401,
      );
    }
    if (err instanceof ValidationError) {
      // Log the underlying reason (not-found / revoked / expired / client
      // mismatch) so support can still debug, but return a single generic
      // response shape to prevent state-leak enumeration.
      console.error(`[OAuth refresh reject] client=${clientRowId} reason=${err.message}`);
      return c.json(
        { error: "invalid_grant", error_description: "invalid_grant: refresh token rejected" },
        400,
      );
    }
    throw err;
  }
}
