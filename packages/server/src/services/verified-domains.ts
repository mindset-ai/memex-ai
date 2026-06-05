import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { orgs, verifiedDomains } from "../db/schema.js";
import type { VerifiedDomain } from "../db/schema.js";
import { ConflictError } from "../types/errors.js";

export type VerificationMethod = "sso" | "email";

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

export async function getVerifiedDomain(domain: string): Promise<VerifiedDomain | undefined> {
  return db.query.verifiedDomains.findFirst({
    where: eq(verifiedDomains.domain, normalizeDomain(domain)),
  });
}

// Idempotent within an account: re-verifying the same domain for the same account refreshes
// `verifiedAt`. Cross-account claim attempts throw ConflictError (dec-5: one account per domain).
// Side effect: sets accounts.domain_verified = true so the account-level flag stays in sync.
export async function upsertVerifiedDomain(
  domain: string,
  orgId: string,
  method: VerificationMethod
): Promise<VerifiedDomain> {
  const normalized = normalizeDomain(domain);
  const existing = await getVerifiedDomain(normalized);

  let result: VerifiedDomain;
  if (existing) {
    if (existing.orgId !== orgId) {
      throw new ConflictError(
        `Domain '${normalized}' is already verified for a different account`
      );
    }
    const [updated] = await db
      .update(verifiedDomains)
      .set({ verificationMethod: method, verifiedAt: new Date() })
      .where(eq(verifiedDomains.domain, normalized))
      .returning();
    result = updated;
  } else {
    const [created] = await db
      .insert(verifiedDomains)
      .values({ domain: normalized, orgId, verificationMethod: method })
      .returning();
    result = created;
  }

  // Mirror to the org-level flag so the UI can show a quick boolean without an extra join.
  await db
    .update(orgs)
    .set({ domainVerified: true, updatedAt: new Date() })
    .where(eq(orgs.id, orgId));

  return result;
}
