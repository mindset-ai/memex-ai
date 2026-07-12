import { eq, and, isNull } from "drizzle-orm";
import { db, runWithMemexId } from "../db/connection.js";
import { namespaces, memexes, users } from "../db/schema.js";
import type { Memex, Namespace } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { seedDefaultStandards } from "./default-standards.js";
import { seedDefaultFacetsForMemexBestEffort } from "./default-facets.js";
// spec-474 dec-1: the demo-vs-starter provisioning experiment concluded with the
// seeded starter Spec as the winner, so provisioning now seeds the starter Spec
// DIRECTLY — no experiment bucketing, no variant registry. The experiment framework
// tables/service remain (Backstage still reads the concluded experiment's history),
// but the signup seed no longer routes through them.
import { seedStarterSpec } from "./starter-spec.js";
import { DEFAULT_EXPERIMENT_KEY } from "../db/seed-experiments.js";

// spec-426/spec-474: the well-known key for the (now concluded) new-user provisioning
// A/B. The experiment row + its variants are created at boot
// (db/seed-experiments.ensureDefaultExperiment) and managed in Backstage; this is the
// stable lookup both ends share. RE-EXPORTED from DEFAULT_EXPERIMENT_KEY so the boot
// seed's key and any reader's lookup are the SAME string by construction — they cannot
// drift. The provisioning seed no longer consults it (spec-474 dec-1), but the
// test-only arm-pin surface still keys off it.
export const PROVISIONING_EXPERIMENT_KEY = DEFAULT_EXPERIMENT_KEY;

// Canonical display name for personal memexes. Per product decision, personal memexes
// cannot be renamed — the switcher always shows "Personal Memex" so there's no ambiguity
// about which context the user is in.
export const PERSONAL_MEMEX_NAME = "Personal Memex";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Slug-from-email-localpart with collision-resolve (mirrors migration 0038's algorithm).
// Returns a slug that is either free or already OURS — never a stranger's.
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
    // spec-177 issue-1: our OWN personal namespace is not a collision to suffix
    // around — a concurrent ensureUserNamespace call (the signup-resend race) may
    // have just created it. Reuse the slug; the caller's ON CONFLICT + ownership
    // re-read converge on the same row. Without this, the losing call saw the
    // winner's row as foreign, suffixed to `base-2`, and created a SECOND
    // namespace for the user.
    if (existing.kind === "user" && existing.ownerUserId === userId) return candidate;
  }
  // Fallback — userId-derived guaranteed unique
  return `u-${userId.slice(0, 30)}`;
}

// The user's personal namespace, resolved by OWNERSHIP — the authoritative lookup.
// users.namespaceId is only the fast pointer to it (issue-1: a null or dangling
// pointer does not mean the namespace is absent).
function findOwnNamespace(executor: Tx | typeof db, userId: string): Promise<Namespace | undefined> {
  return executor.query.namespaces.findFirst({
    where: and(eq(namespaces.ownerUserId, userId), eq(namespaces.kind, "user")),
  });
}

// Find-or-create the default memex inside a namespace, race-safely (spec-177
// ac-5 / issue-1): a concurrent call may have created "personal" between our
// read and our insert — the memexes_namespace_id_slug_unique constraint turns
// that into a conflict we absorb and re-read (the bare INSERT here used to
// throw duplicate-key; latent until spec-178's signup seed added concurrent
// load that reliably widened the window).
async function findOrCreatePersonalMemex(tx: Tx, namespaceId: string): Promise<Memex> {
  const existing = await tx.query.memexes.findFirst({
    where: eq(memexes.namespaceId, namespaceId),
  });
  if (existing) return existing;
  const [inserted] = await tx
    .insert(memexes)
    .values({ namespaceId, slug: "personal", name: PERSONAL_MEMEX_NAME })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const raced = await tx.query.memexes.findFirst({
    where: and(eq(memexes.namespaceId, namespaceId), eq(memexes.slug, "personal")),
  });
  if (!raced) throw new Error(`Personal memex for namespace ${namespaceId} not found after insert`);
  return raced;
}

// Idempotent: if the user already has a namespace + default memex, returns the memex.
// Otherwise creates a namespace (kind=user) and a default "personal" memex, linking
// users.namespace_id. Every signup path (password, SSO, magic-link) funnels through this
// helper so the invariant "every active user has exactly one namespace + memex" is
// maintained centrally.
//
// spec-177 issue-1 (concurrency): two concurrent calls for the same user (the
// email-resend race) must converge on ONE namespace. The original code resolved
// purely by slug, which left two holes: the losing call could see the winner's
// fresh row as a foreign slug collision and suffix past it (second namespace), and
// the post-conflict re-read by bare slug could adopt a STRANGER's namespace if a
// foreign signup grabbed the candidate in the derive→insert window. Resolution is
// now ownership-first at every step.
export async function ensureUserNamespace(
  userId: string,
): Promise<Mutated<{ namespace: Namespace; memex: Memex }>> {
  const existingUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!existingUser) throw new ValidationError(`User ${userId} not found`);

  let ns: Namespace | undefined;
  if (existingUser.namespaceId) {
    ns = await db.query.namespaces.findFirst({
      where: eq(namespaces.id, existingUser.namespaceId),
    });
    // Dangling FK — fall through to the ownership lookup.
  }
  ns ??= await findOwnNamespace(db, userId);

  if (ns) {
    const namespace = ns;
    // Repair the fast pointer when it was null or dangling — the race's losing
    // call lands here after the winner created the namespace but before (or
    // without) this user row pointing at it.
    const needsLink = existingUser.namespaceId !== namespace.id;
    const existingMemex = await db.query.memexes.findFirst({
      where: eq(memexes.namespaceId, namespace.id),
    });
    if (existingMemex && !needsLink) {
      // silent: idempotent fast path — no DB write, no UI consequence.
      return mutate(
        {},
        { memexId: existingMemex.id, userId, entity: "memex", action: "created" },
        async () => ({ namespace, memex: existingMemex }),
        { silent: true },
      );
    }

    const created = await mutate(
      {},
      (r) => ({ memexId: r.memex.id, userId, entity: "memex", action: "created" }),
      () =>
        db.transaction(async (tx) => {
          const memex = await findOrCreatePersonalMemex(tx, namespace.id);
          if (needsLink) {
            await tx
              .update(users)
              .set({ namespaceId: namespace.id, updatedAt: new Date() })
              .where(eq(users.id, userId));
          }
          return { namespace, memex };
        }),
    );
    // spec-474 dec-6: content seeding no longer runs on this request path. The Memex
    // is created with provisioned_at NULL; the SPA drives the content seed via the
    // first-load readiness endpoint (POST /api/me/provision) behind a "Getting your
    // Memex ready…" blocker, so nothing seed-heavy sits on the signup response or ahead
    // of the verification email. The needsLink-only repair path never created a memex.
    return created;
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
      // INSERT ... ON CONFLICT DO NOTHING (dec-1). The losing call's insert is
      // absorbed here and resolved below by OWNERSHIP, never by bare slug — a
      // slug-only re-read could adopt a stranger's namespace (issue-1).
      const inserted = await tx
        .insert(namespaces)
        .values({
          slug,
          kind: "user",
          ownerUserId: userId,
        })
        .onConflictDoNothing()
        .returning();
      let namespace: Namespace | undefined = inserted[0] ?? (await findOwnNamespace(tx, userId));
      if (!namespace) {
        // The conflict was a FOREIGN row — a stranger grabbed the slug in the
        // derive→insert window — and no concurrent call created ours. Retry once
        // with the userId-derived slug, which only our own calls can contend for.
        const retried = await tx
          .insert(namespaces)
          .values({
            slug: `u-${userId.slice(0, 30)}`,
            kind: "user",
            ownerUserId: userId,
          })
          .onConflictDoNothing()
          .returning();
        namespace = retried[0] ?? (await findOwnNamespace(tx, userId));
      }
      if (!namespace) throw new Error(`Personal namespace for user ${userId} not found after insert`);

      const memex = await findOrCreatePersonalMemex(tx, namespace.id);

      await tx
        .update(users)
        .set({ namespaceId: namespace.id, updatedAt: new Date() })
        .where(eq(users.id, userId));

      return { namespace, memex };
    }),
  );
  // spec-474 dec-6: content seeding no longer runs here. The namespace + Memex are
  // created (fast, one tx) and returned; the Memex comes up provisioned_at NULL and is
  // content-seeded later by the first-load readiness endpoint (POST /api/me/provision),
  // NOT on this request. This funnels every signup flow (password / magic-link / SSO),
  // so none of them wait on the seed.
  return created;
}

// Seed a personal Memex's onboarding content: the default facets, the default
// Standards, and the "Understanding Memex" starter Spec. The two doc-seeds run
// concurrently; allSettled guarantees this never rejects.
//
// spec-474 dec-6: this NO LONGER runs on the signup request. It used to be awaited
// inside ensureUserNamespace's create path, which delayed the signup response and the
// verification email; and it couldn't simply be detached, because on Cloud Run CPU is
// throttled to ~0 the instant the HTTP response flushes, so a detached post-response
// multi-insert got starved/killed and new users landed in an EMPTY Memex. The fix is
// to run it on a DIFFERENT request — the first-load readiness endpoint
// (POST /api/me/provision, via provisionUserMemex below) — which has its own CPU
// allocation for its lifetime, so the inserts finish reliably with no empty-Memex
// regression, and nothing seed-heavy sits on signup.
//
// Best-effort is preserved by the per-seed try/catch: a seed failure is logged and
// swallowed. The seeds are individually idempotent (starter: NO-OP once the system
// starter exists; standards: NO-OP once the Memex holds any standard), so a duplicate
// fire (a race twin, a re-provision) is harmless.
//
// spec-436: run the seeders inside runWithMemexId(memexId) so the rlsClient proxy emits
// `set_config('app.memex_id', …)` for every INSERT they issue. The runtime connects as the
// non-owner `memex_app` role, which is SUBJECT to RLS (std-36: ENABLE, never FORCE), and the
// `documents` WITH CHECK policy keys on app.memex_id. One wrapper over the shared allSettled
// covers all the seeders.
export async function provisionPersonalMemexContent(memexId: string): Promise<void> {
  await runWithMemexId(memexId, async () => {
    // spec-437 dec-1: the facet vocabulary must exist BEFORE the default Standards are
    // seeded, so each default clause's facet verdict persists against a live vocabulary
    // (a vocab-less seed silently drops the verdicts). spec-340 t-3 (dec-7): a personal
    // memex owns its facets directly (owner_type='memex'). Best-effort + idempotent; a
    // facet-seed failure degrades gracefully to ballotless default Standards rather than
    // blocking signup.
    await seedDefaultFacetsForMemexBestEffort(memexId);
    await Promise.allSettled([
      seedProvisioningBehaviourBestEffort(memexId),
      seedDefaultStandardsBestEffort(memexId),
    ]);
  });
}

// spec-474 dec-1: seed the new personal Memex with the "Understanding Memex" starter
// Spec, awaited + isolated — see seedNewPersonalMemex. A rejection is caught and logged
// so it never propagates out of ensureUserNamespace (a seed failure must never block
// signup). This is the only seeding path; the demo-vs-starter experiment concluded with
// the starter Spec as the winner, so provisioning now seeds it DIRECTLY rather than
// dispatching through the experiment registry.
//
// NET-NEW only: this hook fires solely on the personal-namespace CREATE path, so by
// construction it only ever seeds users created after the cutover — there is no backfill
// and none is needed.
//
// System-attributed by design (spec-426 dec-3 / ac-3): the starter Spec and its children
// MUST NOT advance the new user's onboarding milestones, so we pass a bare server ctx with
// NO actorUserId. seedStarterSpec strips any actor defensively, but we don't thread one to
// begin with — the rows land system-owned (created_by_user_id / actor_user_id NULL).
//
// spec-186 kill-switch: MEMEX_HANDHOLD_SIGNUP_SEED=off disables provisioning seeding. The
// vitest config sets it suite-wide: under vitest every test that creates a user would
// otherwise run a multi-insert seed it then has to clean up (FK violations, rotating
// deadlocks). The hook's OWN suites stub the var back on — the env is read at CALL time,
// never cached, precisely so they can. Prod/dev/e2e behaviour is unchanged (var unset ⇒
// hook fires).
async function seedProvisioningBehaviourBestEffort(memexId: string): Promise<void> {
  if (process.env.MEMEX_HANDHOLD_SIGNUP_SEED === "off") return;

  try {
    await seedStarterSpec(memexId, { channel: "server" });
  } catch (err) {
    console.error("[provisioning seed]", err);
  }
}

// Seed the six default Standards (spec-184 t-3 / dec-2), awaited + isolated — see
// seedNewPersonalMemex. A rejection is caught and logged so it never propagates out of
// ensureUserNamespace. Only reached on the personal-namespace create path (kind='user'),
// so seeding is inherently personal-only (dec-6).
//
// spec-186 gate (mirrors seedHandholdDemoBestEffort): vitest disables it suite-wide via
// MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED=off; the seed's OWN suites stub it back on (read at
// CALL time, never cached). Prod/dev/e2e are unchanged (var unset ⇒ hook fires).
async function seedDefaultStandardsBestEffort(memexId: string): Promise<void> {
  if (process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED === "off") return;
  try {
    await seedDefaultStandards(memexId);
  } catch (err) {
    console.error("[default-standards seed]", err);
  }
}

// Returns the user's default Memex (creates one if needed). The signup paths
// (password, magic-link) call this to ensure every active user has a workspace.
// Returns plain Memex (not Mutated<Memex>) — the mutation (and its bus emission)
// is owned by ensureUserNamespace; this helper just unboxes the memex field.
export async function ensureUserMemex(userId: string): Promise<Memex> {
  const result = await ensureUserNamespace(userId);
  return result.memex;
}

// spec-474 dec-6: the first-load readiness step. Idempotently content-seeds the
// caller's personal Memex (default facets + Standards + the "Understanding Memex"
// starter Spec) and stamps memexes.provisioned_at. Called by POST /api/me/provision
// on first load behind the "Getting your Memex ready…" blocker — NOT on signup.
//
// Owner-scoped by construction: the route passes the SESSION user's own id, so a
// caller can only provision their own personal Memex. Idempotent + race-safe: if
// provisioned_at is already set we return without re-seeding; the seeds themselves are
// idempotent, and the stamp is guarded on `provisioned_at IS NULL` so a concurrent
// twin never double-stamps. Returns whether this call performed the seed.
export async function provisionUserMemex(
  userId: string,
): Promise<{ memexId: string; seeded: boolean }> {
  const memex = await ensureUserMemex(userId);

  const [row] = await db
    .select({ provisionedAt: memexes.provisionedAt })
    .from(memexes)
    .where(eq(memexes.id, memex.id))
    .limit(1);
  if (row?.provisionedAt) return { memexId: memex.id, seeded: false };

  await provisionPersonalMemexContent(memex.id);
  await db
    .update(memexes)
    .set({ provisionedAt: new Date() })
    .where(and(eq(memexes.id, memex.id), isNull(memexes.provisionedAt)));
  return { memexId: memex.id, seeded: true };
}

// spec-474 dec-6: the readiness signal the SPA reads on first load (via GET /api/me)
// to decide whether to show the blocker. Reads the caller's personal Memex WITHOUT
// creating it. `provisioned` is true when the content seed has run (provisioned_at set)
// — or when there is no personal Memex yet (nothing to block on; session middleware
// creates it on the same request), so the blocker is only shown for a real, unseeded
// personal Memex.
export async function getPersonalMemexProvisionState(
  userId: string,
): Promise<{ memexId: string | null; provisioned: boolean }> {
  const [row] = await db
    .select({ id: memexes.id, provisionedAt: memexes.provisionedAt })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(and(eq(namespaces.ownerUserId, userId), eq(namespaces.kind, "user")))
    .limit(1);
  if (!row) return { memexId: null, provisioned: true };
  return { memexId: row.id, provisioned: row.provisionedAt != null };
}
