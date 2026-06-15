// Org service. Owns the org lifecycle:
//   - getOrgById — primary org lookup
//   - findOrgsClaimingDomain — domain ↔ org join used by SSO
//   - createOrgWithOwner — transactional org + namespace + admin membership
//     (per dec-1 of doc-19, no longer inserts a default memex)
//   - createOrgForUser — public org-creation surface with std-3 gates (rate limit,
//     slug reservation, verified-email check)
//   - getOrgSummary / updateOrgSettings — settings page
//   - refreshOrgDomainVerifiedFlag — sync the org.domainVerified bit after verification
//
// Namespace lookups + rename live in services/namespaces.ts (split out per
// doc-19 t-1). Memex lookups + URL helpers live in services/memexes.ts.

import { and, count, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  namespaces,
  orgMemberships,
  orgs,
  users,
  verifiedDomains,
} from "../db/schema.js";
import type { Namespace, Org, OrgMembership, VerifiedDomain } from "../db/schema.js";
import { validateSubdomainFormat } from "./shared/subdomain.js";
import {
  isSlugAvailable as slugIsAvailable,
  validateSlugFormat,
} from "./shared/slug.js";
import { ConflictError, ValidationError } from "../types/errors.js";
import { pgError } from "./shared/pg-error.js";
import { isFreeEmailDomain } from "./free-email-domains.js";
import { mutate, type Mutated } from "./mutate.js";
import { primaryMemexIdForOrg } from "./shared/memex-ownership.js";

export async function getOrgById(id: string): Promise<Org | undefined> {
  return db.query.orgs.findFirst({ where: eq(orgs.id, id) });
}

// Returns all orgs whose email_domains JSONB array contains the given domain.
// Used by the SSO route to know which orgs a Workspace `hd` claim should auto-verify
// for, even when the user is not yet a member.
export async function findOrgsClaimingDomain(domain: string): Promise<Org[]> {
  const normalized = domain.trim().toLowerCase();
  return db
    .select()
    .from(orgs)
    .where(sql`${orgs.emailDomains} @> ${JSON.stringify([normalized])}::jsonb`);
}

export interface CreateOrgInput {
  // Namespace slug — used for the URL identity and the org's display fallback.
  slug: string;
  name?: string;
  ownerUserId: string;
  // Recorded on the org row for the std-3 5-orgs-per-24h rate-limit check.
  // Defaults to null when caller doesn't distinguish.
  createdByUserId?: string;
}

// Creates an org + its namespace + the first administrator membership atomically.
// Per dec-1 of doc-19 this no longer inserts a default Memex — members add Memexes
// via the explicit Add Memex flow. Race condition: two users picking the same slug
// at the same time → loser gets ConflictError via the unique constraint.
export async function createOrgWithOwner(
  input: CreateOrgInput,
): Promise<Mutated<{ org: Org; namespace: Namespace; membership: OrgMembership }>> {
  const slug = input.slug.trim().toLowerCase();
  const formatCheck = validateSubdomainFormat(slug);
  if (!formatCheck.valid) {
    throw new ValidationError(`Invalid slug: ${formatCheck.error}`);
  }
  const name = input.name?.trim() || slug.charAt(0).toUpperCase() + slug.slice(1);

  // Composite emit per std-8 dec-2: each logical change emits independently;
  // subscribers filter on entity. Per dec-1 of doc-19, Org creation makes no
  // Memex, so there's no Memex-scoped channel to broadcast on; we emit
  // user-scoped events (memexId="") so /api/me/events delivers them and the
  // React UI's AuthContext / MemexSwitcher refetches the membership list.
  return mutate(
    {},
    [
      () => ({
        memexId: "",
        userId: input.ownerUserId,
        entity: "org" as const,
        action: "created" as const,
      }),
      () => ({
        memexId: "",
        userId: input.ownerUserId,
        entity: "user_namespace" as const,
        action: "created" as const,
      }),
      () => ({
        memexId: "",
        userId: input.ownerUserId,
        entity: "org_membership" as const,
        action: "created" as const,
      }),
    ],
    async () => {
      try {
        return await db.transaction(async (tx) => {
          const [namespace] = await tx
            .insert(namespaces)
            .values({
              slug,
              kind: "org",
            })
            .returning();

          const [org] = await tx
            .insert(orgs)
            .values({
              namespaceId: namespace.id,
              name,
              createdByUserId: input.createdByUserId ?? null,
            })
            .returning();

          // Update namespace.ownerOrgId now that org exists (couldn't satisfy XOR with the
          // org row not existing yet).
          const [updatedNamespace] = await tx
            .update(namespaces)
            .set({ ownerOrgId: org.id })
            .where(eq(namespaces.id, namespace.id))
            .returning();

          const [membership] = await tx
            .insert(orgMemberships)
            .values({
              orgId: org.id,
              userId: input.ownerUserId,
              role: "administrator",
            })
            .returning();

          return { org, namespace: updatedNamespace, membership };
        });
      } catch (err) {
        if (pgError(err)?.code === "23505") {
          throw new ConflictError(`Slug '${slug}' is already taken`);
        }
        throw err;
      }
    },
  );
}

function normalizeDomain(d: string): string {
  return d.trim().toLowerCase();
}

export interface OrgSummary {
  id: string;
  name: string;
  // Slug of the org's namespace.
  slug: string;
  emailDomains: string[];
  autoGroupingEnabled: boolean;
  domainVerified: boolean;
  freeDomainsInUse: string[];
  verifiedDomains: Array<{ domain: string; method: "sso" | "email"; verifiedAt: Date }>;
}

export async function getOrgSummary(orgId: string): Promise<OrgSummary | null> {
  const org = await getOrgById(orgId);
  if (!org) return null;

  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, org.namespaceId) });
  if (!ns) return null;

  const claimed = (org.emailDomains as unknown[]).map((d) => normalizeDomain(String(d)));
  const verified = await db.query.verifiedDomains.findMany({
    where: eq(verifiedDomains.orgId, orgId),
  });

  return {
    id: org.id,
    name: org.name,
    slug: ns.slug,
    emailDomains: claimed,
    autoGroupingEnabled: org.autoGroupingEnabled,
    domainVerified: org.domainVerified,
    freeDomainsInUse: claimed.filter((d) => isFreeEmailDomain(d)),
    verifiedDomains: verified.map((v) => ({
      domain: v.domain,
      method: v.verificationMethod as "sso" | "email",
      verifiedAt: v.verifiedAt,
    })),
  };
}

export interface UpdateOrgInput {
  name?: string;
  emailDomains?: string[];
  autoGroupingEnabled?: boolean;
}

export async function updateOrgSettings(
  orgId: string,
  input: UpdateOrgInput,
): Promise<Mutated<OrgSummary>> {
  const current = await getOrgById(orgId);
  if (!current) throw new ValidationError(`Org ${orgId} not found`);

  // Personal namespaces don't have orgs, so any caller hitting this with a personal
  // memex's orgId would fail at getOrgById above. No `kind === 'personal'` check needed.

  const resolvedDomains = input.emailDomains
    ? input.emailDomains.map(normalizeDomain).filter(Boolean)
    : (current.emailDomains as unknown[]).map((d) => normalizeDomain(String(d)));
  const resolvedAutoGrouping = input.autoGroupingEnabled ?? current.autoGroupingEnabled;

  if (resolvedAutoGrouping) {
    const freeInResolved = resolvedDomains.filter((d) => isFreeEmailDomain(d));
    if (freeInResolved.length > 0) {
      throw new ValidationError(
        `Cannot enable auto-grouping while org claims free email domain(s): ${freeInResolved.join(", ")}`,
      );
    }
  }

  const patch: Partial<typeof orgs.$inferInsert> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) patch.name = input.name;
  if (input.emailDomains !== undefined) patch.emailDomains = resolvedDomains;
  if (input.autoGroupingEnabled !== undefined) patch.autoGroupingEnabled = resolvedAutoGrouping;

  const memexId = (await primaryMemexIdForOrg(orgId)) ?? "";

  return mutate(
    {},
    { memexId, entity: "org", action: "updated" },
    async () => {
      await db.update(orgs).set(patch).where(eq(orgs.id, orgId));
      const summary = await getOrgSummary(orgId);
      if (!summary) throw new ValidationError(`Org ${orgId} disappeared during update`);
      return summary;
    },
  );
}

export async function refreshOrgDomainVerifiedFlag(orgId: string): Promise<Mutated<void>> {
  const memexId = (await primaryMemexIdForOrg(orgId)) ?? "";
  return mutate(
    {},
    { memexId, entity: "org", action: "updated" },
    async () => {
      const verified = await db.query.verifiedDomains.findFirst({
        where: eq(verifiedDomains.orgId, orgId),
      });
      await db
        .update(orgs)
        .set({ domainVerified: !!verified, updatedAt: new Date() })
        .where(eq(orgs.id, orgId));
    },
  );
}

export type { VerifiedDomain };

// ───────────────────────────────────────────────────────────────────────────
// Public org-creation surface — t-14 of doc-15.
//
// Wraps `createOrgWithOwner` above with the std-3 / dec-8 gates the route
// layer enforces:
//   - verified email
//   - 5-orgs-per-user-per-24h rate limit
//   - reserved-slug rejection
//   - 30-day rename cooldown + 30-day post-rename slug reservation
// ───────────────────────────────────────────────────────────────────────────

// Rolling 24h. Slightly less precise than a leaky-bucket (the user could spike
// 5 right at the start of hour 0 and 5 more at hour 24:00:01) but adequate for
// std-3's anti-squatting goal.
const ORG_CREATIONS_PER_24H = 5;

export interface CreateOrgRequest {
  slug: string;
  name?: string;
  // The authenticated user creating the org. They become the first administrator.
  userId: string;
  // The user's email (already verified by the route gate). Used only to defend
  // against TOCTOU: we re-check users.emailVerifiedAt inside the transaction.
}

export interface CreatedOrg {
  org: Org;
  namespace: Namespace;
  membership: OrgMembership;
}

// Mirrors the std-3 rate-limit check. Returns null if the user is below the
// threshold; returns a structured error payload otherwise.
async function checkRateLimit(userId: string): Promise<{ count: number } | null> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ c: count() })
    .from(orgs)
    .where(
      and(
        eq(orgs.createdByUserId, userId),
        gte(orgs.createdAt, cutoff),
      ),
    );
  const recent = row?.c ?? 0;
  if (recent >= ORG_CREATIONS_PER_24H) {
    return { count: recent };
  }
  return null;
}

// std-3 + dec-8: any authenticated user with a verified email can create an
// org. Rate-limited to 5 per rolling 24h.
export async function createOrgForUser(input: CreateOrgRequest): Promise<CreatedOrg> {
  const slug = input.slug.trim().toLowerCase();

  const format = validateSlugFormat(slug);
  if (!format.valid) {
    throw new ValidationError(`Invalid slug: ${format.error}`);
  }

  // TOCTOU-safe re-check inside the same call: a session can have a stale
  // emailVerifiedAt from when it was minted. Pull fresh.
  const user = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!user) throw new ValidationError("User not found");
  if (!user.emailVerifiedAt) {
    throw new ValidationError("Email must be verified before creating an org");
  }
  if (user.status === "disabled") {
    throw new ValidationError("Org disabled");
  }

  // Check both active namespaces and reservation table.
  const available = await slugIsAvailable(slug);
  if (!available) {
    throw new ConflictError(`Slug '${slug}' is already taken`);
  }

  const breach = await checkRateLimit(input.userId);
  if (breach) {
    throw new ValidationError(
      `Rate limit exceeded: ${breach.count} orgs created in the past 24h (max ${ORG_CREATIONS_PER_24H}). Wait before creating another.`,
    );
  }

  // The transactional builder threads `createdByUserId` into the org insert so
  // the std-3 rate-limit query (orgs.createdByUserId) sees the row on the next
  // check without a follow-up update.
  const result = await createOrgWithOwner({
    slug,
    name: input.name,
    ownerUserId: input.userId,
    createdByUserId: input.userId,
  });

  return {
    org: result.org,
    namespace: result.namespace,
    membership: result.membership,
  };
}
