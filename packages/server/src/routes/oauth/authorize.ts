// /api/oauth/authorize — the OAuth 2.1 authorization endpoint.
//
// Two paths:
//   GET  → param validation; if session valid → 302 to the React consent
//          page (/oauth/authorize?<preserved params>); else 302 to login
//          with returnTo=<original>.
//   POST → session-required; body has the OAuth params + decision
//          (allow|deny). On allow: mints an auth code, returns the
//          redirect_uri with ?code=&state=. On deny: returns the
//          redirect_uri with ?error=access_denied&state=.

import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../../middleware/session.js";
import { mintAuthCode } from "../../services/oauth/codes.js";
import { getClientByClientId } from "../../services/oauth/clients.js";
import { buildAppBaseUrl } from "../../services/shared/tenant-url.js";

// spec-307 (dec-1/dec-2): an OAuth grant is the user's full LIVE membership, not a
// frozen per-Org scope (supersedes b-31 dec-8). There is no Org to pick at consent,
// so the consent screen has no Org picker and the grant stores no Org. The former
// `listGrantableOrgs` helper (and its db/orgs imports) is gone with it.

export const authorize = new Hono<SessionEnv>();

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  state?: string;
}

function readParams(c: import("hono").Context): AuthorizeParams | { error: string } {
  const q = c.req.query();
  const required = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method"] as const;
  for (const k of required) {
    if (!q[k]) return { error: `missing ${k}` };
  }
  if (q.response_type !== "code") return { error: "response_type must be 'code'" };
  if (q.code_challenge_method !== "S256") {
    return { error: "code_challenge_method must be 'S256'" };
  }
  return {
    response_type: q.response_type,
    client_id: q.client_id,
    redirect_uri: q.redirect_uri,
    code_challenge: q.code_challenge,
    code_challenge_method: q.code_challenge_method,
    scope: q.scope,
    state: q.state,
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1";
}

// RFC 8252 §7.3: for loopback redirect URIs, the authorization server MUST
// allow any port at request time. Clients (Claude Code, Claude Desktop, etc.)
// bind ephemeral localhost ports per session; the registered URI's port is
// effectively a placeholder. Match scheme + host (loopback set) + pathname,
// ignore port. Non-loopback URIs still require strict equality.
function redirectUrisMatch(registered: string, incoming: string): boolean {
  if (registered === incoming) return true;
  let r: URL;
  let i: URL;
  try {
    r = new URL(registered);
    i = new URL(incoming);
  } catch {
    return false;
  }
  if (!isLoopbackHost(r.hostname) || !isLoopbackHost(i.hostname)) return false;
  return r.protocol === i.protocol && r.pathname === i.pathname;
}

function clientRedirectAllowed(client: { redirectUris: string[] }, uri: string): boolean {
  return client.redirectUris.some((registered) => redirectUrisMatch(registered, uri));
}

// GET /api/oauth/authorize?<params>
//
// We do NOT 302 the user to the redirect_uri with an error if the params are
// malformed — that would leak the auth server's state to whatever the
// attacker passed as redirect_uri. Per RFC 6749 §4.1.2.1, validation failures
// on response_type / redirect_uri / client_id MUST be rendered to the user
// directly. We return a JSON error here; the consent page (t-5) will surface
// it via a fetch error.
authorize.get("/", async (c) => {
  const params = readParams(c);
  if ("error" in params) {
    return c.json({ error: "invalid_request", error_description: params.error }, 400);
  }

  const client = await getClientByClientId(params.client_id);
  if (!client) {
    return c.json({ error: "invalid_client", error_description: "unknown client_id" }, 400);
  }
  if (!clientRedirectAllowed(client, params.redirect_uri)) {
    // Defence: refusing redirect_uri locally so we never reflect a forged
    // value back to the user agent.
    return c.json(
      { error: "invalid_request", error_description: "redirect_uri not registered for this client" },
      400,
    );
  }

  // We've validated the client + redirect_uri. The actual consent is rendered
  // by the React page at /oauth/authorize on the app host (`APP_BASE_URL`).
  // Use `buildAppBaseUrl()` per std-2 — the helper resolves to the env's app
  // host (`memex.ai` on prod, `int.memex.ai` on int, `localhost:5173` in
  // dev). Preserve all params via query string so the React page can POST
  // them back.
  //
  // If no session, the React page detects "not logged in" via /api/me and
  // bounces through /login itself — keeps the redirect chain readable.
  const qs = c.req.url.split("?")[1] ?? "";
  return c.redirect(`${buildAppBaseUrl()}/oauth/authorize?${qs}`, 302);
});

// GET /api/oauth/authorize/preview?<params> — session-required. Returns the
// client_name + scopes the consent UI needs to render. spec-307: no Org list — the
// grant covers the user's full live membership, so there is nothing to pick.
//
// Response shape:
//   {
//     client_name: string,
//     scopes: ["memex.full"],
//   }
authorize.use("/preview", sessionMiddleware);
authorize.get("/preview", async (c) => {
  const user = c.get("user");
  const params = readParams(c);
  if ("error" in params) {
    return c.json({ error: "invalid_request", error_description: params.error }, 400);
  }
  const client = await getClientByClientId(params.client_id);
  if (!client) {
    return c.json({ error: "invalid_client", error_description: "unknown client_id" }, 400);
  }
  if (!clientRedirectAllowed(client, params.redirect_uri)) {
    return c.json(
      { error: "invalid_request", error_description: "redirect_uri not registered for this client" },
      400,
    );
  }
  return c.json({
    client_name: client.clientName,
    // Server always grants memex.full per dec-2, regardless of `scope` param.
    scopes: ["memex.full"],
  });
});

// POST /api/oauth/authorize — session-required consent action. Body shape:
//   { response_type, client_id, redirect_uri, code_challenge,
//     code_challenge_method, scope?, state?, decision: "allow" | "deny" }
authorize.use("/", sessionMiddleware);
authorize.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_request", error_description: "body must be JSON" }, 400);
  }

  const md = body as Record<string, unknown>;
  const required = ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "decision"] as const;
  for (const k of required) {
    if (typeof md[k] !== "string") {
      return c.json({ error: "invalid_request", error_description: `missing ${k}` }, 400);
    }
  }
  if (md.code_challenge_method !== "S256") {
    return c.json({ error: "invalid_request", error_description: "code_challenge_method must be S256" }, 400);
  }
  if (md.decision !== "allow" && md.decision !== "deny") {
    return c.json({ error: "invalid_request", error_description: "decision must be 'allow' or 'deny'" }, 400);
  }

  const client = await getClientByClientId(md.client_id as string);
  if (!client) {
    return c.json({ error: "invalid_client", error_description: "unknown client_id" }, 400);
  }
  if (!clientRedirectAllowed(client, md.redirect_uri as string)) {
    return c.json({ error: "invalid_request", error_description: "redirect_uri not registered" }, 400);
  }

  const state = typeof md.state === "string" ? md.state : "";

  // Build the callback by MERGING params into the registered redirect_uri via
  // URLSearchParams — never string-concat `?…`. A redirect_uri may legally carry
  // its own query string (RFC 6749 §3.1.2 forbids only fragments, which DCR
  // already rejects), so a naive `${uri}?code=` produced `…?tenant=acme?code=…`
  // and broke the client's parse (spec-275). `md.redirect_uri` is already
  // validated (clientRedirectAllowed + absolute-URI at registration), so
  // `new URL()` cannot throw here.
  const buildRedirect = (params: Record<string, string>): string => {
    const url = new URL(md.redirect_uri as string);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  };

  if (md.decision === "deny") {
    return c.json({
      redirect: buildRedirect({ error: "access_denied", ...(state ? { state } : {}) }),
    });
  }

  // spec-307 (dec-1/dec-2): a grant is the user's full LIVE membership, not a frozen
  // per-Org scope. We no longer collect or store an Org on the grant — the minted
  // token's `org` claim is null and the /mcp authorizer resolves live membership for
  // every token. Supersedes b-31 dec-8's per-Org scoping. Any `org_id` an older
  // client still sends is ignored.
  const orgId: string | null = null;

  // Scopes — single 'memex.full' in v1 per dec-2. We always grant memex.full
  // regardless of what the client requested (no granular scopes yet).
  const scopes = ["memex.full"];

  const minted = await mintAuthCode({
    clientId: client.id,
    userId: user.id,
    orgId,
    redirectUri: md.redirect_uri as string,
    codeChallenge: md.code_challenge as string,
    codeChallengeMethod: "S256",
    scopes,
  });

  return c.json({
    redirect: buildRedirect({ code: minted.code, ...(state ? { state } : {}) }),
  });
});
