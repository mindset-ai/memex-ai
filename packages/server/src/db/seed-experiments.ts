// Default-experiment seed (spec-426 dec-5 / s-5). The construct's FIRST experiment
// — the new-user provisioning A/B (demo walkthrough vs seeded starter spec) — must
// exist as data before the provisioning branch can resolve an assignment against it.
//
// s-5 left the seed's HOME a fork ("migration data vs an app-boot ensure vs a
// Backstage action"); we take the app-boot ensure. It runs once per boot, is fully
// idempotent (every write is ON CONFLICT DO NOTHING against the table's unique key),
// and is wired best-effort in index.ts so a seed fault degrades to "the experiment
// is simply absent" — provisioning then falls back to the control behaviour rather
// than blocking signup (dec-4 / ac-7), never to a failed boot.
//
// The experiment tables are platform-global and RLS-EXCLUDED (schema.ts, migration
// 0116, the comms_log posture), so this uses the default `db` connection directly —
// no runWithMemexId — exactly as services/experiments.ts does.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "./connection.js";
import { experiments, experimentVariants } from "./schema.js";

/**
 * The stable key of the canonical provisioning experiment. EXPORTED so the
 * provisioning branch (user-namespaces.ts seedNewPersonalMemex) and any Backstage
 * read can resolve the SAME experiment without a magic string drifting between call
 * sites. resolveOrCreateAssignment(userId, DEFAULT_EXPERIMENT_KEY) is the entry.
 */
// spec-426 (Verify): reconciled to the canonical slug documented in the schema
// comment (db/schema.ts experiments.key) AND used by the provisioning resolver
// (user-namespaces.PROVISIONING_EXPERIMENT_KEY re-exports THIS const). The boot
// seed and the provisioning lookup MUST share one string or the treatment arm
// never fires — earlier this const was 'onboarding_demo_vs_starter' while
// provisioning resolved 'provisioning_demo_vs_starter', so every user silently
// degraded to control. Single source of truth, here.
export const DEFAULT_EXPERIMENT_KEY = "provisioning_demo_vs_starter";

/**
 * Ensure the canonical provisioning experiment + its A/B variants exist. Idempotent
 * and safe on every boot (and across concurrent instances): the experiment INSERT
 * conflicts on its unique `key`, each variant INSERT conflicts on the
 * (experiment_id, key) unique index, and a conflict is a no-op. Returns silently
 * whether it created the rows or found them already present.
 *
 * Variants (dec-4 / dec-6 — a deterministic 50/50 split across these two arms):
 *   A — control, behaviour 'handhold_demo'  (spec-178's fixed demo walkthrough)
 *   B — treatment, behaviour 'starter_spec' (the seeded "Understanding Memex" spec)
 */
export async function ensureDefaultExperiment(): Promise<void> {
  // 1. The experiment. ON CONFLICT (key) DO NOTHING — present-on-reboot is a no-op.
  await db
    .insert(experiments)
    .values({
      key: DEFAULT_EXPERIMENT_KEY,
      statement:
        "We think a seeded, system-attributed starter spec (B) drives more net-new users to author their own first real spec than the fixed demo walkthrough (A), because a concrete worked example is easier to extend than a read-only tour.",
      // Seeded INACTIVE (draft) — provisioning degrades to control (the handhold demo)
      // for everyone until an operator deliberately flips this to 'running' in Backstage
      // (resolveProvisioningBehaviour gates on status==='running', ac-13). This keeps the
      // experiment from silently splitting 50% of all signups onto the treatment arm at
      // deploy time; activation is a conscious operator action, not a side effect of boot.
      status: "draft",
      // dec-2: the success window N in DAYS — first-class column, default 7.
      windowDays: 7,
      // Decorative predicate (the load-bearing window lives in window_days above).
      outcomeRule: { milestone: "hasSpec", window_days: 7 },
    })
    .onConflictDoNothing();

  // Re-read to get the (possibly pre-existing) id the variant FKs hang off.
  const [experiment] = await db
    .select({ id: experiments.id })
    .from(experiments)
    .where(eq(experiments.key, DEFAULT_EXPERIMENT_KEY))
    .limit(1);
  if (!experiment) {
    // Should be unreachable (we just upserted it), but never let a missing row throw
    // on the boot path — the best-effort caller logs and continues.
    return;
  }

  // 2. The two arms. One source of truth for the seed so the insert and the
  //    description backfill below can't drift.
  const variantSeed = [
    {
      key: "A",
      label: "Handhold demo walkthrough",
      description:
        "Control — spec-178's existing onboarding. The new user's workspace is seeded with the five-phase handhold demo: five frozen example Specs (one per lifecycle phase) shown as a progressive-reveal walkthrough on the Specs board, with a DEMO badge and a per-phase value banner. A read-only guided tour of what a Spec looks like from draft through done. The user still lands on /home and must author their own Spec to advance onboarding.",
      isControl: true,
      behaviour: "handhold_demo" as const,
    },
    {
      key: "B",
      label: "Understanding Memex starter spec",
      description:
        "Treatment — a seeded starter Spec instead of the demo. The new user's workspace gets one real, editable \"Understanding Memex\" Spec (status `specify`, is_demo=false) sitting in the Specify column: a worked example with genuine resolved decisions and scope acceptance criteria they can extend in place. It is system-attributed, so it does not light hasSpec — the user must still author their own Spec. Hypothesis: a concrete, extendable example converts more net-new users to authoring their own first Spec than a read-only tour.",
      isControl: false,
      behaviour: "starter_spec" as const,
    },
  ];

  // Each ON CONFLICT (experiment_id, key) DO NOTHING — present-on-reboot is a no-op.
  await db
    .insert(experimentVariants)
    .values(variantSeed.map((v) => ({ experimentId: experiment.id, ...v })))
    .onConflictDoNothing();

  // NULL-only description backfill. The insert above won't touch an arm that already
  // exists (DO NOTHING), so a row created before the description column existed (or by a
  // pre-spec-426 seed) would keep description = NULL forever. Fill it here — but ONLY
  // where it's NULL, so we never clobber a non-NULL description an operator later edits
  // in Backstage. This runs every boot, so it self-heals regardless of deploy order; the
  // migration can't do this (it runs before these rows are seeded). Idempotent once filled.
  for (const v of variantSeed) {
    await db
      .update(experimentVariants)
      .set({ description: v.description })
      .where(
        and(
          eq(experimentVariants.experimentId, experiment.id),
          eq(experimentVariants.key, v.key),
          isNull(experimentVariants.description),
        ),
      );
  }
}
