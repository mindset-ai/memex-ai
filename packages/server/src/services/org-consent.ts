// Domain-based auto-join consent (std-6 / dec-6 of doc-15).
//
// Replaces the legacy auto-join behaviour where SSO callbacks silently inserted
// org_memberships when the user's email domain matched a verified domain. The
// new flow: SSO returns the matching orgs in the session payload; the React UI
// renders a consent dialog; the user accept/declines/skips; the response is
// recorded sticky per (user, org) pair.
//
// Hard rules from std-6:
//   - SSO callbacks MUST NOT insert org_memberships unilaterally.
//   - Disabled members are NEVER reactivated through this path.
//   - Skipping is sticky — re-auth doesn't re-prompt the same pair.
//   - When a domain is newly verified, existing matching users see the prompt
//     on their next session (handled by listPendingConsent — it picks up new
//     domain matches automatically).

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  orgConsentResponses,
  orgMemberships,
  orgs,
  users,
  verifiedDomains,
} from "../db/schema.js";
import type { Org } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { primaryMemexIdForOrg } from "./shared/memex-ownership.js";

export interface PendingConsentOrg {
  orgId: string;
  name: string;
  slug: string;
  domain: string;
}

export interface ConsentDecision {
  // Orgs the user has resolved (any response). Suppresses the prompt.
  resolved: Set<string>;
  // Orgs where the user has a disabled membership. Show the "contact admin"
  // notice, not the consent prompt.
  disabled: PendingConsentOrg[];
}

// Returns orgs the user *should* see in a consent prompt:
//   - email domain matches a verified domain on the org (autoGrouping=true)
//   - the user is NOT already an active member of that org
//   - the user has NOT already responded to the prompt for that org
//   - the user is NOT a disabled member (those go to the "contact admin" list)
//
// Surfaces `disabled` separately so the React UI can render a quiet notice
// instead of the consent prompt for those orgs.
export async function listPendingConsent(userId: string): Promise<{
  pending: PendingConsentOrg[];
  disabled: PendingConsentOrg[];
}> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new ValidationError("User not found");
  const emailDomain = user.email.split("@")[1]?.toLowerCase();
  if (!emailDomain) return { pending: [], disabled: [] };

  // Fetch all orgs claiming this domain via verified_domains, joined to
  // namespaces for the slug. Only autoGroupingEnabled=true orgs.
  const candidateRows = await db
    .select({
      orgId: orgs.id,
      orgName: orgs.name,
      slug: sql<string>`(SELECT slug FROM namespaces WHERE namespaces.id = ${orgs.namespaceId})`,
      domain: verifiedDomains.domain,
    })
    .from(verifiedDomains)
    .innerJoin(orgs, eq(verifiedDomains.orgId, orgs.id))
    .where(
      and(
        eq(verifiedDomains.domain, emailDomain),
        eq(orgs.autoGroupingEnabled, true),
      ),
    );

  if (candidateRows.length === 0) return { pending: [], disabled: [] };

  const orgIds = candidateRows.map((r) => r.orgId);

  // Existing memberships and consent responses for these orgs.
  const memberships = await db
    .select()
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.userId, userId),
        sql`${orgMemberships.orgId} = ANY(${sql.raw(`ARRAY[${orgIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`,
      ),
    );

  const responses = await db
    .select()
    .from(orgConsentResponses)
    .where(
      and(
        eq(orgConsentResponses.userId, userId),
        sql`${orgConsentResponses.orgId} = ANY(${sql.raw(`ARRAY[${orgIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`,
      ),
    );

  const respondedOrgIds = new Set(responses.map((r) => r.orgId));
  const activeMemberOrgIds = new Set(
    memberships.filter((m) => m.status === "active").map((m) => m.orgId),
  );
  const disabledMemberOrgIds = new Set(
    memberships.filter((m) => m.status === "disabled").map((m) => m.orgId),
  );

  const pending: PendingConsentOrg[] = [];
  const disabled: PendingConsentOrg[] = [];

  for (const row of candidateRows) {
    if (activeMemberOrgIds.has(row.orgId)) continue; // already a member
    if (respondedOrgIds.has(row.orgId)) continue; // already resolved
    const card: PendingConsentOrg = {
      orgId: row.orgId,
      name: row.orgName,
      slug: row.slug,
      domain: row.domain,
    };
    if (disabledMemberOrgIds.has(row.orgId)) {
      // std-6: never silently re-enable. The user gets a "contact admin"
      // notice for these, NOT a consent prompt.
      disabled.push(card);
    } else {
      pending.push(card);
    }
  }
  return { pending, disabled };
}

// Records a 'accepted' response and inserts the org_memberships row.
// Idempotent: re-calling for the same (user, org) is a no-op.
export async function acceptConsent(userId: string, orgId: string): Promise<Mutated<void>> {
  // Re-validate the user is eligible (TOCTOU defence — the domain claim could
  // have been removed between prompt-list fetch and this call). If they're no
  // longer eligible, accept does nothing.
  const { pending } = await listPendingConsent(userId);
  if (!pending.some((p) => p.orgId === orgId)) {
    // Not pending anymore — could be already a member, already declined, or
    // the org dropped the domain claim. Idempotent silent no-op.
    // silent: no DB write occurred; nothing to refetch.
    return mutate(
      {},
      { memexId: "", userId, entity: "org_consent", action: "created" },
      async () => {},
      { silent: true },
    );
  }

  const memexId = (await primaryMemexIdForOrg(orgId)) ?? "";

  // Composite: one membership insert + one consent-response upsert. Per
  // std-8 dec-2 each logical change emits independently. userId tags both
  // so the affected user's /api/me/events sees them and the React UI
  // refetches memberships + consent list.
  return mutate(
    {},
    [
      { memexId, userId, entity: "org_membership", action: "created" },
      { memexId, userId, entity: "org_consent", action: "created" },
    ],
    async () => {
      await db.transaction(async (tx) => {
        await tx
          .insert(orgMemberships)
          .values({
            userId,
            orgId,
            role: "member",
            status: "active",
          })
          .onConflictDoNothing();
        await tx
          .insert(orgConsentResponses)
          .values({ userId, orgId, response: "accepted" })
          .onConflictDoUpdate({
            target: [orgConsentResponses.userId, orgConsentResponses.orgId],
            set: { response: "accepted", respondedAt: new Date() },
          });
      });
    },
  );
}

// Records a 'declined' or 'skipped' response (sticky per std-6). No membership
// row. Idempotent.
export async function recordConsentDismissal(
  userId: string,
  orgId: string,
  response: "declined" | "skipped",
): Promise<Mutated<void>> {
  const memexId = (await primaryMemexIdForOrg(orgId)) ?? "";
  return mutate(
    {},
    { memexId, userId, entity: "org_consent", action: "created" },
    async () => {
      await db
        .insert(orgConsentResponses)
        .values({ userId, orgId, response })
        .onConflictDoNothing();
    },
  );
}

// Bulk variant for the React UI's multi-select dialog.
export async function applyConsentDecisions(
  userId: string,
  decisions: Array<{ orgId: string; response: "accepted" | "declined" | "skipped" }>,
): Promise<void> {
  // Delegates to acceptConsent / recordConsentDismissal which each go through
  // mutate(); this wrapper has no DB write of its own.
  for (const d of decisions) {
    if (d.response === "accepted") {
      await acceptConsent(userId, d.orgId);
    } else {
      await recordConsentDismissal(userId, d.orgId, d.response);
    }
  }
}
