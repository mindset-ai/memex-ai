// Namespace service. Owns lookups, rename, availability checks, and the
// kind-aware home payload for the namespaces table (the URL identity layer
// per dec-9 of doc-15).
//
// Split out of services/orgs.ts in doc-19 t-1 so org-specific concerns
// (memberships, billing, settings) stay in orgs.ts while URL identity lives
// here. The shared per-namespace slug pool rules still live in services/shared/slug.ts.

import { and, count, eq, asc } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  namespaceSlugReservations,
  orgMemberships,
  orgs,
} from "../db/schema.js";
import type { Namespace } from "../db/schema.js";
import { validateSlugFormat } from "./shared/slug.js";
import { ConflictError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";

export async function getNamespaceBySlug(slug: string): Promise<Namespace | undefined> {
  return db.query.namespaces.findFirst({
    where: eq(namespaces.slug, slug.toLowerCase()),
  });
}

export async function getNamespaceById(id: string): Promise<Namespace | undefined> {
  return db.query.namespaces.findFirst({ where: eq(namespaces.id, id) });
}

// Discriminated-union return type for the kind-aware home payload (doc-19 t-4).
export type NamespaceHome =
  | {
      kind: "org";
      org: { id: string; name: string; slug: string };
      memexes: Array<{
        id: string;
        slug: string;
        name: string;
        lastActivityAt: Date;
      }>;
      memberCount: number;
      currentRole: "member" | "administrator";
    }
  | {
      kind: "personal";
      memex: { id: string; slug: string; name: string } | null;
    };

// Build the home payload for a namespace, scoped to a particular caller.
// Assumes namespaceAccessGate has already verified the caller's access.
export async function getNamespaceHome(
  namespaceId: string,
  callerUserId: string,
): Promise<NamespaceHome | null> {
  const ns = await getNamespaceById(namespaceId);
  if (!ns) return null;

  if (ns.kind === "org") {
    if (!ns.ownerOrgId) throw new ValidationError("Org namespace missing ownerOrgId");
    const org = await db.query.orgs.findFirst({ where: eq(orgs.id, ns.ownerOrgId) });
    if (!org) return null;

    const memexRows = await db
      .select({
        id: memexes.id,
        slug: memexes.slug,
        name: memexes.name,
        updatedAt: memexes.updatedAt,
      })
      .from(memexes)
      .where(eq(memexes.namespaceId, ns.id))
      .orderBy(asc(memexes.slug));

    const [memberRow] = await db
      .select({ c: count() })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, org.id),
          eq(orgMemberships.status, "active"),
        ),
      );

    const membership = await db.query.orgMemberships.findFirst({
      where: (m, { and, eq }) =>
        and(
          eq(m.userId, callerUserId),
          eq(m.orgId, org.id),
          eq(m.status, "active"),
        ),
    });

    return {
      kind: "org",
      org: { id: org.id, name: org.name, slug: ns.slug },
      memexes: memexRows.map((m) => ({
        id: m.id,
        slug: m.slug,
        name: m.name,
        lastActivityAt: m.updatedAt,
      })),
      memberCount: memberRow?.c ?? 0,
      currentRole: (membership?.role ?? "member") as "member" | "administrator",
    };
  }

  // kind === 'user' — personal namespace. Surface the single personal memex
  // (per the Q4-locked single-Memex constraint). Falls back to `null` if the
  // namespace exists without any memex yet (shouldn't happen post-ensureUserNamespace
  // but the type allows it).
  const memex = await db.query.memexes.findFirst({
    where: eq(memexes.namespaceId, ns.id),
    orderBy: (m, { asc }) => asc(m.slug),
  });
  return {
    kind: "personal",
    memex: memex
      ? { id: memex.id, slug: memex.slug, name: memex.name }
      : null,
  };
}

// Lightweight availability check used by tests. The route layer and signup
// flow use the more rigorous `isSlugAvailable` in services/shared/slug.ts,
// which also consults the post-rename reservation table.
export async function isSlugAvailable(slug: string): Promise<boolean> {
  const existing = await getNamespaceBySlug(slug);
  return !existing;
}

export interface RenameSlugRequest {
  namespaceId: string;
  newSlug: string;
  userId: string;
}

// std-3 / dec-7 of doc-15: rename with 30-day cooldown; previous slug held in
// reservation for 30 days. Transaction body atomically moves the old slug into
// the reservation table and updates the namespace.
const SLUG_COOLDOWN_DAYS = 30;
const SLUG_RESERVATION_DAYS = 30;

export async function renameNamespaceSlug(input: RenameSlugRequest): Promise<Mutated<Namespace>> {
  const newSlug = input.newSlug.trim().toLowerCase();

  const format = validateSlugFormat(newSlug);
  if (!format.valid) {
    throw new ValidationError(`Invalid slug: ${format.error}`);
  }

  // Resolve a memex under this namespace so the bus event has a memexId.
  // Pull any memex (every memex under the namespace shares the rename's
  // user-visible effect: its URL slug changes). For empty Org namespaces
  // (post-doc-19 dec-1) memexId falls back to "" and subscribers fall back
  // to user-scoped delivery.
  const [memexRow] = await db
    .select({ id: memexes.id })
    .from(memexes)
    .where(eq(memexes.namespaceId, input.namespaceId))
    .limit(1);
  const memexId = memexRow?.id ?? "";

  return mutate(
    {},
    { memexId, entity: "user_namespace", action: "updated" },
    () => db.transaction(async (tx) => {
      const ns = await tx.query.namespaces.findFirst({
        where: eq(namespaces.id, input.namespaceId),
      });
      if (!ns) throw new ValidationError("Namespace not found");

      // Authorization: caller must own the namespace.
      //   user namespace → owner_user_id matches
      //   org namespace  → caller has 'administrator' membership in the org
      if (ns.kind === "user") {
        if (ns.ownerUserId !== input.userId) {
          throw new ValidationError("Not authorized to rename this namespace");
        }
      } else {
        if (!ns.ownerOrgId) throw new ValidationError("Namespace has no owning org");
        const membership = await tx.query.orgMemberships.findFirst({
          where: (m, { and, eq }) =>
            and(
              eq(m.userId, input.userId),
              eq(m.orgId, ns.ownerOrgId!),
              eq(m.role, "administrator"),
              eq(m.status, "active"),
            ),
        });
        if (!membership) {
          throw new ValidationError("Not authorized to rename this namespace");
        }
      }

      // Cooldown.
      if (ns.slugChangedAt) {
        const cooldownEnd = new Date(ns.slugChangedAt.getTime() + SLUG_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
        if (new Date() < cooldownEnd) {
          throw new ValidationError(
            `Slug renamed too recently — wait until ${cooldownEnd.toISOString()} (30-day cooldown).`,
          );
        }
      }

      // Same as create: format already validated; check availability.
      const reserved = await tx.query.namespaceSlugReservations.findFirst({
        where: eq(namespaceSlugReservations.slug, newSlug),
      });
      if (reserved && reserved.reservedUntil > new Date()) {
        throw new ConflictError(`Slug '${newSlug}' is held in reservation`);
      }
      const taken = await tx.query.namespaces.findFirst({ where: eq(namespaces.slug, newSlug) });
      if (taken) {
        throw new ConflictError(`Slug '${newSlug}' is already taken`);
      }

      // Reserve the OLD slug for 30 days post-rename.
      const reservedUntil = new Date(Date.now() + SLUG_RESERVATION_DAYS * 24 * 60 * 60 * 1000);
      await tx
        .insert(namespaceSlugReservations)
        .values({
          slug: ns.slug,
          releasedNamespaceId: ns.id,
          reservedUntil,
        })
        .onConflictDoUpdate({
          target: namespaceSlugReservations.slug,
          set: { reservedUntil, releasedNamespaceId: ns.id },
        });

      // Update the namespace.
      const [updated] = await tx
        .update(namespaces)
        .set({ slug: newSlug, slugChangedAt: new Date() })
        .where(eq(namespaces.id, ns.id))
        .returning();

      return updated;
    }),
  );
}
