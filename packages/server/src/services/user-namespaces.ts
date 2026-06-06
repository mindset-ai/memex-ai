import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, memexes, users } from "../db/schema.js";
import type { Memex, Namespace } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { seedHandholdDemo } from "./handhold-demo.js";
import { seedDefaultStandards } from "./default-standards.js";

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
    // spec-178 t-4 — seed the handhold onboarding demo when the personal memex
    // was just created (it didn't pre-exist our mutate; a race-twin may have won
    // the actual insert, but the seed is idempotent — ac-8 — so a duplicate fire
    // is harmless). The needsLink-only repair path has a pre-existing memex and
    // does NOT seed.
    if (!existingMemex) {
      seedHandholdDemoBestEffort(created.memex.id);
      seedDefaultStandardsBestEffort(created.memex.id);
    }
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
  // spec-178 t-4 — seed the handhold onboarding demo into the brand-new personal
  // Memex. AFTER the mutate() commits, on the create path only (the fast-path
  // returns earlier and never reaches here). This funnels every signup flow
  // (password / magic-link / SSO) — they all create the namespace through here.
  seedHandholdDemoBestEffort(created.memex.id);
  seedDefaultStandardsBestEffort(created.memex.id);
  return created;
}

// Fire-and-forget the handhold demo seed for a newly-created personal Memex
// (spec-178 t-4). Best-effort by contract: a seed failure must NEVER roll back
// or block signup, so the promise is detached (`void`) and any rejection is
// swallowed to a log line. The seed itself is idempotent (NO-OP if the Memex
// already has a demo doc — ac-8), so even a duplicate fire is harmless.
//
// spec-186: MEMEX_HANDHOLD_SIGNUP_SEED=off disables the hook. The vitest config
// sets it suite-wide — under vitest every test that creates a user spawned a
// detached multi-insert seed that outlived the test, racing its cleanup (FK
// violations, rotating deadlocks: share-tokens / org-access / path-routing) and
// logging after worker teardown (the EnvironmentTeardownError rpc race). The
// hook's OWN suites (handhold.api.test.ts, the seed-resilience test) stub the
// var back on — the env is read at CALL time, never cached, precisely so they
// can. Prod/dev/e2e behaviour is unchanged (var unset ⇒ hook fires).
function seedHandholdDemoBestEffort(memexId: string): void {
  if (process.env.MEMEX_HANDHOLD_SIGNUP_SEED === "off") return;
  void seedHandholdDemo(memexId).catch((err) =>
    console.error("[handhold seed]", err),
  );
}

// Fire-and-forget the default-Standards seed for a newly-created personal Memex
// (spec-184 t-3 / dec-2). Best-effort by contract: a seed failure must NEVER roll
// back or block signup, so the promise is detached (`void`) and any rejection is
// swallowed to a log line. The seed is idempotent (NO-OP once the Memex holds any
// standard — the zero-Standards guard), so even a duplicate fire is harmless. Only
// reached on the personal-namespace create path (kind='user'), so seeding is
// inherently personal-only (dec-6).
//
// spec-186 gate (mirrors seedHandholdDemoBestEffort): this detached multi-insert seed
// otherwise outlives a test and races its cleanup — FK noise + a console log after
// worker teardown (the EnvironmentTeardownError rpc race) — so vitest disables it
// suite-wide via MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED=off. The seed's OWN suites stub it
// back on (read at CALL time, never cached). Prod/dev/e2e are unchanged (var unset ⇒
// hook fires).
function seedDefaultStandardsBestEffort(memexId: string): void {
  if (process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED === "off") return;
  void seedDefaultStandards(memexId).catch((err) =>
    console.error("[default-standards seed]", err),
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
