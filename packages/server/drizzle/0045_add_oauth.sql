-- b-31 W1 t-1: OAuth 2.1 + Dynamic Client Registration + PKCE storage.
--
-- Three additive tables that power the Anthropic Connectors Directory listing.
-- These coexist with `mcp_tokens` (per b-31 dec-1) — the /mcp route forks on
-- token prefix (`mxt_…` → mcp_tokens path; JWT → OAuth path). This migration
-- NEVER alters existing tables — it adds three new ones and nothing else.
-- Existing `mxt_` token users are completely unaffected.
--
-- Token storage matches the mcp_tokens shape: SHA-256 hashes, never plaintext,
-- soft-delete via `revoked_at`. Access tokens are JWTs (1h TTL, signed with
-- AUTH_JWT_SECRET) and live in services/auth-jwt.ts — they are NOT stored
-- here; this migration only persists refresh tokens, auth codes, and client
-- registrations.

-- ─── oauth_clients ─────────────────────────────────────────────────────────
-- Dynamic-Client-Registration entries (RFC 7591). Anonymous registration per
-- b-31 dec-7(a) — any caller can POST /oauth/register and get a client_id.
-- The returned client_secret is one-shot: we store only its SHA-256 hash.
-- Public clients (Claude Desktop, mcp-remote — PKCE-only) pass NULL.
CREATE TABLE "oauth_clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id" text NOT NULL UNIQUE,
  "client_secret_hash" text,
  "client_name" text NOT NULL,
  "redirect_uris" text[] NOT NULL,
  -- RFC 7592 — token the client uses to manage its own registration. Hashed.
  "registration_access_token_hash" text NOT NULL,
  "software_id" text,
  "software_version" text,
  -- Single 'memex.full' scope in v1 per b-31 dec-2. text[] for forward-compat.
  "scopes" text[] NOT NULL DEFAULT ARRAY['memex.full']::text[],
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "oauth_clients_client_id_idx" ON "oauth_clients" ("client_id");
--> statement-breakpoint

-- ─── oauth_authorization_codes ─────────────────────────────────────────────
-- Ephemeral PKCE-bound codes returned from /authorize and exchanged at /token
-- for an access+refresh pair. Single-use; 10-minute TTL per b-31 dec-7(b).
-- Stored as SHA-256 hash; plaintext only exists in the redirect URL once.
CREATE TABLE "oauth_authorization_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code_hash" text NOT NULL UNIQUE,
  "client_id" uuid NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  -- PKCE (RFC 7636) — challenge here, verifier sent at /token.
  "code_challenge" text NOT NULL,
  "code_challenge_method" text NOT NULL,
  "scopes" text[] NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "oauth_auth_codes_method_valid"
    CHECK ("code_challenge_method" IN ('S256', 'plain'))
);
--> statement-breakpoint
CREATE INDEX "oauth_auth_codes_expires_at_idx"
  ON "oauth_authorization_codes" ("expires_at");
--> statement-breakpoint

-- ─── oauth_refresh_tokens ──────────────────────────────────────────────────
-- Rotating refresh tokens, 30-day TTL per b-31 dec-3. Each token is single-use:
-- /token with grant_type=refresh_token consumes the old one and mints a new one
-- with the SAME chain_id. Reuse of a consumed token signals theft → per
-- b-31 dec-7(c), revoke every row sharing this chain_id (the entire lineage)
-- but NOT the user's other OAuth chains.
CREATE TABLE "oauth_refresh_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash" text NOT NULL UNIQUE,
  "chain_id" uuid NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scopes" text[] NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_chain_id_idx"
  ON "oauth_refresh_tokens" ("chain_id");
--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_user_id_idx"
  ON "oauth_refresh_tokens" ("user_id");
--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_expires_at_idx"
  ON "oauth_refresh_tokens" ("expires_at");
