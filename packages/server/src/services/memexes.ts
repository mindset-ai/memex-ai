// Memex service. Owns lookups, URL helpers, slug availability, and creation
// for the memexes table (the workspace container per dec-9 of doc-15).
//
// Split out of services/orgs.ts in doc-19 t-1 so org-specific concerns stay
// in orgs.ts and namespace concerns live in services/namespaces.ts.

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces } from "../db/schema.js";
import type { Memex } from "../db/schema.js";
import { validateSlugFormat, type SlugFormatError } from "./shared/slug.js";
import { ConflictError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";

export async function getMemexById(id: string): Promise<Memex | undefined> {
  return db.query.memexes.findFirst({ where: eq(memexes.id, id) });
}

/**
 * Resolve the owning org UUID for a memex (memexes → namespaces → ownerOrgId).
 * Returns null for personal-namespace memexes that have no ownerOrgId.
 */
export async function getOrgIdForMemex(memexId: string): Promise<string | null> {
  const row = await db
    .select({ ownerOrgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  return row[0]?.ownerOrgId ?? null;
}

// Returns { available, reason? } for a slug-in-namespace probe. Same shape
// as services/shared/slug.ts:isSlugAvailable but scoped to one namespace —
// memex slugs are unique per namespace, not globally.
export interface MemexSlugCheckResult {
  available: boolean;
  reason?: SlugFormatError | "taken";
}

export async function isMemexSlugAvailable(
  namespaceId: string,
  slug: string,
): Promise<MemexSlugCheckResult> {
  const normalized = slug.trim().toLowerCase();
  const format = validateSlugFormat(normalized);
  if (!format.valid) {
    return { available: false, reason: format.error };
  }
  const existing = await db.query.memexes.findFirst({
    where: (m, { and, eq }) =>
      and(eq(m.namespaceId, namespaceId), eq(m.slug, normalized)),
  });
  if (existing) return { available: false, reason: "taken" };
  return { available: true };
}

// spec-111 t-5 — the Memex-level visibility toggle. `public` grants read-only
// access to everyone (incl. anonymous) via canReadMemex; `private` keeps the
// org-members-only posture. Default is `private` (schema-enforced).
export type MemexVisibility = "public" | "private";

export function isMemexVisibility(value: unknown): value is MemexVisibility {
  return value === "public" || value === "private";
}

/**
 * Flip a Memex's visibility (`public` | `private`).
 *
 * Caller authorization (owner/admin) is enforced UPSTREAM by the route's
 * adminGate — this service is the data path only. Per std-8 the write goes
 * through `mutate()` and emits a `memex`/`updated` event on the unified bus so
 * the React UI (and any other reactive surface) sees the flip immediately.
 *
 * Throws ValidationError if the memex doesn't exist. The change takes effect
 * on the very next read because the row is updated in place — no caching layer
 * sits between this write and `canReadMemex`'s load.
 */
export async function updateMemexVisibility(
  memexId: string,
  visibility: MemexVisibility,
  ctx: RequestCtx = {},
): Promise<Mutated<Memex>> {
  return mutate(
    ctx,
    { memexId, entity: "memex", action: "updated" },
    async () => {
      const [updated] = await db
        .update(memexes)
        .set({ visibility, updatedAt: new Date() })
        .where(eq(memexes.id, memexId))
        .returning();
      if (!updated) {
        throw new ValidationError(`Memex ${memexId} not found`);
      }
      return updated;
    },
  );
}

export class MemexCreationError extends Error {
  constructor(
    public readonly code: "kind_not_org" | "not_a_member",
    message: string,
  ) {
    super(message);
    this.name = "MemexCreationError";
  }
}

export interface CreateMemexInput {
  namespaceId: string;
  slug: string;
  name?: string;
  callerUserId: string;
}

// Inserts a Memex inside the given namespace.
//   - Validates slug format (std-3).
//   - Throws ValidationError if the namespace doesn't exist.
//   - Throws MemexCreationError('kind_not_org') if the namespace is a user
//     namespace — sibling personal Memexes are Q4-deferred (dec-3 of doc-19).
//   - Throws MemexCreationError('not_a_member') if the caller has no active
//     org membership.
//   - Maps Postgres 23505 → ConflictError for slug collisions.
//   - Defaults `name` to titlecased slug (e.g. website-rewrite → Website-rewrite).
export async function createMemex(
  input: CreateMemexInput,
  ctx: RequestCtx = {},
): Promise<Mutated<Memex>> {
  const slug = input.slug.trim().toLowerCase();
  const format = validateSlugFormat(slug);
  if (!format.valid) {
    throw new ValidationError(`Invalid slug: ${format.error}`);
  }

  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, input.namespaceId),
  });
  if (!ns) throw new ValidationError("Namespace not found");

  if (ns.kind === "user") {
    throw new MemexCreationError(
      "kind_not_org",
      "Sibling personal Memexes are not supported in v1",
    );
  }

  if (!ns.ownerOrgId) {
    throw new ValidationError("Org namespace missing ownerOrgId");
  }

  const membership = await db.query.orgMemberships.findFirst({
    where: (m, { and, eq }) =>
      and(
        eq(m.userId, input.callerUserId),
        eq(m.orgId, ns.ownerOrgId!),
        eq(m.status, "active"),
      ),
  });
  if (!membership) {
    throw new MemexCreationError(
      "not_a_member",
      "Caller is not an active member of this org",
    );
  }

  const name = input.name?.trim() || slug.charAt(0).toUpperCase() + slug.slice(1);

  try {
    // std-8 (spec-156 W3 ac-22): creating a Memex is a tenant event — emit
    // memex/created on the unified bus, mirroring the personal-memex path in
    // services/user-namespaces.ts. The per-key factory resolves memexId from the
    // freshly-inserted row; userId is the caller so the right session's
    // /api/me/events stream wakes.
    return await mutate(
      ctx,
      (r: Memex) => ({
        memexId: r.id,
        userId: input.callerUserId,
        entity: "memex" as const,
        action: "created" as const,
      }),
      async () => {
        const [memex] = await db
          .insert(memexes)
          .values({
            namespaceId: ns.id,
            slug,
            name,
          })
          .returning();
        return memex;
      },
    );
  } catch (err) {
    if (
      err && typeof err === "object" && "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      throw new ConflictError(`Slug '${slug}' is already taken in this namespace`);
    }
    throw err;
  }
}
