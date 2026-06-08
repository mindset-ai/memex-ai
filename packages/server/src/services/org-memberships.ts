// Admin-driven membership mutations: enable/disable members, promote/demote roles,
// last-admin guards. Discovery + auto-join flows live in org-discovery.ts.

import { and, eq, count, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { orgMemberships, shareTokens, documents, memexes, namespaces } from "../db/schema.js";
import type { OrgMembership } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";
import type { Role } from "../types/roles.js";
import { mutate, type Mutated } from "./mutate.js";
import { primaryMemexIdForOrg } from "./shared/memex-ownership.js";

// Membership events fire on the org's primary memex (the first memex under
// the org's namespace) so the Memex switcher in any tab in that namespace
// refetches. Per the Reactivity Standard, org_membership is its own entity.
async function memexKeyForOrg(orgId: string): Promise<string> {
  const id = await primaryMemexIdForOrg(orgId);
  // Empty-string fallback keeps the emit shape valid in pathological states
  // (no memex under the namespace); subscribers filter on memexId and simply
  // won't match. By std-1 invariant this branch isn't reachable in production.
  return id ?? "";
}

export class MembershipActionError extends ValidationError {
  constructor(
    public readonly code:
      | "last_admin"
      | "cannot_remove_self"
      | "not_found"
      | "invalid_role",
    message: string,
  ) {
    super(message);
    this.name = "MembershipActionError";
  }
}

// Counts the active administrators of an org. Used by last-admin guards.
export async function countActiveAdmins(orgId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, orgId),
        eq(orgMemberships.role, "administrator"),
        eq(orgMemberships.status, "active"),
      ),
    );
  return Number(row?.value ?? 0);
}

async function getMembership(
  userId: string,
  orgId: string,
): Promise<OrgMembership | undefined> {
  return db.query.orgMemberships.findFirst({
    where: and(
      eq(orgMemberships.userId, userId),
      eq(orgMemberships.orgId, orgId),
    ),
  });
}

export async function disableMembership(
  targetUserId: string,
  orgId: string,
  requesterId: string,
): Promise<Mutated<OrgMembership>> {
  if (targetUserId === requesterId) {
    throw new MembershipActionError(
      "cannot_remove_self",
      "You cannot remove yourself from the org",
    );
  }

  const target = await getMembership(targetUserId, orgId);
  if (!target) {
    throw new MembershipActionError("not_found", "User is not a member of this org");
  }

  const memexId = await memexKeyForOrg(orgId);

  if (target.status === "disabled") {
    return mutate(
      {},
      { memexId, userId: targetUserId, entity: "org_membership", action: "deleted" },
      async () => target,
      { silent: true },
    );
  }

  if (target.role === "administrator") {
    const adminCount = await countActiveAdmins(orgId);
    if (adminCount <= 1) {
      throw new MembershipActionError(
        "last_admin",
        "Cannot remove the last administrator — promote another user first",
      );
    }
  }

  return mutate(
    {},
    { memexId, entity: "org_membership", action: "deleted" },
    async () => {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(orgMemberships)
          .set({ status: "disabled" })
          .where(eq(orgMemberships.id, target.id))
          .returning();

        // Bulk-revoke all share tokens this user created within the org (spec-199 t-3).
        // The subquery walks: documents → memexes → namespaces → ownerOrgId = orgId.
        await tx
          .update(shareTokens)
          .set({ revoked: true })
          .where(
            and(
              eq(shareTokens.createdByUserId, targetUserId),
              eq(shareTokens.revoked, false),
              inArray(
                shareTokens.documentId,
                db
                  .select({ id: documents.id })
                  .from(documents)
                  .innerJoin(memexes, eq(memexes.id, documents.memexId))
                  .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
                  .where(eq(namespaces.ownerOrgId, orgId)),
              ),
            ),
          );

        return updated;
      });
    },
  );
}

export async function enableMembership(
  targetUserId: string,
  orgId: string,
): Promise<Mutated<OrgMembership>> {
  const target = await getMembership(targetUserId, orgId);
  if (!target) {
    throw new MembershipActionError("not_found", "User is not a member of this org");
  }
  const memexId = await memexKeyForOrg(orgId);

  if (target.status === "active") {
    return mutate(
      {},
      { memexId, userId: targetUserId, entity: "org_membership", action: "created" },
      async () => target,
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId, entity: "org_membership", action: "created" },
    async () => {
      const [updated] = await db
        .update(orgMemberships)
        .set({ status: "active" })
        .where(eq(orgMemberships.id, target.id))
        .returning();
      return updated;
    },
  );
}

export async function updateMembershipRole(
  targetUserId: string,
  orgId: string,
  newRole: Role,
  _requesterId: string,
): Promise<Mutated<OrgMembership>> {
  if (newRole !== "member" && newRole !== "administrator") {
    throw new MembershipActionError("invalid_role", `Unknown role '${newRole}'`);
  }

  const target = await getMembership(targetUserId, orgId);
  if (!target) {
    throw new MembershipActionError("not_found", "User is not a member of this org");
  }
  if (target.status !== "active") {
    throw new MembershipActionError(
      "not_found",
      "Cannot change role of a disabled member — re-enable them first",
    );
  }
  const memexId = await memexKeyForOrg(orgId);

  if (target.role === newRole) {
    return mutate(
      {},
      { memexId, userId: targetUserId, entity: "org_membership", action: "updated" },
      async () => target,
      { silent: true },
    );
  }

  if (target.role === "administrator" && newRole === "member") {
    const adminCount = await countActiveAdmins(orgId);
    if (adminCount <= 1) {
      throw new MembershipActionError(
        "last_admin",
        "Cannot demote the last administrator — promote another user first",
      );
    }
  }

  return mutate(
    {},
    { memexId, entity: "org_membership", action: "updated" },
    async () => {
      const [updated] = await db
        .update(orgMemberships)
        .set({ role: newRole })
        .where(eq(orgMemberships.id, target.id))
        .returning();
      return updated;
    },
  );
}
