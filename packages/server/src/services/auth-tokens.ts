// Single-use tokens for the email-based auth flows:
//   - email_verification: sent after email+password signup. 24h expiry.
//   - magic_link:         alternative sign-in / sign-up method. 15min expiry.
//   - password_reset:     forgot-password flow. 1h expiry.
//
// Tokens are opaque random strings (see auth-jwt.generateOpaqueToken). We store only
// the sha256 HASH in the DB — the raw value is emailed to the user and never persisted.
// This way a database read doesn't leak active tokens.

import { and, eq, isNull, lt, or, isNotNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db/connection.js";
import { authTokens } from "../db/schema.js";
import type { AuthToken } from "../db/schema.js";
import { generateOpaqueToken } from "./auth-jwt.js";
import { mutate, type Mutated } from "./mutate.js";

export type AuthTokenPurpose = "email_verification" | "magic_link" | "password_reset";

const EXPIRY_SECONDS: Record<AuthTokenPurpose, number> = {
  email_verification: 24 * 60 * 60, // 24h
  magic_link: 15 * 60, // 15min
  password_reset: 60 * 60, // 1h
};

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface IssueTokenInput {
  purpose: AuthTokenPurpose;
  email: string;
  userId?: string | null;
}

export interface IssuedToken {
  /** The raw token to embed in the email link. Not persisted. */
  raw: string;
  /** The row written to auth_tokens (with hashed token, safe to log). */
  row: AuthToken;
}

export async function issueAuthToken(input: IssueTokenInput): Promise<Mutated<IssuedToken>> {
  const raw = generateOpaqueToken(32);
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + EXPIRY_SECONDS[input.purpose] * 1000);

  // silent: auth_tokens is silent-allowed per std-8 §6 — no UI subscriber on
  // token lifecycle. The wrap is the structural guarantee (Mutated<T> brand
  // + coverage scanner), not an SSE-facing event.
  return mutate(
    {},
    {
      memexId: "",
      userId: input.userId ?? undefined,
      entity: "auth_token",
      action: "created",
    },
    async () => {
      const [row] = await db
        .insert(authTokens)
        .values({
          purpose: input.purpose,
          userId: input.userId ?? null,
          email: normalizeEmail(input.email),
          tokenHash,
          expiresAt,
        })
        .returning();
      return { raw, row };
    },
    { silent: true },
  );
}

export class AuthTokenError extends Error {
  constructor(
    public readonly reason: "unknown" | "expired" | "consumed" | "wrong_purpose",
    message: string
  ) {
    super(message);
    this.name = "AuthTokenError";
  }
}

// Consumes a token — idempotent-safe: a consumed token can't be re-used. Returns the
// row on success so the caller can look up user_id / email. Throws AuthTokenError
// with a specific reason so the route can return distinct error messages.
//
// silent: this is the literal example from std-8 §2 ("consuming a single-use token")
// — wrapped to preserve the type brand and pass the coverage scanner, but auth_tokens
// is silent-allowed (no UI subscriber on token lifecycle).
export async function consumeAuthToken(
  purpose: AuthTokenPurpose,
  raw: string
): Promise<Mutated<AuthToken>> {
  if (typeof raw !== "string" || !raw) {
    throw new AuthTokenError("unknown", "Token is required");
  }
  const tokenHash = hashToken(raw);

  const row = await db.query.authTokens.findFirst({
    where: eq(authTokens.tokenHash, tokenHash),
  });
  if (!row) {
    throw new AuthTokenError("unknown", "Invalid or unknown token");
  }
  if (row.purpose !== purpose) {
    throw new AuthTokenError("wrong_purpose", "Token is for a different purpose");
  }
  if (row.consumedAt) {
    throw new AuthTokenError("consumed", "Token has already been used");
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new AuthTokenError("expired", "Token has expired");
  }

  return mutate(
    {},
    {
      memexId: "",
      userId: row.userId ?? undefined,
      entity: "auth_token",
      action: "updated",
    },
    async () => {
      const [updated] = await db
        .update(authTokens)
        .set({ consumedAt: new Date() })
        .where(and(eq(authTokens.id, row.id), isNull(authTokens.consumedAt)))
        .returning();

      if (!updated) {
        // Race: another caller consumed it between our check and update.
        throw new AuthTokenError("consumed", "Token has already been used");
      }
      return updated;
    },
    { silent: true },
  );
}

// Housekeeping — deletes consumed tokens and expired tokens older than 7 days.
// Call periodically from a background cron (not wired yet; invoked on-demand if needed).
//
// silent: ephemeral cleanup, no UI subscriber.
export async function cleanupExpiredAuthTokens(): Promise<Mutated<number>> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return mutate(
    {},
    { memexId: "", entity: "auth_token", action: "deleted" },
    async () => {
      const deleted = await db
        .delete(authTokens)
        .where(or(isNotNull(authTokens.consumedAt), lt(authTokens.expiresAt, cutoff)))
        .returning({ id: authTokens.id });
      return deleted.length;
    },
    { silent: true },
  );
}
