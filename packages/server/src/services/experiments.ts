// Experiments domain service (spec-426) — the A/B construct's pure domain logic.
//
// Three platform-global, user-keyed tables back this (db/schema.ts, after
// commsLog): experiments → experiment_variants → experiment_assignments. Like
// comms_log (spec-6 dec-5) they carry NO memex_id and are RLS-EXCLUDED (migration
// 0116): Core owns + writes them, Backstage reads them cross-tenant via the
// memex_admin BYPASSRLS role. Isolation is enforced at this service layer and, in
// Backstage, by the requireOperator / isDevMode gate — NOT by per-tenant RLS.
//
// This module is PURE domain logic — no HTTP, no Hono. It threads RequestCtx like
// the rest of the service layer for attribution/observability. Because the
// experiment tables are RLS-excluded, writes here use the default db connection
// directly (no runWithMemexId) — exactly the comms_log posture. The ONLY query that
// needs an RLS context is the verdict's "did the user author a real spec" count,
// which reads RLS-governed `documents` and so reuses journey-state's runWithUserId
// owner-visibility seam (see computeVerdict).

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, runWithUserId, type Db } from "../db/connection.js";
import {
  documents,
  experiments,
  experimentVariants,
  experimentAssignments,
  type ExperimentAssignment,
} from "../db/schema.js";
import type { RequestCtx } from "./mutate.js";
// dec-4 control behaviour — the fixed five-Spec onboarding demo (spec-178).
import { seedHandholdDemo } from "./handhold-demo.js";
// dec-4 treatment behaviour — the seeded "Understanding Memex" starter Spec.
// AUTHORED BY A SIBLING TASK: services/starter-spec.ts does not yet exist in this
// worktree. The import is written to the EXPECTED contract `seedStarterSpec(memexId,
// ctx)`; tsc will report the missing module until the sibling lands — the Verify
// phase reconciles. The registry below still resolves safely at runtime: an unknown
// behaviour falls back to control, and the only call site (provisioning) seeds the
// control arm unless an experiment explicitly maps a variant to 'starter_spec'.
import { seedStarterSpec } from "./starter-spec.js";

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log("[experiments]", ...args);
}

// ── Variant behaviour registry (dec-4) ───────────────────────────────────────

/** The known variant behaviours — must match the experiment_variants.behaviour
 * CHECK (`'handhold_demo' | 'starter_spec'`). The CONTROL is handhold_demo. */
export type VariantBehaviour = "handhold_demo" | "starter_spec";

/** The control arm. dec-4: an UNKNOWN or missing behaviour id falls back to this
 * rather than failing signup — a bad seed degrades to the safe default, it never
 * throws on the provisioning path. */
export const CONTROL_BEHAVIOUR: VariantBehaviour = "handhold_demo";

/** A behaviour seeds the freshly-provisioned personal memex. Same shape as the
 * existing seeders (`seedHandholdDemo`): (memexId, ctx) → Promise<void>. */
type SeedFn = (memexId: string, ctx: RequestCtx) => Promise<void>;

/** dec-4: the typed behaviour-id → seeding-function map. The single source of
 * truth for what each variant DOES at provisioning. Append-only as new arms are
 * added; the schema CHECK guards the persisted id, this guards the dispatch. */
const BEHAVIOUR_REGISTRY: Record<VariantBehaviour, SeedFn> = {
  handhold_demo: (memexId, ctx) => seedHandholdDemo(memexId, ctx),
  starter_spec: (memexId, ctx) => seedStarterSpec(memexId, ctx),
};

/**
 * Run the seeding behaviour for a resolved variant on a freshly-provisioned
 * personal memex. dec-4: an UNKNOWN or missing behaviour id falls back to the
 * control (handhold_demo) — provisioning must never fail because an experiment
 * carried a typo'd or not-yet-deployed behaviour. The seed itself is idempotent
 * (seedHandholdDemo no-ops on an already-seeded memex), so a fallback after a
 * partial run is safe.
 */
export async function runVariantBehaviour(
  behaviour: string,
  memexId: string,
  ctx: RequestCtx = { channel: "server" },
): Promise<void> {
  const fn = BEHAVIOUR_REGISTRY[behaviour as VariantBehaviour];
  if (!fn) {
    log(
      `unknown behaviour '${behaviour}' for memex=${memexId} — falling back to control '${CONTROL_BEHAVIOUR}'`,
    );
    await BEHAVIOUR_REGISTRY[CONTROL_BEHAVIOUR](memexId, ctx);
    return;
  }
  await fn(memexId, ctx);
}

// ── Deterministic bucketing (dec-6) ───────────────────────────────────────────

/**
 * Deterministically bucket a user across `armCount` arms from a stable hash of
 * their id. dec-6: assignment must be STABLE and REPRODUCIBLE — re-running it for
 * the same user yields the same arm, and it reads NO prior state beyond this user.
 *
 * Why a hash and NOT Math.random(): random() is non-deterministic (a re-run can
 * flip the arm, breaking reproducibility and any later audit of "who was on what"),
 * is unseedable in Node so a test/backfill can't pin it, and is explicitly off the
 * table for this kind of split. A stable INTEGER hash (FNV-1a) of the id gives a
 * uniform 50/50 split that's a pure function of the id — same id, same arm, forever,
 * on any host. Bucketing is a reproducible coin-flip, NOT a security operation, so a
 * non-cryptographic hash is the right tool: a crypto hash here is both overkill and
 * trips static "weak password hash" scanners (the value hashed is a user id, never a
 * secret).
 */
function deterministicBucket(userId: string, armCount: number): number {
  // FNV-1a, 32-bit. Pure, fast, deterministic; no crypto, no Math.random().
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    // 32-bit FNV prime (16777619) multiply via shift-adds, folded back to uint32.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // For the canonical 2-arm experiment this is a clean 50/50 split.
  return h % armCount;
}

// ── Assignment resolution (dec-6) ──────────────────────────────────────────────

/**
 * Find the user's ACTIVE assignment for `experimentKey`, or create one.
 *
 * The active assignment is the single row with `superseded_at IS NULL` for this
 * (user, experiment) — the partial unique index enforces exactly one. If it exists
 * it is returned unchanged (idempotent: re-provisioning never re-rolls the dice).
 *
 * If none exists, the user is bucketed deterministically (dec-6: hash(user_id) →
 * 50/50 across the experiment's variants, ordered by arm key so A/B is stable),
 * and an `assigned_by='auto'` row is inserted and returned. The auto path records
 * NO `assigned_by_user_id` (NULL for 'auto' per the schema): an automatic split has
 * no human principal behind it. A later OPERATOR/AGENT reassignment is a separate
 * Backstage path that supersedes this row (sets superseded_at) and inserts a new
 * active row — history is retained, which is why reads filter on superseded_at.
 *
 * Throws if the experiment key is unknown or the experiment has no variants — both
 * are configuration defects the caller (provisioning) wraps best-effort so signup
 * is never blocked.
 */
export async function resolveOrCreateAssignment(
  userId: string,
  experimentKey: string,
  ctx: RequestCtx = { channel: "server" },
  conn: Db = db,
): Promise<ExperimentAssignment> {
  const [experiment] = await conn
    .select()
    .from(experiments)
    .where(eq(experiments.key, experimentKey))
    .limit(1);
  if (!experiment) {
    throw new Error(`experiments: no experiment with key '${experimentKey}'`);
  }

  // Already assigned? Return the single active row (dec-6: no re-roll, no read of
  // prior state beyond this user). The partial unique index guarantees at most one.
  const [active] = await conn
    .select()
    .from(experimentAssignments)
    .where(
      and(
        eq(experimentAssignments.userId, userId),
        eq(experimentAssignments.experimentId, experiment.id),
        isNull(experimentAssignments.supersededAt),
      ),
    )
    .limit(1);
  if (active) return active;

  // Bucket across the experiment's arms, ordered by key so the A→0 / B→1 mapping is
  // stable and reproducible regardless of insertion order (dec-6).
  const variants = await conn
    .select()
    .from(experimentVariants)
    .where(eq(experimentVariants.experimentId, experiment.id))
    .orderBy(experimentVariants.key);
  if (variants.length === 0) {
    throw new Error(`experiments: experiment '${experimentKey}' has no variants`);
  }
  const variant = variants[deterministicBucket(userId, variants.length)];

  const [row] = await conn
    .insert(experimentAssignments)
    .values({
      experimentId: experiment.id,
      variantId: variant.id,
      userId,
      assignedBy: "auto",
      // assigned_by_user_id stays NULL for 'auto' (schema): no human principal.
      // outcome defaults to 'pending'; assigned_at defaults to now().
    })
    .returning();

  log(
    `auto-assigned user=${userId} experiment=${experimentKey} variant=${variant.key} (${variant.behaviour}) channel=${ctx.channel ?? "server"}`,
  );
  return row;
}

/**
 * Operator/agent PIN: force `userId` onto the arm whose behaviour is `behaviour` for
 * `experimentKey`, regardless of the deterministic bucket. Supersedes any active
 * assignment (sets superseded_at; history retained — ac-14: one active row) and inserts
 * a fresh `assigned_by` row. This is the explicit-override sibling of
 * resolveOrCreateAssignment (the organic auto-bucket): the Backstage operator surface
 * and the e2e arm-pin hook both go through HERE rather than writing experiment_assignments
 * raw, so the test-only router stays service-routed (spec-172 ac-8). Returns the new
 * assignment + its variant key. Throws if the experiment or the behaviour's variant is
 * unknown.
 */
export async function pinAssignmentByBehaviour(
  userId: string,
  experimentKey: string,
  behaviour: string,
  opts: { assignedBy?: "operator" | "agent"; reason?: string } = {},
): Promise<{ assignment: ExperimentAssignment; variantKey: string }> {
  const [experiment] = await db
    .select({ id: experiments.id })
    .from(experiments)
    .where(eq(experiments.key, experimentKey))
    .limit(1);
  if (!experiment) {
    throw new Error(`experiments: no experiment with key '${experimentKey}'`);
  }
  const [variant] = await db
    .select({ id: experimentVariants.id, key: experimentVariants.key })
    .from(experimentVariants)
    .where(
      and(
        eq(experimentVariants.experimentId, experiment.id),
        eq(experimentVariants.behaviour, behaviour),
      ),
    )
    .limit(1);
  if (!variant) {
    throw new Error(
      `experiments: experiment '${experimentKey}' has no variant for behaviour '${behaviour}'`,
    );
  }

  // Supersede the current active assignment (if any), then insert the pin. The partial
  // unique index on (user, experiment) WHERE superseded_at IS NULL permits this — the old
  // row is no longer active once superseded.
  await db
    .update(experimentAssignments)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(experimentAssignments.userId, userId),
        eq(experimentAssignments.experimentId, experiment.id),
        isNull(experimentAssignments.supersededAt),
      ),
    );
  const [assignment] = await db
    .insert(experimentAssignments)
    .values({
      experimentId: experiment.id,
      variantId: variant.id,
      userId,
      assignedBy: opts.assignedBy ?? "operator",
      reason: opts.reason ?? null,
    })
    .returning();
  return { assignment, variantKey: variant.key };
}

// ── Verdict (dec-1 / ac-15) ────────────────────────────────────────────────────

/** The decided verdict, matching experiment_assignments.outcome's CHECK. */
export type ExperimentOutcome = "pending" | "succeeded" | "failed";

/**
 * Has the user authored their OWN first REAL spec since `since`? This reuses the
 * EXACT predicate journey-state's `hasSpec` milestone uses (journey-state.ts
 * ~L108-117): a `documents` row with createdByUserId = the user, docType='spec',
 * isDemo=false — the canonical "real spec" signal. The ONLY addition is the
 * `created_at > since` bound the verdict requires ("at any point AFTER assignment"),
 * which `getUserMilestones()` cannot express — so this is the SAME definition of a
 * real spec, narrowed in time, not a divergent one.
 *
 * `documents` is RLS-governed, so this runs under journey-state's runWithUserId
 * owner-visibility seam (migration 0098): with no app.memex_id set, app.user_id
 * activates the additive owner-visibility SELECT policy so the user's OWN authored
 * rows are visible cross-memex. Without it the count would filter to ZERO.
 */
async function hasAuthoredRealSpecSince(
  userId: string,
  since: Date,
  conn: Db,
): Promise<boolean> {
  return runWithUserId(userId, async () => {
    const [specRow] = await conn
      .select({ n: sql<number>`count(*)::int` })
      .from(documents)
      .where(
        and(
          eq(documents.createdByUserId, userId),
          eq(documents.docType, "spec"),
          eq(documents.isDemo, false),
          gt(documents.createdAt, since),
        ),
      );
    return (specRow?.n ?? 0) > 0;
  });
}

/**
 * Compute the verdict for one assignment against the experiment's success window
 * N (DAYS, the first-class experiments.window_days column — dec-2).
 *
 *   SUCCEEDED — the user authored their own first real spec at any point after the
 *               assignment was made (the success signal won; the window is moot).
 *   FAILED    — the window has FULLY elapsed (assigned_at + N days < now) with no
 *               such spec.
 *   PENDING   — otherwise (no spec yet, but the window is still open).
 *
 * This is the pure decision the 3-hourly sweep stamps inline onto each active
 * assignment (outcome + decided_at, ac-15). It does not write — the sweep persists.
 */
export async function computeVerdict(
  assignment: Pick<ExperimentAssignment, "userId" | "assignedAt">,
  windowDays: number,
  conn: Db = db,
): Promise<ExperimentOutcome> {
  const succeeded = await hasAuthoredRealSpecSince(
    assignment.userId,
    assignment.assignedAt,
    conn,
  );
  if (succeeded) return "succeeded";

  const windowEndMs = assignment.assignedAt.getTime() + windowDays * 24 * 60 * 60 * 1000;
  if (windowEndMs < Date.now()) return "failed";

  return "pending";
}
