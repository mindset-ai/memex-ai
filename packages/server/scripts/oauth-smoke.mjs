#!/usr/bin/env node
// Live OAuth + /mcp end-to-end smoke against a running Memex server.
//
// Walks every step Anthropic reviewers will exercise — DCR, /authorize preview,
// /authorize consent, /token (code grant), /mcp with the OAuth JWT, /mcp with
// an mxt_ PAT (coexistence), /token (refresh rotation), and reuse-detection
// chain-revoke (dec-7c).
//
// Usage:
//
//   1. Start the server (see CLAUDE.md → "make dev" or equivalent).
//   2. Seed a reviewer account to get a user UUID + mxt_ PAT:
//        pnpm --filter @memex/server db:seed-reviewer
//      Copy the printed User UUID and mxt_ token.
//   3. Run this script with the values from step 2:
//        OAUTH_SMOKE_USER_ID=<uuid> OAUTH_SMOKE_MXT_TOKEN=mxt_... \
//          node packages/server/scripts/oauth-smoke.mjs
//
// Optional env:
//   OAUTH_SMOKE_BASE_URL   default http://localhost:8080
//   AUTH_JWT_SECRET        default the dev fallback in services/auth-jwt.ts;
//                          MUST match the running server's secret.
//
// Exits 0 on full green, non-zero on any unexpected status. Use in CI by
// piping into a pass/fail check.

import { createHash, createHmac, randomBytes } from "node:crypto";

const BASE = process.env.OAUTH_SMOKE_BASE_URL ?? "http://localhost:8080";
const USER_ID = process.env.OAUTH_SMOKE_USER_ID;
const MXT_TOKEN = process.env.OAUTH_SMOKE_MXT_TOKEN;
const JWT_SECRET =
  process.env.AUTH_JWT_SECRET ??
  "dev-only-jwt-secret-change-in-production-12345678";

if (!USER_ID) {
  console.error(
    "OAUTH_SMOKE_USER_ID is required. Run `pnpm --filter @memex/server db:seed-reviewer` first and pass the printed User UUID.",
  );
  process.exit(2);
}

const RUN_MXT_STEP = Boolean(MXT_TOKEN);

// ── helpers ─────────────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signSessionJwt(userId) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ sub: userId, iat: now, exp: now + 3600 }),
  );
  const sig = b64url(
    createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

function makePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

let failures = 0;
function log(label, expectedStatus, actualStatus, body) {
  const ok = Array.isArray(expectedStatus)
    ? expectedStatus.includes(actualStatus)
    : expectedStatus === actualStatus;
  const colour = ok ? "\x1b[32m" : "\x1b[31m";
  if (!ok) failures++;
  console.log(`\n=== ${label} (${colour}${actualStatus}\x1b[0m, expected ${expectedStatus}) ===`);
  if (body !== undefined) {
    const out =
      typeof body === "string"
        ? body.slice(0, 500) + (body.length > 500 ? "…" : "")
        : JSON.stringify(body, null, 2);
    console.log(out);
  }
}

// ── flow ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`OAuth smoke against ${BASE} for user ${USER_ID}`);
  console.log(`mxt_ coexistence step: ${RUN_MXT_STEP ? "yes" : "skipped (no OAUTH_SMOKE_MXT_TOKEN)"}\n`);

  const sessionJwt = signSessionJwt(USER_ID);
  const { verifier, challenge } = makePkce();

  // 1. DCR
  let res = await fetch(`${BASE}/api/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "oauth-smoke.mjs",
      redirect_uris: ["https://example.com/cb"],
    }),
  });
  const reg = await res.json();
  log("1. POST /api/oauth/register", 201, res.status, {
    client_id: reg.client_id,
    has_client_secret: Boolean(reg.client_secret),
    has_registration_access_token: Boolean(reg.registration_access_token),
  });

  // 2. Preview (renders the Org picker)
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: "https://example.com/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "oauth-smoke",
  });
  res = await fetch(`${BASE}/api/oauth/authorize/preview?${qs}`, {
    headers: { Authorization: `Bearer ${sessionJwt}` },
  });
  const preview = await res.json();
  log("2. GET /api/oauth/authorize/preview", 200, res.status, preview);

  // 3. Authorize allow → code
  res = await fetch(`${BASE}/api/oauth/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionJwt}`,
    },
    body: JSON.stringify({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: "https://example.com/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "oauth-smoke",
      decision: "allow",
    }),
  });
  const auth = await res.json();
  log("3. POST /api/oauth/authorize allow", 200, res.status, auth);
  const code = new URL(auth.redirect).searchParams.get("code");

  // 4. Exchange code for tokens
  res = await fetch(`${BASE}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "https://example.com/cb",
      client_id: reg.client_id,
      client_secret: reg.client_secret,
    }),
  });
  const tokens = await res.json();
  log("4. POST /api/oauth/token (code → tokens)", 200, res.status, {
    access_token: tokens.access_token?.slice(0, 40) + "…",
    refresh_token: tokens.refresh_token?.slice(0, 12) + "…",
    expires_in: tokens.expires_in,
    scope: tokens.scope,
    token_type: tokens.token_type,
  });

  // 5. /mcp with OAuth JWT
  res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const mcpJwtBody = await res.text();
  log("5. POST /mcp with OAuth JWT (tools/list)", 200, res.status, mcpJwtBody);

  // 6. /mcp with mxt_ PAT (coexistence)
  if (RUN_MXT_STEP) {
    res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${MXT_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const mcpMxtBody = await res.text();
    log("6. POST /mcp with mxt_ PAT (coexistence)", 200, res.status, mcpMxtBody);
  }

  // 7. Refresh rotation
  res = await fetch(`${BASE}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: reg.client_id,
      client_secret: reg.client_secret,
    }),
  });
  const rotated = await res.json();
  log("7. POST /api/oauth/token (refresh rotation)", 200, res.status, {
    access_token: rotated.access_token?.slice(0, 40) + "…",
    refresh_token_changed: rotated.refresh_token !== tokens.refresh_token,
  });

  // 8. Replay the original refresh → reuse detection
  res = await fetch(`${BASE}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: reg.client_id,
      client_secret: reg.client_secret,
    }),
  });
  const reuse = await res.json();
  log("8. POST /api/oauth/token with OLD refresh (reuse detection)", 401, res.status, reuse);

  console.log(`\n=== Summary ===`);
  console.log(failures === 0 ? "\x1b[32mALL GREEN\x1b[0m" : `\x1b[31m${failures} step(s) failed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n!!! ERROR:", err.message);
  process.exit(1);
});
