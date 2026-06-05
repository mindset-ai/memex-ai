// OAuth 2.1 refresh tokens — rotating, single-use, reuse-detected.
// b-31 dec-3 + dec-7(c).
//
// Lifecycle:
//   1. /token exchanges an auth code for an access+refresh pair via
//      mintRefreshToken({...}) — first row in a fresh chain_id.
//   2. Client presents the refresh token at /token (grant_type=refresh_token)
//      → rotateRefreshToken() consumes the old row and mints a new one
//      with the SAME chain_id.
//   3. If a token in the chain is re-presented AFTER it was already
//      consumed → reuse signal. Per dec-7(c): revoke every row sharing
//      chain_id (the lineage), but NOT the user's other chains.

import { createHash, randomBytes } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db, type Db } from "../../db/connection.js";
import { oauthRefreshTokens } from "../../db/schema.js";
import { ValidationError } from "../../types/errors.js";
import { randomUUID } from "node:crypto";
import { mutate } from "../mutate.js";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days per dec-3

/**
 * Test-only hook. The rollback integration test sets this to a function
 * that throws — proves the consume rolls back when something fails between
 * consume and mint. Always undefined in prod.
 *
 * Exposed via __setRotateMintHook so tests don't depend on module mutation.
 */
let __rotateMintHook: (() => Promise<void>) | undefined;
export function __setRotateMintHook(fn: (() => Promise<void>) | undefined): void {
  __rotateMintHook = fn;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function randomTokenString(): string {
  return randomBytes(32).toString("base64url");
}

export interface MintRefreshTokenInput {
  clientId: string;
  userId: string;
  /** Chosen Org for this grant (per b-31 dec-8). null for personal-only. */
  orgId: string | null;
  scopes: string[];
  /**
   * Pass an existing chain_id when ROTATING (to preserve lineage). Omit on
   * the FIRST token in a new chain (e.g. issued by the /authorize→/token
   * exchange) — we generate a fresh uuid.
   */
  chainId?: string;
}

export interface MintedRefreshToken {
  refreshToken: string; // plaintext — return once
  chainId: string;
  expiresAt: Date;
}

export async function mintRefreshToken(
  input: MintRefreshTokenInput,
  conn: Db = db,
): Promise<MintedRefreshToken> {
  const refreshToken = randomTokenString();
  const chainId = input.chainId ?? randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  // silent: OAuth refresh tokens are user/Org-scoped infrastructure with no memexId
  // — silent-allowed per std-8 §6, no SSE subscriber on the token chain. Wrapped to
  // preserve the brand + coverage scanner (spec-156 ac-18). `conn` may be a tx when
  // called inside rotateRefreshToken's transaction; mutate() just runs the callback,
  // it opens no transaction of its own, so the atomicity guarantee is unaffected.
  await mutate(
    {},
    { memexId: "", userId: input.userId, entity: "oauth_refresh_token", action: "created" },
    async () => {
      await conn.insert(oauthRefreshTokens).values({
        tokenHash: sha256Hex(refreshToken),
        chainId,
        clientId: input.clientId,
        userId: input.userId,
        orgId: input.orgId,
        scopes: input.scopes,
        expiresAt,
      });
    },
    { silent: true },
  );

  return { refreshToken, chainId, expiresAt };
}

export interface RotateRefreshTokenInput {
  refreshToken: string;
  expectedClientId: string;
}

export interface RotatedRefreshToken {
  refreshToken: string;
  chainId: string;
  userId: string;
  orgId: string | null;
  scopes: string[];
  expiresAt: Date;
}

export class RefreshTokenReuseError extends Error {
  constructor(public readonly chainId: string) {
    super("refresh token reuse detected; chain revoked");
    this.name = "RefreshTokenReuseError";
  }
}

/**
 * Single-use rotation. Atomically marks the presented token consumed (only if
 * NOT already consumed) and mints a new one in the same chain. On reuse →
 * throws RefreshTokenReuseError and revokes every row in the chain.
 *
 * Atomicity (t-30): the consume + mint pair runs inside a single DB
 * transaction so a crash between them can't orphan the chain (no consumed
 * old token without a freshly-minted successor). Reuse detection is handled
 * BEFORE the tx — on the already-consumed and concurrent-consume branches
 * we revoke the chain via the outer `db` (those revokes MUST persist even
 * though we throw, so they cannot live inside a rolled-back tx).
 *
 * Caller MAPS:
 *   - RefreshTokenReuseError → 401 invalid_grant + log security event
 *   - ValidationError → 400 invalid_grant
 */
export async function rotateRefreshToken(
  input: RotateRefreshTokenInput,
): Promise<RotatedRefreshToken> {
  const tokenHash = sha256Hex(input.refreshToken);

  // Step 1: load the row (without mutating) to inspect its state. Runs on
  // the outer `db` so the reuse-detected branches below can revoke the
  // chain durably — those side-effects must commit even when we throw.
  const [row] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash));

  if (!row) {
    // Unknown hash — could be a forged token, or a chain we already revoked
    // hard. RFC 6749 §5.2 says invalid_grant.
    throw new ValidationError("invalid_grant: refresh token not found");
  }
  if (row.clientId !== input.expectedClientId) {
    throw new ValidationError("invalid_grant: refresh token/client mismatch");
  }
  if (row.revokedAt) {
    throw new ValidationError("invalid_grant: refresh token revoked");
  }

  // Reuse detection: this token was already consumed before this call.
  // Per dec-7(c) revoke the entire chain. We do this on the outer `db` so
  // the chain revoke commits even though we throw immediately after.
  if (row.consumedAt) {
    await revokeChain(row.chainId);
    throw new RefreshTokenReuseError(row.chainId);
  }

  if (row.expiresAt.getTime() < Date.now()) {
    throw new ValidationError("invalid_grant: refresh token expired");
  }

  // Step 2 + 3 run inside a single transaction so consume-and-mint is
  // atomic. If anything throws inside the tx, Drizzle rolls back the
  // consume, leaving the OLD token usable for a retry.
  //
  // The concurrent-consume branch (0 rows updated) needs to (a) NOT mint a
  // new token and (b) revoke the chain durably. We achieve both by throwing
  // a private sentinel out of the tx (rolls back the no-op consume), then
  // catching it outside and revoking the chain on `db`.
  class ConcurrentConsumeError extends Error {
    constructor(public readonly chainId: string) {
      super("concurrent consume");
    }
  }

  let minted: MintedRefreshToken;
  try {
    minted = await db.transaction(async (tx) => {
      const now = new Date();
      // silent: single-use consume of the presented refresh token — user/Org-scoped,
      // no memexId, silent-allowed per std-8 §6. Wrapped to preserve the brand +
      // coverage scanner (spec-156 ac-18). Runs on `tx` so the consume+mint stay
      // atomic; mutate() opens no transaction of its own.
      const consumed = await mutate(
        {},
        { memexId: "", userId: row.userId, entity: "oauth_refresh_token", action: "updated" },
        async () =>
          tx
            .update(oauthRefreshTokens)
            .set({ consumedAt: now })
            .where(
              and(
                eq(oauthRefreshTokens.id, row.id),
                isNull(oauthRefreshTokens.consumedAt),
              ),
            )
            .returning({ id: oauthRefreshTokens.id }),
        { silent: true },
      );

      if (consumed.length === 0) {
        // Concurrent rotation already consumed this row. Throw to roll back
        // (no-op anyway since the UPDATE matched 0 rows). Outer catch will
        // revoke the chain on `db` and surface RefreshTokenReuseError.
        throw new ConcurrentConsumeError(row.chainId);
      }

      // Test hook: lets the rollback test fault-inject between consume and
      // mint to prove the consume rolls back. Always undefined in prod.
      if (__rotateMintHook) {
        await __rotateMintHook();
      }

      // Mint the next token in the same chain INSIDE the tx so a crash
      // between consume and mint can't orphan the chain. orgId is
      // preserved — the Org-scope was decided at /authorize time and
      // stays put for the chain's lifetime.
      return await mintRefreshToken(
        {
          clientId: row.clientId,
          userId: row.userId,
          orgId: row.orgId,
          scopes: row.scopes,
          chainId: row.chainId,
        },
        tx,
      );
    });
  } catch (err) {
    if (err instanceof ConcurrentConsumeError) {
      await revokeChain(err.chainId);
      throw new RefreshTokenReuseError(err.chainId);
    }
    throw err;
  }

  return {
    refreshToken: minted.refreshToken,
    chainId: minted.chainId,
    userId: row.userId,
    orgId: row.orgId,
    scopes: row.scopes,
    expiresAt: minted.expiresAt,
  };
}

/** Revoke every row in this chain. Idempotent. */
export async function revokeChain(chainId: string): Promise<void> {
  // silent: chain revoke on reuse detection — user/Org-scoped, no memexId,
  // silent-allowed per std-8 §6 (spec-156 ac-18).
  await mutate(
    {},
    { memexId: "", entity: "oauth_refresh_token", action: "deleted" },
    async () => {
      await db
        .update(oauthRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(oauthRefreshTokens.chainId, chainId), isNull(oauthRefreshTokens.revokedAt)),
        );
    },
    { silent: true },
  );
}

/**
 * Revoke a single token by plaintext value. Used by /settings/tokens UI when
 * a user revokes one device session. Only touches THIS token; siblings in
 * the chain (other devices using the same OAuth client) remain unaffected.
 *
 * Per dec-7(c) the "revoke chain" rule fires only on REUSE detection (a
 * security signal). User-initiated revoke is per-token by design.
 *
 * Per RFC 7009 §2.1, the authorization server SHOULD verify the requesting
 * client matches the issuing client. We filter on (tokenHash, clientId) so
 * a client cannot revoke another client's tokens. Non-matching tokens just
 * silently no-op — the route still returns 200 per RFC 7009 §2.2 to avoid
 * leaking whether the token exists for another client.
 */
export async function revokeRefreshToken(
  plaintext: string,
  expectedClientId: string,
): Promise<void> {
  // silent: user-initiated per-token revoke — user/Org-scoped, no memexId,
  // silent-allowed per std-8 §6 (spec-156 ac-18).
  await mutate(
    {},
    { memexId: "", entity: "oauth_refresh_token", action: "deleted" },
    async () => {
      await db
        .update(oauthRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(oauthRefreshTokens.tokenHash, sha256Hex(plaintext)),
            eq(oauthRefreshTokens.clientId, expectedClientId),
          ),
        );
    },
    { silent: true },
  );
}
