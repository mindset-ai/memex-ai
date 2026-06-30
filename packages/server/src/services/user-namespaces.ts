import { eq, and } from "drizzle-orm";
import { db, runWithMemexId } from "../db/connection.js";
import { namespaces, memexes, users, experiments, experimentVariants } from "../db/schema.js";
import type { Memex, Namespace } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { seedDefaultStandards } from "./default-standards.js";
import { seedDefaultFacetsForMemexBestEffort } from "./default-facets.js";
// spec-426: provisioning is experiment-aware. The new user is bucketed into the
// running provisioning experiment and the assigned variant's behaviour seeds the
// memex (control = spec-178's handhold demo, treatment = the starter Spec). The
// experiment service is the only sanctioned path; an unavailable/non-running
// experiment degrades to control (the safe default — kill-switch).
import {
  resolveOrCreateAssignment,
  runVariantBehaviour,
  CONTROL_BEHAVIOUR,
} from "./experiments.js";
import { DEFAULT_EXPERIMENT_KEY } from "../db/seed-experiments.js";

// spec-426: the well-known key for the new-user provisioning A/B (handhold demo vs
// starter Spec). The experiment row + its A/B variants are created at boot
// (db/seed-experiments.ensureDefaultExperiment) and managed in Backstage; this is
// the stable lookup both ends share. RE-EXPORTED from DEFAULT_EXPERIMENT_KEY so the
// boot seed's key and this resolver's lookup are the SAME string by construction —
// they cannot drift (Verify: they HAD drifted, silently parking every user on
// control). Until a RUNNING experiment exists under this key, provisioning degrades
// to control (handhold demo) by design (kill-switch, ac-13).
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
    // spec-178 t-4 — seed the handhold onboarding demo when the personal memex
    // was just created (it didn't pre-exist our mutate; a race-twin may have won
    // the actual insert, but the seed is idempotent — ac-8 — so a duplicate fire
    // is harmless). The needsLink-only repair path has a pre-existing memex and
    // does NOT seed.
    if (!existingMemex) {
      await seedNewPersonalMemex(created.memex.id, userId);
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
  await seedNewPersonalMemex(created.memex.id, userId);
  return created;
}

// Seed a freshly-created personal Memex with the onboarding content (spec-178
// handhold demo + spec-184 default Standards) and AWAIT it before ensureUserNamespace
// returns. The two seeds run concurrently; allSettled guarantees this never rejects.
//
// Why AWAIT and not fire-and-forget: these seeds were originally detached (`void seed…()`)
// so a slow/failed seed couldn't block or roll back signup. But on Cloud Run, CPU is
// throttled to ~0 the instant the HTTP response flushes, so the detached post-response
// multi-insert was getting starved/killed before its rows committed — new users landed in
// an EMPTY Memex (no demo spec, no Standards), intermittently (it only completed when the
// instance happened to stay warm). Awaiting keeps the inserts on the request path, where
// CPU is allocated for the lifetime of the request, so they actually finish. The seeds are
// bounded local-DB writes (the section embeddings they trigger are themselves fire-and-forget
// inside the doc/section/clause primitives, so they do NOT lengthen this await). Cost is a
// one-time latency bump on the single request that first creates a user's namespace.
//
// Best-effort is preserved by the per-seed try/catch below: a seed failure is logged and
// swallowed, so signup still succeeds (the namespace + memex are already committed by the
// time we get here). The seeds are individually idempotent (handhold: NO-OP if a demo doc
// exists — ac-8; standards: NO-OP once the Memex holds any standard), so a duplicate fire
// (e.g. a signup race twin) is harmless.
//
// spec-436: run the seeders inside runWithMemexId(memexId) so the rlsClient proxy emits
// `set_config('app.memex_id', …)` for every INSERT they issue. The runtime connects as the
// non-owner `memex_app` role, which is SUBJECT to RLS (std-36: ENABLE, never FORCE), and the
// `documents` WITH CHECK policy keys on app.memex_id. Unlike a normal API request — which the
// session middleware already wraps in runWithMemexId(currentMemexId) — provisioning runs
// OUTSIDE any tenant context for the just-created memex (the signup request isn't scoped to
// it), so without this wrapper every seed INSERT was rejected ("new row violates row-level
// security policy for table \"documents\"") and the new workspace came up empty. One wrapper
// over the shared allSettled covers all current and future seeders; the experiment lookup the
// provisioning seed performs reads RLS-EXCLUDED tables, so the GUC is a harmless no-op there.
async function seedNewPersonalMemex(memexId: string, ownerUserId: string): Promise<void> {
  await runWithMemexId(memexId, async () => {
    await Promise.allSettled([
      seedProvisioningBehaviourBestEffort(memexId, ownerUserId),
      seedDefaultStandardsBestEffort(memexId),
      // spec-340 t-3 (dec-7): seed the personal memex's own facet vocabulary
      // (owner_type='memex' — a personal memex is not modelled as its own org, so it
      // owns its facets directly). Best-effort + idempotent, isolated by allSettled so
      // a seed failure never blocks signup. Reached only on the personal-namespace
      // create path, so seeding is inherently personal-only.
      seedDefaultFacetsForMemexBestEffort(memexId),
    ]);
  });
}

// spec-426: seed the new personal Memex with the EXPERIMENT-ASSIGNED onboarding
// behaviour, awaited + isolated — see seedNewPersonalMemex. A rejection is caught and
// logged so it never propagates out of ensureUserNamespace (ac-7 / ac-14: a seed
// failure must never block signup). This is the only seeding path; spec-178's handhold
// demo is now the CONTROL arm, dispatched through the experiment registry.
//
// NET-NEW only (dec-5 / ac-13): this hook fires solely on the personal-namespace CREATE
// path, so by construction it only ever sees users created after the experiment starts —
// there is no backfill and none is needed.
//
// KILL-SWITCH / degrade-to-control (ac-13): the experiment system is best-effort, never
// load-bearing for signup. If the experiment is unavailable, not yet 'running', concluded,
// or anything throws, we fall back to the CONTROL behaviour (the handhold demo) — control
// is the safe default, so a misconfigured/paused experiment degrades signup to spec-178's
// known-good onboarding rather than failing or stranding the user with no content.
//
// spec-186: MEMEX_HANDHOLD_SIGNUP_SEED=off disables ALL provisioning seeding (control AND
// treatment — the control arm IS the handhold demo). The vitest config sets it suite-wide:
// under vitest every test that creates a user would otherwise run a multi-insert seed it
// then has to clean up (FK violations, rotating deadlocks). The hook's OWN suites stub the
// var back on — the env is read at CALL time, never cached, precisely so they can.
// Prod/dev/e2e behaviour is unchanged (var unset ⇒ hook fires).
async function seedProvisioningBehaviourBestEffort(
  memexId: string,
  ownerUserId: string,
): Promise<void> {
  if (process.env.MEMEX_HANDHOLD_SIGNUP_SEED === "off") return;

  // Resolve the variant behaviour first, degrading to control on ANY problem (ac-13).
  // Declared without an initializer: both the try (success) and catch assign it, so it
  // is definitely set before use — and a redundant initial value trips the static scan.
  let behaviour: string;
  try {
    behaviour = await resolveProvisioningBehaviour(ownerUserId);
  } catch (err) {
    // Experiment lookup / assignment failed — degrade to control, never block signup.
    console.error("[experiment assign]", err);
    behaviour = CONTROL_BEHAVIOUR;
  }

  try {
    // Attribution diverges by arm: the CONTROL (handhold demo) is attributed to the new
    // user over the server channel (spec-406 ac-26 / std-32) so its demo Specs/ACs/tasks
    // carry a WHO + HOW; the TREATMENT (starter_spec, dec-3) MUST be system-attributed, so
    // we pass NO actorUserId (seedStarterSpec strips it defensively, but we don't rely on
    // that as the mechanism). runVariantBehaviour itself degrades an unknown behaviour id
    // to control, so a stale/typo'd variant is also safe.
    const ctx =
      behaviour === CONTROL_BEHAVIOUR
        ? ({ channel: "server", actorUserId: ownerUserId } as const)
        : ({ channel: "server" } as const);
    await runVariantBehaviour(behaviour, memexId, ctx);
  } catch (err) {
    console.error("[provisioning seed]", err);
  }
}

// spec-426: resolve which onboarding behaviour to seed for this new user.
//
// ac-13 kill-switch: ONLY a RUNNING experiment drives a variant. A missing experiment, or
// one still in 'draft' (not yet started) or 'concluded' (done), returns the control
// behaviour WITHOUT creating an assignment — assignments are minted only while the
// experiment is running (net-new, no pre-start buckets). When the experiment IS running we
// deterministically bucket the user (dec-6: hash(user_id) → stable 50/50) via
// resolveOrCreateAssignment — idempotent, so a signup race-twin / re-provision never
// re-rolls — and look up the assigned variant's behaviour id.
async function resolveProvisioningBehaviour(ownerUserId: string): Promise<string> {
  const [experiment] = await db
    .select({ id: experiments.id, status: experiments.status })
    .from(experiments)
    .where(eq(experiments.key, PROVISIONING_EXPERIMENT_KEY))
    .limit(1);
  if (!experiment || experiment.status !== "running") {
    return CONTROL_BEHAVIOUR;
  }

  const assignment = await resolveOrCreateAssignment(ownerUserId, PROVISIONING_EXPERIMENT_KEY, {
    channel: "server",
  });
  const [variant] = await db
    .select({ behaviour: experimentVariants.behaviour })
    .from(experimentVariants)
    .where(eq(experimentVariants.id, assignment.variantId))
    .limit(1);
  return variant?.behaviour ?? CONTROL_BEHAVIOUR;
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
