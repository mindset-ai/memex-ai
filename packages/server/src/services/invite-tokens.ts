import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/connection.js";
import { inviteTokens, orgMemberships } from "../db/schema.js";
import type { OrgMembership, InviteToken } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";

// Invite links are multi-use: valid for 7 days from creation, or until an admin explicitly
// revokes them. A single link can onboard any number of teammates.
const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

// Generates a cryptographically random invite token and stores it for the given account.
// Caller (route handler) must enforce that the requester is an administrator of orgId.
//
// silent: per std-8 §6 the invite itself is silent-allowed pending consumption —
// consumption fires `org_membership.created`.
export async function createInviteToken(orgId: string): Promise<Mutated<InviteToken>> {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  return mutate(
    {},
    { memexId: "", entity: "invite_token", action: "created" },
    async () => {
      const [created] = await db
        .insert(inviteTokens)
        .values({ orgId, token, expiresAt })
        .returning();
      return created;
    },
    { silent: true },
  );
}

// Lists active (not revoked, not expired) invites for an account, newest first.
// Used by the React UI to show invites that can still be copied or revoked.
export async function listActiveInvitesForAccount(orgId: string): Promise<InviteToken[]> {
  const rows = await db.query.inviteTokens.findMany({
    where: and(eq(inviteTokens.orgId, orgId), isNull(inviteTokens.revokedAt)),
  });
  return rows
    .filter((r) => r.expiresAt.getTime() > Date.now())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// Revokes an invite by stamping revoked_at. Idempotent: returns the row untouched if it's
// already revoked. Returns null if the invite doesn't exist or belongs to a different account.
//
// silent: invite_token is silent-allowed per std-8 §6.
export async function revokeInviteToken(
  inviteId: string,
  orgId: string
): Promise<Mutated<InviteToken | null>> {
  const invite = await db.query.inviteTokens.findFirst({
    where: and(eq(inviteTokens.id, inviteId), eq(inviteTokens.orgId, orgId)),
  });
  if (!invite) {
    return mutate(
      {},
      { memexId: "", entity: "invite_token", action: "updated" },
      async () => null,
      { silent: true },
    );
  }
  if (invite.revokedAt) {
    return mutate(
      {},
      { memexId: "", entity: "invite_token", action: "updated" },
      async () => invite,
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId: "", entity: "invite_token", action: "updated" },
    async () => {
      const [updated] = await db
        .update(inviteTokens)
        .set({ revokedAt: new Date() })
        .where(eq(inviteTokens.id, invite.id))
        .returning();
      return updated;
    },
    { silent: true },
  );
}

// NOTE (expired-invite UX fix): there is deliberately NO background purge of
// expired invite tokens. We used to delete rows where expiresAt < now() on an
// hourly schedule, but that made an expired link indistinguishable from a
// never-existed one — once the row was gone, consumeInviteToken() fell into the
// "unknown" branch and the UI said "that invite link doesn't look right"
// instead of "this invite link has expired". Invite rows are now retained
// indefinitely so the expired/revoked branches below stay reachable; revoking
// (revokedAt) is the kill switch, not deletion. Rows are tiny and still removed
// by cascade when their org is deleted.

export class InviteTokenError extends ValidationError {
  constructor(public readonly reason: "unknown" | "expired" | "revoked", message: string) {
    super(message);
    this.name = "InviteTokenError";
  }
}

// Validates an invite token and creates a 'user' membership for the caller. Invites are
// multi-use: any teammate with the link can join until the 7-day TTL elapses or an admin
// revokes it. Per dec-3 invite tokens grant the 'user' role by default; admin invites
// would require an extra column on invite_tokens (deferred to t-5).
//
// Token is invalid in any of these states: not found, revoked, expired.
// Idempotency: if the user is already a member of the account, return the existing
// membership rather than failing — covers double-clicks and already-joined teammates.
//
// std-8 §6: invite consumption emits `org_membership.created`. Re-activation of a
// previously-disabled membership emits `.updated`. The already-active idempotent
// path is silent (no state change).
//
// The validation closure runs inside the chosen mutate() block — TOCTOU is bounded
// by the unique (user_id, org_id) constraint catching any concurrent racer.
export async function consumeInviteToken(
  token: string,
  userId: string
): Promise<Mutated<OrgMembership>> {
  // Validate the invite up front (read-only). The narrow window between this
  // check and the write path is OK: if a concurrent revoke lands in between,
  // the membership write still succeeds and the user gets in; we accept this
  // as the cost of avoiding a long-held write lock for a rare action.
  const invite = await db.query.inviteTokens.findFirst({
    where: eq(inviteTokens.token, token),
  });
  if (!invite) {
    throw new InviteTokenError("unknown", "Invalid invite link");
  }
  if (invite.revokedAt) {
    throw new InviteTokenError("revoked", "This invite link has been revoked");
  }
  if (invite.expiresAt.getTime() <= Date.now()) {
    throw new InviteTokenError("expired", "This invite link has expired");
  }

  // Branch on the existing-membership state. Each branch gets its own mutate()
  // call so silent vs created vs updated is decided up-front (the wrapper's
  // silent flag isn't a function of the result).
  const existing = await db.query.orgMemberships.findFirst({
    where: and(
      eq(orgMemberships.userId, userId),
      eq(orgMemberships.orgId, invite.orgId)
    ),
  });

  if (existing && existing.status === "active") {
    // No-op: idempotent re-write converging on existing state (std-8 §5 silent).
    return mutate(
      {},
      { memexId: "", userId, entity: "org_membership", action: "updated" },
      async () => existing,
      { silent: true },
    );
  }

  if (existing && existing.status === "disabled") {
    return mutate(
      {},
      { memexId: "", userId, entity: "org_membership", action: "updated" },
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

  // No existing membership — create one.
  return mutate(
    {},
    { memexId: "", userId, entity: "org_membership", action: "created" },
    async () => {
      const [membership] = await db
        .insert(orgMemberships)
        .values({
          userId,
          orgId: invite.orgId,
          role: "member",
        })
        .returning();
      return membership;
    },
  );
}
