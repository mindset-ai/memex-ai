import { eq, and, sql, asc } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, orgMemberships, namespaces, orgs, memexes, userMemexAccess } from "../db/schema.js";
import type { User } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";

export interface MembershipSummary {
  // Memex id (the "current memex" in tenancy contexts).
  memexId: string;
  // Memex's own display name (memexes.name). Distinct from `name` which holds
  // the Org name for team rows. Same as `name` for personal rows.
  memexName: string;
  // Slug of the namespace (URL identity).
  slug: string;
  // Slug of the memex inside the namespace. Combined with `slug`, this is the
  // pair the React UI passes into the path-prefixed API surface:
  // /api/<slug>/<memexSlug>/...  (per dec-3 / F.3 of doc-15 → t-18).
  // Personal memexes use the literal slug "personal"; org-created memexes
  // default to "main" today. Added in t-18 so the client doesn't have to
  // hard-code the convention.
  memexSlug: string;
  name: string;
  kind: "personal" | "team";
  role: "member" | "administrator";
  // Org id — populated for kind='team' rows; null/absent for personal namespaces.
  // Callers that need to write into org-scoped tables (verifiedDomains.orgId,
  // inviteTokens.orgId) need this rather than `memexId` (which is the memex
  // id, not the org id).
  orgId?: string | null;
  // Access provenance (spec-111). `org` rows come from a personal namespace or
  // an active org membership — full read+write (std-4). `visited` rows come from
  // `user_memex_access` — a signed-in NON-member's pin on a public memex,
  // read-only. The UI uses this to render the "Visited" group with a 🌐 +
  // read-only badge and to suppress edit/create controls.
  //
  // Optional on the type so legacy constructors (test fixtures, pre-spec-111
  // call sites) still type-check; every row `listMemberships` /
  // `listMembershipsMatchingDomain` produces sets it explicitly. Treat an
  // absent value as 'org' (full-access) — the read-only path is opt-IN via an
  // explicit 'visited'/'read', never inferred from absence.
  source?: "org" | "visited";
  // Effective access level for this row. 'write' for org rows (std-4 members),
  // 'read' for visited public memexes. Distinct from `role` (which is the
  // user's org role, meaningless for non-members). Optional for the same
  // back-compat reason as `source`; absent ⇒ treat as 'write' (org default).
  accessLevel?: "read" | "write";
  // The Memex's own visibility (spec-111 t-8). Rides on the membership row so
  // the React UI can light the 🌐 public badge next to the Memex name in the
  // header without a second fetch. Optional for back-compat (pre-spec-111
  // sessions / fixtures); absent ⇒ render no badge.
  visibility?: "public" | "private";
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  return db.query.users.findFirst({
    where: eq(users.email, normalizeEmail(email)),
  });
}

export async function getUserById(id: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}

export async function upsertUserByEmail(email: string): Promise<User> {
  const normalized = normalizeEmail(email);

  const existing = await getUserByEmail(normalized);
  if (existing) {
    const [updated] = await db
      .update(users)
      .set({ updatedAt: new Date() })
      .where(eq(users.id, existing.id))
      .returning();
    return updated;
  }

  // Note: users.namespace_id is NOT NULL — callers must follow up with
  // ensureUserNamespace from user-namespaces.ts. This insert path is currently used
  // only by tests / SSO upserts; we work around the constraint by leaving creation to
  // the auth service, which orchestrates user-row + namespace creation in one tx.
  // For tests that hit this directly, they must seed a namespace first. To keep
  // typecheck happy we cast.
  // ON CONFLICT makes the insert race-safe: parallel requests on a cold DB
  // (e.g. the dev-user bootstrap when a browser fires several API calls at
  // once on first load) all pass the select above, then all insert — without
  // this, every loser throws users_email_unique. With it, the loser's insert
  // degrades to the same touch-updated_at the existing-row path does.
  const [created] = await db
    .insert(users)
    .values({ email: normalized } as typeof users.$inferInsert)
    .onConflictDoUpdate({
      target: users.email,
      set: { updatedAt: new Date() },
    })
    .returning();
  return created;
}

export async function updateUserProfile(
  userId: string,
  fields: { name: string },
): Promise<User> {
  const trimmed = fields.name.trim();
  if (!trimmed) throw new ValidationError("Name is required");
  if (trimmed.length > 100) throw new ValidationError("Name must be 100 characters or fewer");

  const [updated] = await db
    .update(users)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  if (!updated) throw new ValidationError(`User ${userId} not found`);
  return updated;
}

export async function createUserWithPassword(input: {
  email: string;
  passwordHash: string;
}): Promise<User> {
  const normalized = normalizeEmail(input.email);
  const existing = await getUserByEmail(normalized);
  if (existing?.passwordHash) {
    throw new ValidationError("An account with this email already exists");
  }

  if (existing) {
    const [updated] = await db
      .update(users)
      .set({ passwordHash: input.passwordHash, updatedAt: new Date() })
      .where(eq(users.id, existing.id))
      .returning();
    return updated;
  }

  // namespace_id NOT NULL — see comment in upsertUserByEmail. Callers in the auth flow
  // must pair this with ensureUserNamespace in a tx; cast satisfies the type checker.
  const [created] = await db
    .insert(users)
    .values({ email: normalized, passwordHash: input.passwordHash } as typeof users.$inferInsert)
    .returning();
  return created;
}

export async function markEmailVerified(userId: string): Promise<User> {
  const existing = await getUserById(userId);
  if (!existing) throw new ValidationError(`User ${userId} not found`);
  if (existing.emailVerifiedAt) return existing;

  const [updated] = await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return updated;
}

export async function setUserPasswordHash(userId: string, passwordHash: string): Promise<User> {
  const [updated] = await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  if (!updated) throw new ValidationError(`User ${userId} not found`);
  return updated;
}

export interface NamespaceSummary {
  namespaceId: string;
  namespaceSlug: string;
  kind: "personal" | "team";
  orgId?: string;
  // Caller's role within the namespace. Personal namespaces always come back as
  // 'administrator' (the user owns them).
  role: "member" | "administrator";
  memexes: Array<{ memexId: string; memexSlug: string; name: string }>;
}

// One row per namespace the caller can access — personal namespaces (kind='user')
// plus every org the caller has an active membership in. Orgs without any memex
// emit a row with `memexes: []` so the picker can still surface them (per doc-19).
export async function listAccessibleNamespaces(userId: string): Promise<NamespaceSummary[]> {
  // Personal namespace (always exactly one in v1).
  const personalRows = await db
    .select({
      namespaceId: namespaces.id,
      namespaceSlug: namespaces.slug,
      memexId: memexes.id,
      memexSlug: memexes.slug,
      memexName: memexes.name,
    })
    .from(namespaces)
    .leftJoin(memexes, eq(memexes.namespaceId, namespaces.id))
    .where(eq(namespaces.ownerUserId, userId));

  const personal: NamespaceSummary[] = [];
  const byNamespace = new Map<string, NamespaceSummary>();
  for (const r of personalRows) {
    let entry = byNamespace.get(r.namespaceId);
    if (!entry) {
      entry = {
        namespaceId: r.namespaceId,
        namespaceSlug: r.namespaceSlug,
        kind: "personal",
        role: "administrator",
        memexes: [],
      };
      byNamespace.set(r.namespaceId, entry);
      personal.push(entry);
    }
    if (r.memexId && r.memexSlug && r.memexName) {
      entry.memexes.push({
        memexId: r.memexId,
        memexSlug: r.memexSlug,
        name: r.memexName,
      });
    }
  }

  // Org namespaces — one row per (membership, memex) via LEFT JOIN so empty
  // orgs still emit a row.
  const orgRows = await db
    .select({
      namespaceId: namespaces.id,
      namespaceSlug: namespaces.slug,
      orgId: orgs.id,
      role: orgMemberships.role,
      memexId: memexes.id,
      memexSlug: memexes.slug,
      memexName: memexes.name,
    })
    .from(orgMemberships)
    .innerJoin(orgs, eq(orgMemberships.orgId, orgs.id))
    .innerJoin(namespaces, eq(orgs.namespaceId, namespaces.id))
    .leftJoin(memexes, eq(memexes.namespaceId, namespaces.id))
    .where(
      and(
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.status, "active"),
      ),
    );

  const orgList: NamespaceSummary[] = [];
  const orgByNamespace = new Map<string, NamespaceSummary>();
  for (const r of orgRows) {
    let entry = orgByNamespace.get(r.namespaceId);
    if (!entry) {
      entry = {
        namespaceId: r.namespaceId,
        namespaceSlug: r.namespaceSlug,
        kind: "team",
        orgId: r.orgId,
        role: r.role as "member" | "administrator",
        memexes: [],
      };
      orgByNamespace.set(r.namespaceId, entry);
      orgList.push(entry);
    }
    if (r.memexId && r.memexSlug && r.memexName) {
      entry.memexes.push({
        memexId: r.memexId,
        memexSlug: r.memexSlug,
        name: r.memexName,
      });
    }
  }

  return [...personal, ...orgList];
}

// Returns ACTIVE memberships only — disabled members can't access the org, so they
// shouldn't see it in their session/switcher. Re-enabling is admin-driven.
//
// Each row is keyed on a memex the user can reach (memexes joined via
// org → namespace → memexes). Plus the user's personal Memex (their own namespace).
// Orgs with zero memexes produce zero rows — use listAccessibleNamespaces if
// the caller needs to surface empty orgs.
export async function listMemberships(userId: string): Promise<MembershipSummary[]> {
  const orgRows = await db
    .select({
      memexId: memexes.id,
      orgId: orgs.id,
      slug: namespaces.slug,
      memexSlug: memexes.slug,
      name: orgs.name,
      memexName: memexes.name,
      visibility: memexes.visibility,
      role: orgMemberships.role,
    })
    .from(orgMemberships)
    .innerJoin(orgs, eq(orgMemberships.orgId, orgs.id))
    .innerJoin(namespaces, eq(orgs.namespaceId, namespaces.id))
    .innerJoin(memexes, eq(memexes.namespaceId, namespaces.id))
    .where(
      and(
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.status, "active"),
      ),
    );

  const orgMembershipSummaries: MembershipSummary[] = orgRows.map((row) => ({
    memexId: row.memexId,
    orgId: row.orgId,
    slug: row.slug,
    memexSlug: row.memexSlug,
    name: row.name,
    memexName: row.memexName,
    kind: "team" as const,
    role: row.role as "member" | "administrator",
    source: "org" as const,
    accessLevel: "write" as const,
    visibility: row.visibility as "public" | "private",
  }));

  // Personal namespace memex (user-owned).
  const personal = await db
    .select({
      memexId: memexes.id,
      slug: namespaces.slug,
      memexSlug: memexes.slug,
      name: memexes.name,
      visibility: memexes.visibility,
    })
    .from(namespaces)
    .innerJoin(memexes, eq(memexes.namespaceId, namespaces.id))
    .where(eq(namespaces.ownerUserId, userId));

  const personalMemberships: MembershipSummary[] = personal.map((p) => ({
    memexId: p.memexId,
    slug: p.slug,
    memexSlug: p.memexSlug,
    name: p.name,
    memexName: p.name,
    kind: "personal" as const,
    role: "administrator" as const,
    source: "org" as const,
    accessLevel: "write" as const,
    visibility: p.visibility as "public" | "private",
  }));

  // Visited public memexes (spec-111 t-6). A signed-in non-member who visits a
  // public memex gets a `user_memex_access` pin (see recordPublicMemexVisit).
  // These are STRICTLY non-org — joined here so the list surfaces a read-only
  // "Visited" group alongside the org memexes. We exclude any memex the user
  // already reaches via org membership / personal ownership so a member who
  // happens to also have a stale pin never sees a duplicate read-only row.
  const orgReachableIds = new Set<string>([
    ...orgMembershipSummaries.map((m) => m.memexId),
    ...personalMemberships.map((m) => m.memexId),
  ]);

  const visitedRows = await db
    .select({
      memexId: memexes.id,
      slug: namespaces.slug,
      memexSlug: memexes.slug,
      memexName: memexes.name,
      visibility: memexes.visibility,
    })
    .from(userMemexAccess)
    .innerJoin(memexes, eq(userMemexAccess.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(userMemexAccess.userId, userId));

  const visitedMemberships: MembershipSummary[] = visitedRows
    .filter((r) => !orgReachableIds.has(r.memexId))
    .map((r) => ({
      memexId: r.memexId,
      slug: r.slug,
      memexSlug: r.memexSlug,
      name: r.memexName,
      memexName: r.memexName,
      kind: "team" as const,
      // Non-members have no org role; 'member' is the lowest-privilege label.
      // `source`/`accessLevel` are the load-bearing read-only signal, not `role`.
      role: "member" as const,
      source: "visited" as const,
      // The table CHECK fixes access_level to 'read'; there is no write path
      // through user_memex_access (write still requires org membership).
      accessLevel: "read" as const,
      // A visited row only exists for a PUBLIC memex (recordPublicMemexVisit is
      // gated on visibility), but carry the real column value rather than a
      // hard-coded 'public' so a since-flipped memex reads honestly.
      visibility: r.visibility as "public" | "private",
    }));

  return [...personalMemberships, ...orgMembershipSummaries, ...visitedMemberships];
}

// Record that a signed-in NON-member has visited a public memex (spec-111 t-6).
//
// First visit inserts a `user_memex_access` pin; repeat visits are a no-op via
// ON CONFLICT DO NOTHING on the composite (user_id, memex_id) PK. The mutation
// flows through mutate() per std-8: on a genuinely new pin we emit a
// user-scoped `memex` `created` event so the caller's /api/me/events stream
// refreshes the "Visited" group in real time. A re-visit (zero rows inserted)
// goes through mutate() too — preserving the wrapper invariant + write
// counter — but is emitted `silent` so the Pulse feed and /api/me/events don't
// see a phantom "created" on every page load.
//
// Callers MUST gate this behind a public-visibility + non-member check; this
// helper does not re-check authorization (it is the write side of an already
// authorized public read). access_level is fixed to 'read' by the table CHECK.
//
// Returns `{ inserted }` so the caller can tell a first visit from a re-visit
// (e.g. for analytics) without a second query.
export async function recordPublicMemexVisit(
  userId: string,
  memexId: string,
): Promise<Mutated<{ inserted: boolean }>> {
  // Pre-check existence so we can decide up front whether the bus emission is
  // user-observable (new pin) or a silent re-visit. Mirrors the idempotent
  // fast-path pattern in user-namespaces.ts:ensureUserNamespace — the existence
  // probe selects the silent flag, the actual write lives inside mutate()'s fn.
  const existing = await db
    .select({ memexId: userMemexAccess.memexId })
    .from(userMemexAccess)
    .where(and(eq(userMemexAccess.userId, userId), eq(userMemexAccess.memexId, memexId)))
    .limit(1);
  const alreadyPinned = existing.length > 0;

  // The write itself stays inside mutate()'s fn() (std-8). ON CONFLICT DO
  // NOTHING guards the insert even if a concurrent request pinned between the
  // probe and the write — the composite PK makes the second insert a no-op.
  return mutate(
    { channel: "rest_ui" },
    { memexId, userId, entity: "memex", action: "created" },
    async () => {
      const rows = await db
        .insert(userMemexAccess)
        .values({ userId, memexId, accessLevel: "read" })
        .onConflictDoNothing()
        .returning({ memexId: userMemexAccess.memexId });
      return { inserted: rows.length > 0 };
    },
    // A re-visit is not user-observable: suppress the emission. A first visit
    // emits a user-scoped `memex` `created` so /api/me/events refreshes the
    // "Visited" group in real time.
    { silent: alreadyPinned },
  );
}

export interface OrgMember {
  userId: string;
  email: string;
  role: "member" | "administrator";
  status: "active" | "disabled";
  joinedAt: Date;
}

// Lists ALL members (active + disabled) of an org for the admin configuration UI.
export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      role: orgMemberships.role,
      status: orgMemberships.status,
      joinedAt: orgMemberships.joinedAt,
    })
    .from(orgMemberships)
    .innerJoin(users, eq(orgMemberships.userId, users.id))
    .where(eq(orgMemberships.orgId, orgId))
    .orderBy(asc(users.email));

  return rows.map((r) => ({
    ...r,
    role: r.role as "member" | "administrator",
    status: r.status as "active" | "disabled",
  }));
}

// spec-64 t-2 (ac-19): resolve an `@<name>` token to active org members.
// The omnibox's "assigned to @<name>" lane needs name → user(s), and the
// Specs board already labels a person by `users.name || users.email` (the
// `personLabel` helper in admin SpecList.tsx). We mirror that here: match
// `name` case-insensitively as a substring, OR the email LOCAL PART (before the
// `@`) — so `@ryan` resolves whether the org stores a display name or only an
// email. Scoped to ACTIVE members of `orgId` (disabled members can't be a live
// responsibility pointer; mirrors team.ts's active-only member list). Returns
// every match — the caller (search route) unions their assigned Specs, so an
// ambiguous `@al` that matches two Alexes shows both people's work rather than
// silently picking one.
export async function resolveOrgMembersByName(
  orgId: string,
  name: string,
): Promise<OrgMember[]> {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return [];
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      role: orgMemberships.role,
      status: orgMemberships.status,
      joinedAt: orgMemberships.joinedAt,
    })
    .from(orgMemberships)
    .innerJoin(users, eq(orgMemberships.userId, users.id))
    .where(
      and(
        eq(orgMemberships.orgId, orgId),
        eq(orgMemberships.status, "active"),
        sql`(
          lower(coalesce(${users.name}, '')) LIKE ${pattern} ESCAPE '\\'
          OR lower(split_part(${users.email}, '@', 1)) LIKE ${pattern} ESCAPE '\\'
        )`,
      ),
    )
    .orderBy(asc(users.email));

  return rows.map((r) => ({
    ...r,
    role: r.role as "member" | "administrator",
    status: r.status as "active" | "disabled",
  }));
}

// Returns memberships whose org's email_domains array contains the given domain.
export async function listMembershipsMatchingDomain(
  userId: string,
  domain: string,
): Promise<MembershipSummary[]> {
  const rows = await db
    .select({
      memexId: memexes.id,
      orgId: orgs.id,
      slug: namespaces.slug,
      memexSlug: memexes.slug,
      name: orgs.name,
      memexName: memexes.name,
      role: orgMemberships.role,
    })
    .from(orgMemberships)
    .innerJoin(orgs, eq(orgMemberships.orgId, orgs.id))
    .innerJoin(namespaces, eq(orgs.namespaceId, namespaces.id))
    .innerJoin(memexes, eq(memexes.namespaceId, namespaces.id))
    .where(
      sql`${orgMemberships.userId} = ${userId} AND ${orgMemberships.status} = 'active' AND ${orgs.emailDomains} @> ${JSON.stringify([domain.toLowerCase()])}::jsonb`,
    );

  return rows.map((row) => ({
    memexId: row.memexId,
    orgId: row.orgId,
    slug: row.slug,
    memexSlug: row.memexSlug,
    name: row.name,
    memexName: row.memexName,
    kind: "team" as const,
    role: row.role as "member" | "administrator",
    // Domain-match rows are always org memberships — full-access (std-4).
    source: "org" as const,
    accessLevel: "write" as const,
  }));
}
