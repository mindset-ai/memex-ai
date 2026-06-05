// POST /api/oauth/register — RFC 7591 Dynamic Client Registration.
//
// Anonymous (no auth) per b-31 dec-7(a). Validates redirect_uris, mints a
// client_id (+ optional client_secret + registration_access_token), returns
// the full RFC 7591 response shape. The secret is shown ONCE — there is no
// "read this back later" path.

import { Hono } from "hono";
import { registerClient } from "../../services/oauth/clients.js";
import { ValidationError } from "../../types/errors.js";
import { rateLimit, AUTH_LIMITS } from "../../services/auth-rate-limit.js";
import { clientIp } from "../auth/helpers.js";

export const register = new Hono();

register.post("/", async (c) => {
  // /oauth/register is anonymous DCR per b-31 dec-7(a) — without IP-keyed
  // rate-limiting any caller could flood the clients table. 10/hour per IP is
  // generous for legitimate clients (which register once and reuse the
  // client_id) but cuts off bulk-registration probes.
  const ip = clientIp(c);
  const rl = rateLimit("oauthRegister", ip, AUTH_LIMITS.oauthRegister);
  if (!rl.ok) {
    c.header("Retry-After", String(rl.retryAfterSec ?? 1));
    return c.json(
      {
        error: "too_many_requests",
        error_description: "too many registration attempts, retry later",
      },
      429,
    );
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400);
  }

  const md = body as Record<string, unknown>;
  // RFC 7591 §2 metadata fields. We only support a small subset; unknown
  // fields are ignored (per spec §3.1).
  const redirectUris = md.redirect_uris;
  const clientName = md.client_name;
  const tokenEndpointAuthMethod = md.token_endpoint_auth_method;
  const softwareId = md.software_id;
  const softwareVersion = md.software_version;

  if (!Array.isArray(redirectUris)) {
    return c.json(
      { error: "invalid_redirect_uri", error_description: "redirect_uris is required" },
      400,
    );
  }
  if (typeof clientName !== "string" || !clientName.trim()) {
    return c.json(
      { error: "invalid_client_metadata", error_description: "client_name is required" },
      400,
    );
  }
  if (
    tokenEndpointAuthMethod !== undefined &&
    tokenEndpointAuthMethod !== "none" &&
    tokenEndpointAuthMethod !== "client_secret_basic"
  ) {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: "token_endpoint_auth_method must be 'none' or 'client_secret_basic'",
      },
      400,
    );
  }

  try {
    const result = await registerClient({
      redirectUris: redirectUris as string[],
      clientName,
      softwareId: typeof softwareId === "string" ? softwareId : undefined,
      softwareVersion: typeof softwareVersion === "string" ? softwareVersion : undefined,
      tokenEndpointAuthMethod: tokenEndpointAuthMethod as "none" | "client_secret_basic" | undefined,
    });
    // RFC 7591 §3.2.1 response shape.
    return c.json(
      {
        client_id: result.clientId,
        ...(result.clientSecret ? { client_secret: result.clientSecret } : {}),
        registration_access_token: result.registrationAccessToken,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        client_name: clientName,
        token_endpoint_auth_method: tokenEndpointAuthMethod ?? "client_secret_basic",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json(
        { error: "invalid_client_metadata", error_description: err.message },
        400,
      );
    }
    throw err;
  }
});
