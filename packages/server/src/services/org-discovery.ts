// Slack-style org discovery + auto-join paths. Extracted from org-memberships.ts
// (which owns admin-driven mutations only) so the read-side discovery logic and the
// signup-path auto-join helpers live near each other.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, orgs, orgMemberships, verifiedDomains } from "../db/schema.js";
import type { OrgMembership } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { primaryMemexIdForOrg } from "./shared/memex-ownership.js";

function emailDomain(email: string): string | null {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2 || !parts[1]) return null;
  return parts[1];
}

export interface DiscoverableOrg {
  // Org id.
  id: string;
  // Slug of the org's namespace (for URLs).
  slug: string;
  name: string;
}

// Slack-style org discovery: return orgs the user *could* explicitly join based on a
// verified-domain + auto-grouping match, but is not currently an ACTIVE member of.
export async function listDiscoverableOrgs(
  userId: string,
  email: string,
): Promise<DiscoverableOrg[]> {
  const domain = emailDomain(email);
  if (!domain) return [];

  const verified = await db
    .select()
    .from(verifiedDomains)
    .where(eq(verifiedDomains.domain, domain));
  if (verified.length === 0) return [];

  const candidateOrgIds = verified.map((v) => v.orgId);
  const candidates = await db
    .select({
      id: orgs.id,
      name: orgs.name,
      autoGroupingEnabled: orgs.autoGroupingEnabled,
      namespaceId: orgs.namespaceId,
      slug: namespaces.slug,
    })
    .from(orgs)
    .innerJoin(namespaces, eq(namespaces.id, orgs.namespaceId))
    .where(
      and(
        inArray(orgs.id, candidateOrgIds),
        eq(orgs.autoGroupingEnabled, true),
      ),
    );
  if (candidates.length === 0) return [];

  const existingActive = await db
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.status, "active"),
        inArray(
          orgMemberships.orgId,
          candidates.map((a) => a.id),
        ),
      ),
    );
  const activeIds = new Set(existingActive.map((m) => m.orgId));

  return candidates
    .filter((a) => !activeIds.has(a.id))
    .map((a) => ({ id: a.id, slug: a.slug, name: a.name }));
}

export async function joinOrgByDomain(
  userId: string,
  email: string,
  orgId: string,
): Promise<Mutated<OrgMembership>> {
  const domain = emailDomain(email);
  if (!domain) {
    throw new ValidationError("User has no parseable email domain");
  }

  const org = await db.query.orgs.findFirst({
    where: eq(orgs.id, orgId),
  });
  if (!org) {
    throw new NotFoundError(`Org ${orgId} not found`);
  }
  if (!org.autoGroupingEnabled) {
    throw new ValidationError("This Memex does not allow domain-based joins");
  }

  const verified = await db.query.verifiedDomains.findFirst({
    where: and(
      eq(verifiedDomains.domain, domain),
      eq(verifiedDomains.orgId, orgId),
    ),
  });
  if (!verified) {
    throw new ValidationError(
      `Email domain '${domain}' is not verified for this Memex`,
    );
  }

  const memexId = (await primaryMemexIdForOrg(orgId)) ?? "";

  const existing = await db.query.orgMemberships.findFirst({
    where: and(
      eq(orgMemberships.userId, userId),
      eq(orgMemberships.orgId, orgId),
    ),
  });
  if (existing) {
    if (existing.status === "disabled") {
      return mutate(
        {},
        { memexId, userId, entity: "org_membership", action: "updated" },
        async () => {
          const [reactivated] = await db
            .update(orgMemberships)
            .set({ status: "active" })
            .where(eq(orgMemberships.id, existing.id))
            .returning();
          return reactivated;
        },
      );
    }
    // silent: idempotent read-through; existing active membership returned unchanged.
    return mutate(
      {},
      { memexId, userId, entity: "org_membership", action: "updated" },
      async () => existing,
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId, userId, entity: "org_membership", action: "created" },
    async () => {
      const [membership] = await db
        .insert(orgMemberships)
        .values({ userId, orgId, role: "member" })
        .returning();
      return membership;
    },
  );
}

export async function joinByDomain(
  userId: string,
  email: string,
): Promise<Mutated<OrgMembership | null>> {
  const domain = emailDomain(email);
  // silent: nothing matched — no DB write, no UI consequence.
  if (!domain) {
    return mutate({}, { memexId: "", userId, entity: "org_membership", action: "created" },
      async () => null, { silent: true });
  }

  const verified = await db.query.verifiedDomains.findFirst({
    where: eq(verifiedDomains.domain, domain),
  });
  if (!verified) {
    return mutate({}, { memexId: "", userId, entity: "org_membership", action: "created" },
      async () => null, { silent: true });
  }

  const org = await db.query.orgs.findFirst({
    where: eq(orgs.id, verified.orgId),
  });
  if (!org || !org.autoGroupingEnabled) {
    return mutate({}, { memexId: "", userId, entity: "org_membership", action: "created" },
      async () => null, { silent: true });
  }

  const memexId = (await primaryMemexIdForOrg(org.id)) ?? "";

  const existing = await db.query.orgMemberships.findFirst({
    where: and(
      eq(orgMemberships.userId, userId),
      eq(orgMemberships.orgId, org.id),
    ),
  });
  if (existing) {
    if (existing.status === "disabled") {
      return mutate(
        {},
        { memexId, userId, entity: "org_membership", action: "updated" },
        async () => {
          const [reactivated] = await db
            .update(orgMemberships)
            .set({ status: "active" })
            .where(eq(orgMemberships.id, existing.id))
            .returning();
          return reactivated;
        },
      );
    }
    // silent: idempotent read-through; existing active membership returned unchanged.
    return mutate(
      {},
      { memexId, userId, entity: "org_membership", action: "updated" },
      async () => existing,
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId, userId, entity: "org_membership", action: "created" },
    async () => {
      const [membership] = await db
        .insert(orgMemberships)
        .values({
          userId,
          orgId: org.id,
          role: "member",
        })
        .returning();
      return membership;
    },
  );
}
