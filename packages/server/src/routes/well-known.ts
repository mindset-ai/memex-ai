// OAuth 2.0 / MCP discovery documents (b-31 W1, RFC 8414 / RFC 9728).
//
// MCP clients (Claude.ai / Desktop / Code) fetch these to learn where to send
// /register, /authorize, /token, etc. Without them, no client can connect
// automatically — the Anthropic directory listing requires them.
//
// Served paths:
//   GET /.well-known/oauth-authorization-server
//   GET /.well-known/oauth-protected-resource         (root resource metadata)
//   GET /.well-known/oauth-protected-resource/mcp     (per-resource variant — RFC 9728 §3.1)
//
// All must be reachable without authentication. They advertise the API
// endpoints at /api/oauth/... (the OAuth router is mounted there).

import type { Context } from "hono";
import { Hono } from "hono";
import { isOAuthEnabled } from "./oauth/index.js";
import { ALLOWED_HOSTS } from "../middleware/memex-resolver.js";

export const wellKnown = new Hono();

export function publicBaseUrl(c: Context): string {
  // X-Forwarded-* set by Cloud Run; fall back to the Host header for local dev.
  const proto =
    c.req.header("X-Forwarded-Proto") ??
    (process.env.NODE_ENV === "production" ? "https" : "http");
  // `hostGuard` only validates the `Host` header, so an attacker controlling
  // `X-Forwarded-Host` could otherwise have us advertise authorization /
  // token endpoints on a host they own. Only honor X-Forwarded-Host when it
  // strips down to a host we know we serve on.
  const xfh = c.req.header("X-Forwarded-Host");
  const hostHeader = c.req.header("Host") ?? "memex.ai";
  const candidate =
    xfh && ALLOWED_HOSTS.has(xfh.split(":")[0].toLowerCase())
      ? xfh
      : hostHeader;
  return `${proto}://${candidate}`;
}

// RFC 8414 — OAuth Authorization Server Metadata.
wellKnown.get("/oauth-authorization-server", (c) => {
  if (!isOAuthEnabled()) {
    return c.json({ error: "not_found" }, 404);
  }
  const base = publicBaseUrl(c);
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    scopes_supported: ["memex.full"],
    service_documentation: `${base}/docs/claude`,
  });
});

// RFC 9728 — Protected Resource Metadata. MCP clients consult this from the
// `/mcp` resource to discover which authorization server protects it.
//
// RFC 9728 §3.1 specifies that clients construct the metadata URL by appending
// the resource path to /.well-known/oauth-protected-resource. We register both
// the root form (for backwards-compatible clients and for the WWW-Authenticate
// hint Anthropic clients historically followed) and the per-resource form
// (`/mcp`) so both shapes resolve.
const protectedResourceMetadata = (c: Context) => {
  if (!isOAuthEnabled()) {
    return c.json({ error: "not_found" }, 404);
  }
  const base = publicBaseUrl(c);
  return c.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ["memex.full"],
    bearer_methods_supported: ["header"],
  });
};

wellKnown.get("/oauth-protected-resource", protectedResourceMetadata);
wellKnown.get("/oauth-protected-resource/mcp", protectedResourceMetadata);
