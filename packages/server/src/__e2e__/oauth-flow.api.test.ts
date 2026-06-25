// b-31 W1 t-6 — OAuth end-to-end regression.
//
// Drives the complete connector flow through Hono's `app.fetch()`:
//   1. POST /api/oauth/register                                — RFC 7591 DCR
//   2. GET  /api/oauth/authorize/preview                       — consent metadata
//   3. POST /api/oauth/authorize { decision: "allow" }         — mint code
//   4. POST /api/oauth/token (authorization_code)              — code → tokens
//   5. POST /mcp with Bearer <access_token>                    — JWT path works
//   6. POST /api/oauth/token (refresh_token)                   — rotate
//   7. POST /api/oauth/token (refresh_token) with OLD token    — reuse → 401, chain revoked
//   8. POST /api/oauth/revoke                                  — RFC 7009
//
// Requires:
//   - DATABASE_URL pointing at a Postgres with 0045_add_oauth applied.
//   - OAUTH_ENABLED=1 — the test sets this in beforeAll.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  users,
  oauthClients,
  oauthAuthorizationCodes,
  oauthRefreshTokens,
  namespaces,
  orgs,
  memexes,
  orgMemberships,
} from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { verifyAccessToken } from "../services/oauth/access-tokens.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-275 — the authorize redirect must MERGE params into a redirect_uri that
// already carries a query string, not blindly concatenate `?code=`.
const SPEC275_AC_1 = "mindset-prod/memex-building-itself/specs/spec-275/acs/ac-1";
const SPEC275_AC_2 = "mindset-prod/memex-building-itself/specs/spec-275/acs/ac-2";

// spec-31 ac-1 — "Anthropic reviewers can complete the full OAuth flow
// (discover → register client → authorize → receive tokens → call MCP tools)
// without manual intervention or token copy-pasting." This single test drives
// every leg programmatically: it discovers the endpoints from the .well-known
// metadata, then uses ONLY those discovered URLs for register/authorize/token,
// and finally authenticates a real /mcp tools/list with the minted access
// token — no human step, no copy-paste.
const SPEC_31_AC_1 = "mindset-prod/memex-building-itself/specs/spec-31/acs/ac-1";

const originalFlag = process.env.OAUTH_ENABLED;

beforeAll(() => {
  process.env.OAUTH_ENABLED = "1";
});

afterAll(() => {
  if (originalFlag === undefined) delete process.env.OAUTH_ENABLED;
  else process.env.OAUTH_ENABLED = originalFlag;
});

function makePkce() {
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

describe("OAuth e2e — full connector flow", () => {
  it("discover → register → authorize → token → /mcp → refresh → reuse → revoke", async () => {
    tagAc(SPEC_31_AC_1);
    // Lazy-import the app so OAUTH_ENABLED is read after beforeAll set it.
    const { app } = await import("../app.js");

    // ── 0. Discovery (RFC 8414 + RFC 9728) ───────────────────────────────
    // A real connector starts here: it reads the protected-resource metadata
    // off /mcp, follows it to the authorization-server metadata, and learns
    // the endpoint URLs. The rest of the flow uses ONLY these discovered
    // values — nothing is hardcoded by the client.
    const prRes = await app.fetch(
      new Request("https://memex.ai/.well-known/oauth-protected-resource/mcp"),
    );
    expect(prRes.status).toBe(200);
    const pr = (await prRes.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    // Resource metadata points at /mcp and names its authorization server. We
    // assert internal consistency (resource → auth server share one origin)
    // rather than a literal scheme — publicBaseUrl derives the origin from the
    // request, so the deployment's own scheme/host flows through.
    expect(pr.resource.endsWith("/mcp")).toBe(true);
    const authServer = pr.authorization_servers[0];
    expect(authServer).toBe(new URL(pr.resource).origin);

    const asRes = await app.fetch(
      new Request(`${authServer}/.well-known/oauth-authorization-server`),
    );
    expect(asRes.status).toBe(200);
    const meta = (await asRes.json()) as {
      issuer: string;
      registration_endpoint: string;
      authorization_endpoint: string;
      token_endpoint: string;
      revocation_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    // The endpoints the rest of this test drives are exactly the ones a
    // reviewer's client would have discovered — all hanging off the same
    // discovered issuer/base, no client-side hardcoding.
    const registrationEndpoint = meta.registration_endpoint;
    const authorizationEndpoint = meta.authorization_endpoint;
    const tokenEndpoint = meta.token_endpoint;
    const revocationEndpoint = meta.revocation_endpoint;
    expect(meta.issuer).toBe(authServer);
    expect(registrationEndpoint).toBe(`${authServer}/api/oauth/register`);
    expect(authorizationEndpoint).toBe(`${authServer}/api/oauth/authorize`);
    expect(tokenEndpoint).toBe(`${authServer}/api/oauth/token`);
    expect(revocationEndpoint).toBe(`${authServer}/api/oauth/revoke`);
    expect(meta.code_challenge_methods_supported).toContain("S256");

    // Seed a user + session.
    const user = await upsertUserByEmail(`oauth-e2e-${Date.now()}@test.dev`);
    userIds.push(user.id);
    const sessionJwt = signSessionToken(user.id);

    // ── 1. POST /api/oauth/register ──────────────────────────────────────
    const regRes = await app.fetch(
      new Request(registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "OAuth e2e test",
          redirect_uris: ["https://test.example/callback"],
        }),
      }),
    );
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as {
      client_id: string;
      client_secret: string;
      registration_access_token: string;
    };
    expect(reg.client_id).toBeTruthy();
    expect(reg.client_secret).toBeTruthy();

    // Track the client row for cleanup.
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(inArray(oauthClients.clientId, [reg.client_id]));
    clientRowIds.push(client.id);

    // ── 2. GET /api/oauth/authorize/preview ──────────────────────────────
    const { verifier, challenge } = makePkce();
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: "https://test.example/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "test-state",
    });
    const previewRes = await app.fetch(
      new Request(`${authorizationEndpoint}/preview?${qs}`, {
        headers: { Authorization: `Bearer ${sessionJwt}` },
      }),
    );
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      client_name: string;
      scopes: string[];
    };
    expect(preview.client_name).toBe("OAuth e2e test");
    expect(preview.scopes).toEqual(["memex.full"]);
    // spec-307: the preview no longer carries an Org list — the grant covers the
    // user's full live membership, so there is nothing to pick.
    expect((preview as { orgs?: unknown }).orgs).toBeUndefined();

    // ── 3. POST /api/oauth/authorize { decision: "allow" } ───────────────
    const authRes = await app.fetch(
      new Request(authorizationEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionJwt}`,
        },
        body: JSON.stringify({
          response_type: "code",
          client_id: reg.client_id,
          redirect_uri: "https://test.example/callback",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "test-state",
          decision: "allow",
        }),
      }),
    );
    expect(authRes.status).toBe(200);
    const authBody = (await authRes.json()) as { redirect: string };
    const redirectUrl = new URL(authBody.redirect);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe("https://test.example/callback");
    const code = redirectUrl.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get("state")).toBe("test-state");

    // ── 4. POST /api/oauth/token (authorization_code) ────────────────────
    const tokenRes = await app.fetch(
      new Request(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: "https://test.example/callback",
          client_id: reg.client_id,
          client_secret: reg.client_secret,
        }),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe("memex.full");
    expect(tokens.access_token.split(".")).toHaveLength(3); // JWT
    expect(tokens.refresh_token).toBeTruthy();

    // ── 5. POST /mcp with Bearer <access_token> ──────────────────────────
    const mcpRes = await app.fetch(
      new Request(pr.resource, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      }),
    );
    // We don't assert the tool list shape (covered by tools.test.ts); just
    // that the OAuth token authenticated us past the /mcp gate.
    expect([200, 202]).toContain(mcpRes.status);

    // ── 6. POST /api/oauth/token (refresh_token) — rotation ──────────────
    const refresh1Res = await app.fetch(
      new Request(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: reg.client_id,
          client_secret: reg.client_secret,
        }),
      }),
    );
    expect(refresh1Res.status).toBe(200);
    const refreshed = (await refresh1Res.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect(refreshed.access_token).not.toBe(tokens.access_token);

    // ── 7. Replay original refresh_token → 401 + chain revoke ────────────
    const reuseRes = await app.fetch(
      new Request(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token, // already consumed
          client_id: reg.client_id,
          client_secret: reg.client_secret,
        }),
      }),
    );
    expect(reuseRes.status).toBe(401);
    const reuseBody = (await reuseRes.json()) as { error: string };
    expect(reuseBody.error).toBe("invalid_grant");

    // After reuse detection, ALL tokens in the chain must be revoked —
    // including the legitimately-rotated `refreshed.refresh_token`.
    const reusedRefreshRes = await app.fetch(
      new Request(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshed.refresh_token,
          client_id: reg.client_id,
          client_secret: reg.client_secret,
        }),
      }),
    );
    expect(reusedRefreshRes.status).toBe(400);
    const reusedRefreshBody = (await reusedRefreshRes.json()) as { error: string };
    expect(reusedRefreshBody.error).toBe("invalid_grant");

    // ── 8. POST /api/oauth/revoke — RFC 7009 always returns 200 ──────────
    const revokeRes = await app.fetch(
      new Request(revocationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: refreshed.refresh_token,
          token_type_hint: "refresh_token",
          client_id: reg.client_id,
          client_secret: reg.client_secret,
        }),
      }),
    );
    expect(revokeRes.status).toBe(200);
  });

  it("rejects an /mcp call with an invalid OAuth token (signature mismatch)", async () => {
    const { app } = await import("../app.js");
    const res = await app.fetch(
      new Request("https://memex.ai/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization:
            "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.invalid-signature",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/error="invalid_token"/);
  });

  // Sanity: ensure cleanup queries don't blow up if a test row went missing.
  // Also exercise an auth-code expiry path indirectly — the cleanup query
  // hits every table we touched.
  it("schema sanity — codes and refresh tokens table accessible", async () => {
    const codes = await db.select().from(oauthAuthorizationCodes).limit(1);
    const refreshes = await db.select().from(oauthRefreshTokens).limit(1);
    expect(Array.isArray(codes)).toBe(true);
    expect(Array.isArray(refreshes)).toBe(true);
  });
});

describe("OAuth e2e — query-bearing redirect_uri merge (spec-275)", () => {
  // A redirect_uri with an existing query string is legal (RFC 6749 §3.1.2 bans
  // only fragments). The authorize handler must MERGE code/state/error into it,
  // not concat `?code=` (which produced `…?tenant=acme?code=…` and broke parsing).
  async function registerAndAuthorize(redirectUri: string, decision: "allow" | "deny"): Promise<string> {
    const { app } = await import("../app.js");
    const user = await upsertUserByEmail(`oauth-q-${decision}-${Date.now()}-${Math.random()}@test.dev`);
    userIds.push(user.id);
    const sessionJwt = signSessionToken(user.id);

    const regRes = await app.fetch(
      new Request("https://memex.ai/api/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "spec-275 query redirect", redirect_uris: [redirectUri] }),
      }),
    );
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as { client_id: string };
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(inArray(oauthClients.clientId, [reg.client_id]));
    clientRowIds.push(client.id);

    const { challenge } = makePkce();
    const authRes = await app.fetch(
      new Request("https://memex.ai/api/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionJwt}` },
        body: JSON.stringify({
          response_type: "code",
          client_id: reg.client_id,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "test-state",
          decision,
        }),
      }),
    );
    expect(authRes.status).toBe(200);
    const { redirect } = (await authRes.json()) as { redirect: string };
    return redirect;
  }

  it("ac-1/ac-2: grant merges code+state into an existing query string (no double-?)", async () => {
    tagAc(SPEC275_AC_1);
    tagAc(SPEC275_AC_2);
    const redirect = await registerAndAuthorize("https://test.example/callback?tenant=acme", "allow");
    expect(redirect.split("?").length).toBe(2); // exactly one '?' — merged, not concatenated
    const u = new URL(redirect);
    expect(u.searchParams.get("tenant")).toBe("acme"); // original param preserved, intact
    expect(u.searchParams.get("code")).toBeTruthy(); // merged & individually parseable
    expect(u.searchParams.get("state")).toBe("test-state");
  });

  it("ac-1: deny merges error+state into an existing query string (no double-?)", async () => {
    tagAc(SPEC275_AC_1);
    const redirect = await registerAndAuthorize("https://test.example/callback?tenant=acme", "deny");
    expect(redirect.split("?").length).toBe(2);
    const u = new URL(redirect);
    expect(u.searchParams.get("tenant")).toBe("acme");
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("test-state");
  });
});

// spec-307 (dec-1/dec-2): an OAuth grant carries NO per-Org scope. The consent
// endpoint neither requires nor stores an Org — even for a user in multiple Orgs,
// authorize with no org_id succeeds and the minted token's `org` claim is null.
// (Under the superseded b-31 dec-8 model this 400'd: "org_id is required".)
describe("spec-307 — OAuth grant carries no per-Org scope (ac-9)", () => {
  const ns307: string[] = [];
  afterAll(async () => {
    if (ns307.length)
      await db.delete(namespaces).where(inArray(namespaces.id, ns307)).catch(() => {});
  });

  async function makeOrg(userId: string, name: string): Promise<void> {
    const slug = `s307-${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`.toLowerCase();
    const [ns] = await db.insert(namespaces).values({ slug, kind: "org" } as never).returning();
    ns307.push(ns.id);
    const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name } as never).returning();
    await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    await db.insert(memexes).values({ name, slug: "main", namespaceId: ns.id } as never);
    await db.insert(orgMemberships).values({ userId, orgId: org.id, role: "administrator" } as never);
  }

  it("a user in MULTIPLE Orgs authorizes with NO org_id → grant minted with org=null", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-307/acs/ac-9");
    const { app } = await import("../app.js");

    const user = await upsertUserByEmail(`s307-ac9-${Date.now()}-${Math.random()}@test.dev`);
    userIds.push(user.id);
    await makeOrg(user.id, "alpha");
    await makeOrg(user.id, "beta");
    const sessionJwt = signSessionToken(user.id);

    const regRes = await app.fetch(
      new Request("https://memex.ai/api/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "spec-307 ac-9",
          redirect_uris: ["https://test.example/cb"],
        }),
      }),
    );
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as { client_id: string; client_secret: string };
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(inArray(oauthClients.clientId, [reg.client_id]));
    clientRowIds.push(client.id);

    const { verifier, challenge } = makePkce();
    const baseParams = {
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: "https://test.example/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };

    // Preview carries NO Org list.
    const qs = new URLSearchParams(baseParams).toString();
    const prev = await app.fetch(
      new Request(`https://memex.ai/api/oauth/authorize/preview?${qs}`, {
        headers: { Authorization: `Bearer ${sessionJwt}` },
      }),
    );
    expect(prev.status).toBe(200);
    expect(((await prev.json()) as { orgs?: unknown }).orgs).toBeUndefined();

    // Authorize with NO org_id → 200 (the superseded model 400'd for a multi-Org user).
    const authRes = await app.fetch(
      new Request("https://memex.ai/api/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionJwt}` },
        body: JSON.stringify({ ...baseParams, decision: "allow" }),
      }),
    );
    expect(authRes.status).toBe(200);
    const code = new URL(((await authRes.json()) as { redirect: string }).redirect).searchParams.get("code");
    expect(code).toBeTruthy();

    // Exchange → the access token carries NO Org scope (org=null).
    const tokRes = await app.fetch(
      new Request("https://memex.ai/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: "https://test.example/cb",
          client_id: reg.client_id,
          client_secret: reg.client_secret,
        }),
      }),
    );
    expect(tokRes.status).toBe(200);
    const { access_token } = (await tokRes.json()) as { access_token: string };
    expect(verifyAccessToken(access_token).org).toBeNull();
  });
});
