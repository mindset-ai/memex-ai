// OAuth 2.1 authorization codes — PKCE-bound, single-use, 10-minute TTL.
// b-31 dec-7(b).
//
// Flow:
//   1. Client redirects user to /oauth/authorize with code_challenge + state.
//   2. User consents; we call mintAuthCode() and 302 back to redirect_uri
//      with ?code=...&state=...
//   3. Client POSTs /oauth/token with grant_type=authorization_code,
//      code, code_verifier, redirect_uri. We call consumeAuthCode() which
//      validates and marks single-use.

import { createHash, randomBytes } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/connection.js";
import { oauthAuthorizationCodes } from "../../db/schema.js";
import { ValidationError } from "../../types/errors.js";
import { mutate } from "../mutate.js";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes per dec-7(b)

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

function randomCode(): string {
  // 32 bytes = 256 bits of entropy, well above the RFC 6749 §10.10 floor.
  return randomBytes(32).toString("base64url");
}

export interface MintAuthCodeInput {
  clientId: string; // oauth_clients.id (uuid)
  userId: string;
  /** Chosen Org for this grant (per b-31 dec-8). null for personal-only. */
  orgId: string | null;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256" | "plain";
  scopes: string[];
}

export interface MintedAuthCode {
  code: string; // plaintext — embed in the redirect URL once, then forget
  expiresAt: Date;
}

export async function mintAuthCode(input: MintAuthCodeInput): Promise<MintedAuthCode> {
  // PKCE is required for OAuth 2.1 — reject 'plain' even though the column
  // allows it (kept in the schema check for forward-compat only).
  if (input.codeChallengeMethod !== "S256") {
    throw new ValidationError("OAuth 2.1 requires code_challenge_method=S256");
  }
  if (typeof input.codeChallenge !== "string" || input.codeChallenge.length < 43) {
    // RFC 7636 §4.1: code_verifier is 43–128 chars; the SHA-256 of it,
    // base64url-encoded, is always 43 chars.
    throw new ValidationError("code_challenge must be a base64url-encoded SHA-256 (43 chars)");
  }

  const code = randomCode();
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS);

  // silent: OAuth authorization codes are user/Org-scoped infrastructure with no
  // memexId — silent-allowed per std-8 §6, no SSE subscriber on the code lifecycle.
  // The wrap is the structural guarantee (Mutated brand + coverage scanner), not an
  // SSE-facing event (spec-156 ac-18).
  await mutate(
    {},
    { memexId: "", userId: input.userId, entity: "oauth_code", action: "created" },
    async () => {
      await db.insert(oauthAuthorizationCodes).values({
        codeHash: sha256Hex(code),
        clientId: input.clientId,
        userId: input.userId,
        orgId: input.orgId,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        scopes: input.scopes,
        expiresAt,
      });
    },
    { silent: true },
  );

  return { code, expiresAt };
}

export interface ConsumeAuthCodeInput {
  /** Plaintext code as the client received it from the redirect. */
  code: string;
  /** PKCE verifier — we recompute base64url(sha256(verifier)) and compare. */
  codeVerifier: string;
  /** The client_id row UUID we expect (defence-in-depth against code mix-ups). */
  expectedClientId: string;
  /** Must match what was passed at /authorize. */
  expectedRedirectUri: string;
}

export interface ConsumedAuthCode {
  userId: string;
  orgId: string | null;
  scopes: string[];
}

/**
 * Validate + single-use-consume an authorization code. Throws
 * `ValidationError` on anything wrong; the caller turns this into a 400
 * `invalid_grant` per RFC 6749 §5.2.
 */
export async function consumeAuthCode(
  input: ConsumeAuthCodeInput,
): Promise<ConsumedAuthCode> {
  const codeHash = sha256Hex(input.code);

  // Single-use: we UPDATE … RETURNING in one go, gated on consumed_at IS NULL
  // so that a previously-consumed code matches 0 rows. The `isNull` clause is
  // the actual single-use guarantee — RETURNING gives post-update values, so
  // we can't rely on inspecting `consumedAt` after the fact.
  const now = new Date();
  // silent: single-use consume of an OAuth authorization code — user/Org-scoped,
  // no memexId, silent-allowed per std-8 §6 (the literal "consuming a single-use
  // token" example). Wrapped to preserve the brand + coverage scanner (spec-156 ac-18).
  const row = await mutate(
    {},
    { memexId: "", entity: "oauth_code", action: "updated" },
    async () => {
      const [updated] = await db
        .update(oauthAuthorizationCodes)
        .set({ consumedAt: now })
        .where(
          and(
            eq(oauthAuthorizationCodes.codeHash, codeHash),
            isNull(oauthAuthorizationCodes.consumedAt),
          ),
        )
        .returning();
      return updated ?? null;
    },
    { silent: true },
  );

  if (!row) {
    // Collapsed "not found" and "already used" into one message: an attacker
    // who learns one path from the other can use it to probe for valid codes.
    throw new ValidationError(
      "invalid_grant: code not found, already used, or expired",
    );
  }
  if (row.expiresAt.getTime() < now.getTime()) {
    throw new ValidationError("invalid_grant: code expired");
  }
  if (row.clientId !== input.expectedClientId) {
    throw new ValidationError("invalid_grant: code/client mismatch");
  }
  if (row.redirectUri !== input.expectedRedirectUri) {
    throw new ValidationError("invalid_grant: redirect_uri mismatch");
  }

  // PKCE verification: recompute the challenge from the verifier.
  if (row.codeChallengeMethod !== "S256") {
    throw new ValidationError("invalid_grant: only S256 PKCE is accepted");
  }
  const recomputed = sha256Base64Url(input.codeVerifier);
  if (recomputed !== row.codeChallenge) {
    throw new ValidationError("invalid_grant: PKCE verifier mismatch");
  }

  return { userId: row.userId, orgId: row.orgId, scopes: row.scopes };
}
