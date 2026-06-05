import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, memexes, users } from "../db/schema.js";
import type { Memex, Namespace } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { seedHandholdDemo } from "./handhold-demo.js";

// Canonical display name for personal memexes. Per product decision, personal memexes
// cannot be renamed — the switcher always shows "Personal Memex" so there's no ambiguity
// about which context the user is in.
export const PERSONAL_MEMEX_NAME = "Personal Memex";

// Slug-from-email-localpart with collision-resolve (mirrors migration 0038's algorithm).
// Returns a slug guaranteed not to collide with an existing namespace.slug.
async function deriveAvailableSlug(email: string, userId: string): Promise<string> {
  // local-part: lowercase, replace non-[a-z0-9-] with '-', collapse repeats, trim leading
  // hyphen, ensure it starts with [a-z0-9].
  const local = email.split("@")[0] ?? "";
  let base = local
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!base || !/^[a-z0-9]/.test(base)) {
    base = `u${userId.slice(0, 8)}`;
  }
  if (base.length > 39) base = base.slice(0, 39);

  // Try base, then base-2, base-3, ...
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`.slice(0, 39);
    const existing = await db.query.namespaces.findFirst({
      where: eq(namespaces.slug, candidate),
    });
    if (!existing) return candidate;
  }
  // Fallback — userId-derived guaranteed unique
  return `u-${userId.slice(0, 30)}`;
}

// Idempotent: if the user already has a namespace + default memex, returns the memex.
// Otherwise creates a namespace (kind=user) and a default "personal" memex, linking
// users.namespace_id. Every signup path (password, SSO, magic-link) funnels through this
// helper so the invariant "every active user has exactly one namespace + memex" is
// maintained centrally.
export async function ensureUserNamespace(
  userId: string,
): Promise<Mutated<{ namespace: Namespace; memex: Memex }>> {
  const existingUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!existingUser) throw new ValidationError(`User ${userId} not found`);

  if (existingUser.namespaceId) {
    const ns = await db.query.namespaces.findFirst({
      where: eq(namespaces.id, existingUser.namespaceId),
    });
    if (ns) {
      // Find or create a default memex inside the namespace.
      const existingMemex = await db.query.memexes.findFirst({
        where: eq(memexes.namespaceId, ns.id),
      });
      if (existingMemex) {
        // silent: idempotent fast path — no DB write, no UI consequence.
        return mutate(
          {},
          { memexId: existingMemex.id, userId, entity: "memex", action: "created" },
          async () => ({ namespace: ns, memex: existingMemex }),
          { silent: true },
        );
      }

      const created = await mutate(
        {},
        (r) => ({ memexId: r.memex.id, userId, entity: "memex", action: "created" }),
        async () => {
          // spec-177 ac-5 — absorb the concurrent-signup race on the personal
          // memex too: a parallel call can insert the same (namespace_id,
          // 'personal') memex first, so the loser must fall back to SELECT
          // rather than throw memexes_namespace_id_slug_unique.
          const [insertedMemex] = await db
            .insert(memexes)
            .values({
              namespaceId: ns.id,
              slug: "personal",
              name: PERSONAL_MEMEX_NAME,
            })
            .onConflictDoNothing()
            .returning();
          const memex =
            insertedMemex ??
            (await db.query.memexes.findFirst({
              where: and(eq(memexes.namespaceId, ns.id), eq(memexes.slug, "personal")),
            }));
          if (!memex) throw new Error(`Personal memex not found after insert for namespace ${ns.id}`);
          return { namespace: ns, memex };
        },
      );
      // spec-178 t-4 — seed the handhold onboarding demo into the freshly-created
      // personal Memex (create path only, never the idempotent fast-path above).
      seedHandholdDemoBestEffort(created.memex.id);
      return created;
    }
    // Dangling FK — fall through to recreate.
  }

  const slug = await deriveAvailableSlug(existingUser.email, userId);

  const created = await mutate(
    {},
    // Composite: a new user namespace AND its default personal memex. Two
    // logical changes; subscribers filter on entity. memexId resolves to the
    // freshly-created memex via per-key factory. userId is set so the
    // /api/me/events stream delivers these to the right session.
    [
      (r: { namespace: Namespace; memex: Memex }) =>
        ({ memexId: r.memex.id, userId, entity: "user_namespace" as const, action: "created" as const }),
      (r: { namespace: Namespace; memex: Memex }) =>
        ({ memexId: r.memex.id, userId, entity: "memex" as const, action: "created" as const }),
    ],
    () => db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(namespaces)
        .values({
          slug,
          kind: "user",
          ownerUserId: userId,
        })
        .onConflictDoNothing()
        .returning();
      const namespace = inserted ?? await tx.query.namespaces.findFirst({ where: eq(namespaces.slug, slug) });
      if (!namespace) throw new Error(`Namespace ${slug} not found after insert`);

      // spec-177 ac-5 — mirror the namespace insert above: the personal memex
      // insert must also absorb the concurrent-signup race. Two parallel calls
      // can resolve the same namespace (the loser via the SELECT fallback), then
      // race to INSERT (namespace_id, 'personal'); without onConflictDoNothing the
      // loser throws memexes_namespace_id_slug_unique. Latent until spec-178's
      // signup seed added concurrent load that reliably widened the window.
      const [insertedMemex] = await tx
        .insert(memexes)
        .values({
          namespaceId: namespace.id,
          slug: "personal",
          name: PERSONAL_MEMEX_NAME,
        })
        .onConflictDoNothing()
        .returning();
      const memex =
        insertedMemex ??
        (await tx.query.memexes.findFirst({
          where: and(eq(memexes.namespaceId, namespace.id), eq(memexes.slug, "personal")),
        }));
      if (!memex) throw new Error(`Personal memex not found after insert for namespace ${namespace.id}`);

      await tx
        .update(users)
        .set({ namespaceId: namespace.id, updatedAt: new Date() })
        .where(eq(users.id, userId));

      return { namespace, memex };
    }),
  );
  // spec-178 t-4 — seed the handhold onboarding demo into the brand-new personal
  // Memex. AFTER the mutate() commits, on the create path only (the fast-path
  // returns earlier and never reaches here). This funnels every signup flow
  // (password / magic-link / SSO) — they all create the namespace through here.
  seedHandholdDemoBestEffort(created.memex.id);
  return created;
}

// Fire-and-forget the handhold demo seed for a newly-created personal Memex
// (spec-178 t-4). Best-effort by contract: a seed failure must NEVER roll back
// or block signup, so the promise is detached (`void`) and any rejection is
// swallowed to a log line. The seed itself is idempotent (NO-OP if the Memex
// already has a demo doc — ac-8), so even a duplicate fire is harmless.
function seedHandholdDemoBestEffort(memexId: string): void {
  void seedHandholdDemo(memexId).catch((err) =>
    console.error("[handhold seed]", err),
  );
}

// Returns the user's default Memex (creates one if needed). The signup paths
// (password, magic-link) call this to ensure every active user has a workspace.
// Returns plain Memex (not Mutated<Memex>) — the mutation (and its bus emission)
// is owned by ensureUserNamespace; this helper just unboxes the memex field.
export async function ensureUserMemex(userId: string): Promise<Memex> {
  const result = await ensureUserNamespace(userId);
  return result.memex;
}
