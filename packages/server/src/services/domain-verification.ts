import { and, eq, lt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/connection.js";
import { orgs, domainVerificationTokens, verifiedDomains } from "../db/schema.js";
import type { DomainVerificationToken, VerifiedDomain } from "../db/schema.js";
import { ValidationError, ConflictError } from "../types/errors.js";
import { isFreeEmailDomain } from "./free-email-domains.js";
import { upsertVerifiedDomain } from "./verified-domains.js";

const VERIFICATION_TTL_HOURS = 24;
const VERIFICATION_TTL_MS = VERIFICATION_TTL_HOURS * 60 * 60 * 1000;

export class DomainVerificationError extends ValidationError {
  constructor(public readonly reason: "unknown" | "expired" | "used", message: string) {
    super(message);
    this.name = "DomainVerificationError";
  }
}

function normalizeDomain(d: string): string {
  return d.trim().toLowerCase();
}

// Initiates a domain verification flow. Caller (route handler) must enforce that the requester
// is an administrator of orgId. Validates:
// - Domain is in the account's email_domains list (otherwise admins could verify domains
//   they haven't declared, defeating the explicit-claim model)
// - Domain is not a free-email provider (dec-7)
// - Domain is not already verified by a different account (dec-16)
//
// Returns the token row. Sending the email is the caller's responsibility (this lets us keep
// the service pure DB and easily stub the sender in tests).
export async function createDomainVerificationToken(
  orgId: string,
  domain: string
): Promise<DomainVerificationToken> {
  const normalized = normalizeDomain(domain);

  if (!normalized || !normalized.includes(".")) {
    throw new ValidationError("Domain is required and must include a dot");
  }
  if (isFreeEmailDomain(normalized)) {
    throw new ValidationError(
      `${normalized} is a free email provider — auto-grouping is not supported for free domains (dec-7)`
    );
  }

  const org = await db.query.orgs.findFirst({ where: eq(orgs.id, orgId) });
  if (!org) {
    throw new ValidationError(`Org ${orgId} not found`);
  }
  const claimed = (org.emailDomains as unknown[]).map((d) => String(d).toLowerCase());
  if (!claimed.includes(normalized)) {
    throw new ValidationError(
      `Add ${normalized} to the org's email domains list before verifying it`,
    );
  }

  // Check cross-account claim BEFORE consuming a row — friendly error rather than
  // letting the user click an email link only to fail at consume time.
  const existing = await db.query.verifiedDomains.findFirst({
    where: eq(verifiedDomains.domain, normalized),
  });
  if (existing && existing.orgId !== orgId) {
    throw new ConflictError(
      `${normalized} is already verified by another org`,
    );
  }

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
  const [created] = await db
    .insert(domainVerificationTokens)
    .values({ orgId, domain: normalized, token, expiresAt })
    .returning();
  return created;
}

// Atomically consumes a verification token and creates the verified_domains row.
// Idempotent: re-clicking the same link after success returns the existing verification.
// Race-safe: conditional `WHERE used = false` update so two concurrent clicks can't both win.
export async function consumeDomainVerificationToken(token: string): Promise<VerifiedDomain> {
  return db.transaction(async (tx) => {
    const row = await tx.query.domainVerificationTokens.findFirst({
      where: eq(domainVerificationTokens.token, token),
    });

    if (!row) {
      throw new DomainVerificationError("unknown", "Invalid verification link");
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new DomainVerificationError("expired", "This verification link has expired");
    }

    if (!row.used) {
      const [marked] = await tx
        .update(domainVerificationTokens)
        .set({ used: true })
        .where(
          and(eq(domainVerificationTokens.id, row.id), eq(domainVerificationTokens.used, false))
        )
        .returning();
      if (!marked) {
        // Concurrent claim won the race — treat as already-used
        throw new DomainVerificationError("used", "This verification link has already been used");
      }
    }

    // upsertVerifiedDomain enforces dec-16: cross-account claim throws ConflictError. Surface
    // it as-is so the route can return a clean error to the user.
    return upsertVerifiedDomain(row.domain, row.orgId, "email");
  });
}

// Background-job entry point: deletes expired verification tokens. Wire into the same hourly
// scheduler as invite cleanup. Idempotent and safe across instances.
export async function cleanupExpiredDomainVerificationTokens(): Promise<number> {
  const result = await db
    .delete(domainVerificationTokens)
    .where(lt(domainVerificationTokens.expiresAt, new Date()))
    .returning({ id: domainVerificationTokens.id });
  return result.length;
}
