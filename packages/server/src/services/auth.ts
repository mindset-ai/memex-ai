import {
  upsertUserByEmail,
  getUserById,
  listMemberships,
  listMembershipsMatchingDomain,
  type MembershipSummary,
} from "./users.js";
import { upsertVerifiedDomain } from "./verified-domains.js";
import { consumeInviteToken } from "./invite-tokens.js";
// joinByDomain (auto-join via email-domain match) is intentionally NOT imported
// here anymore — std-6 / dec-6 of doc-15 routes domain matches through the
// consent prompt at /api/consent instead.
import { createOrgWithOwner, findOrgsClaimingDomain } from "./orgs.js";
import { ensureUserMemex } from "./user-namespaces.js";
import { ValidationError } from "../types/errors.js";
import type { Memex, OrgMembership } from "../db/schema.js";

// Subset of Google ID token claims we care about. `hd` (hosted domain) is only present
// for Google Workspace users — its presence is the "corporate SSO" signal.
export interface SsoTokenPayload {
  email: string;
  hd?: string;
}

export interface SessionPayload {
  user: {
    id: string;
    email: string;
    name: string | null;
    status: "active" | "disabled";
    emailVerified: boolean;
  };
  memberships: MembershipSummary[];
  // The Memex this session is currently scoped to (null when ambiguous — see std-5).
  currentMemexId: string | null;
  currentRole: "member" | "administrator" | null;
  needsOnboarding: boolean;
  /** Server-driven feature-hide list (slugs the client should suppress). Sourced
   * from the HIDDEN_FEATURES env var via getHiddenFeatures(); fail-open ([]) when
   * unset. Reusable foundation for spec-147/spec-148. */
  hiddenFeatures: string[];
  /** Server-issued JWT the client stores as `memex-auth-token`. Omitted when the
   * session is refreshed via /api/auth/me (the caller already has the token). */
  token?: string;
}

// Parses the HIDDEN_FEATURES env var (comma-separated feature slugs) into a list.
// Fail-open: an unset or empty var yields [] — never throws, never hides by default.
// Kept here as the single reusable parse site for sibling specs (spec-147/spec-148).
export function getHiddenFeatures(): string[] {
  return (process.env.HIDDEN_FEATURES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export class MemexAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemexAccessError";
  }
}

export class DisabledUserError extends Error {
  constructor(email: string) {
    super(`User ${email} is disabled and cannot sign in`);
    this.name = "DisabledUserError";
  }
}

function pickCurrentMemex(
  memberships: MembershipSummary[],
  requestedMemexId?: string | null
): MembershipSummary | null {
  if (requestedMemexId) {
    const match = memberships.find((m) => m.memexId === requestedMemexId);
    if (!match) {
      throw new MemexAccessError(
        `User is not a member of memex ${requestedMemexId}`
      );
    }
    return match;
  }
  // Default to the personal memex when no specific memex is requested. Every user has
  // exactly one personal (enforced by unique(namespace_id)), so this is deterministic.
  // Fallback to first membership for edge cases (e.g. legacy users without a personal yet).
  const personal = memberships.find((m) => m.kind === "personal");
  if (personal) return personal;
  return memberships.length === 1 ? memberships[0] : null;
}

export async function handleSsoLogin(
  payload: SsoTokenPayload,
  requestedMemexId?: string | null
): Promise<SessionPayload> {
  if (!payload.email) {
    throw new ValidationError("SSO token has no email claim");
  }

  const user = await upsertUserByEmail(payload.email);

  if (user.status === "disabled") {
    throw new DisabledUserError(user.email);
  }

  // Every user has a personal memex — provision on first sign-in. Idempotent for returning users.
  await ensureUserMemex(user.id);

  // Auto-verify domain for corporate Workspace SSO (dec-5):
  //   1. For orgs the user is ALREADY a member of where the email_domains list contains
  //      the hd claim → upsert verified_domain (existing behavior from t-2).
  //   2. For orgs that claim the hd in email_domains regardless of membership → also
  //      upsert verified_domain. This is what makes auto-grouping work end-to-end: the
  //      corporate SSO proof verifies the domain even before the user is a member.
  if (payload.hd) {
    // (1) member-org verification — match.orgId is the org id (not the memex id).
    // verified_domains.org_id wants the org, so use orgId here.
    const matches = await listMembershipsMatchingDomain(user.id, payload.hd);
    for (const match of matches) {
      if (match.orgId) {
        await upsertVerifiedDomain(payload.hd, match.orgId, "sso");
      }
    }
    // (2) non-member orgs that claim the domain — verify but only if not already
    // claimed by a different org (ConflictError swallowed silently; existing claim wins).
    const claimingOrgs = await findOrgsClaimingDomain(payload.hd);
    for (const org of claimingOrgs) {
      if (matches.some((m) => m.orgId === org.id)) continue; // already handled in (1)
      try {
        await upsertVerifiedDomain(payload.hd, org.id, "sso");
      } catch {
        // Cross-org claim conflict — first verifier wins, ignore.
      }
    }
  }

  // Slack-style explicit join: we do NOT silently auto-join zero-membership users here.
  // The domain-match + auto-grouping memex is surfaced via /api/consent/pending and
  // the user chooses to join on the consent dialog. Historically this was automatic
  // (joinByDomain on login), but that hid the memex decision from new corporate users.
  const memberships = await listMemberships(user.id);

  const current = pickCurrentMemex(memberships, requestedMemexId);

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name ?? null,
      status: user.status as "active" | "disabled",
      emailVerified: !!user.emailVerifiedAt,
    },
    memberships,
    currentMemexId: current?.memexId ?? null,
    currentRole: current?.role ?? null,
    needsOnboarding: !user.name,
    hiddenFeatures: getHiddenFeatures(),
  };
}

export class NoMemexAvailableError extends Error {
  constructor() {
    super(
      "Sign-up requires an invite link or a matching verified domain — ask your admin to send one"
    );
    this.name = "NoMemexAvailableError";
  }
}

// Signup helper: creates a brand-new org with the calling user as the first administrator,
// then returns the updated session payload. Per dec-1 of doc-19 the new org has no
// Memex; resolveSession returns the user's personal Memex as currentMemexId until
// they add a Memex inside the org.
export async function createOrgAndSession(
  userId: string,
  _email: string,
  // referralShareTokenId is dropped per dec-10 of doc-15. Kept in the interface as a
  // no-op so callers that still pass it compile cleanly.
  input: { slug: string; name?: string; referralShareTokenId?: string | null },
): Promise<{ session: SessionPayload; membership: OrgMembership }> {
  const { membership } = await createOrgWithOwner({
    slug: input.slug,
    name: input.name,
    ownerUserId: userId,
  });
  const session = await resolveSession(userId);
  return { session, membership };
}

// Signup helper: joins an existing org via invite token only.
// Per std-6 / dec-6 of doc-15, domain-based auto-join is REMOVED from this
// path — users with a matching verified domain see a consent prompt via
// /api/consent/pending and explicitly accept. Without an invite token, this
// helper throws NoMemexAvailableError; the React UI is expected to land the
// user in their personal namespace instead.
export async function joinExistingOrg(
  userId: string,
  _email: string,
  token?: string | null
): Promise<{ session: SessionPayload; membership: OrgMembership }> {
  let membership: OrgMembership | null = null;

  if (token) {
    membership = await consumeInviteToken(token, userId);
  }
  // No token → no auto-join. Caller routes the user to the consent flow or
  // their personal namespace.

  if (!membership) {
    throw new NoMemexAvailableError();
  }

  // membership.orgId points at the org; resolveSession picks the appropriate memex
  // (the user's chosen workspace inside that org). Pass null to defer the choice to
  // pickCurrentMemex's defaults.
  const session = await resolveSession(userId, null);
  return { session, membership };
}

// Used by switch-memex: re-resolve session for an existing user, validating the new memex.
export async function resolveSession(
  userId: string,
  requestedMemexId?: string | null
): Promise<SessionPayload> {
  const user = await getUserById(userId);
  if (!user) {
    throw new ValidationError(`User ${userId} not found`);
  }
  if (user.status === "disabled") {
    throw new DisabledUserError(user.email);
  }

  const memberships = await listMemberships(user.id);
  const current = pickCurrentMemex(memberships, requestedMemexId);

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name ?? null,
      status: user.status as "active" | "disabled",
      emailVerified: !!user.emailVerifiedAt,
    },
    memberships,
    currentMemexId: current?.memexId ?? null,
    currentRole: current?.role ?? null,
    needsOnboarding: !user.name,
    hiddenFeatures: getHiddenFeatures(),
  };
}
