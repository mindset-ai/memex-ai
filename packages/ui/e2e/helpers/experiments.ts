// spec-426 e2e seed helper — pin a fresh user onto a specific Experiments arm.
//
// The Experiments construct (spec-426) auto-assigns every new signup to an arm via
// a deterministic hash(user_id) → 50/50 split (dec-6). A hash over an opaque UUID is
// NOT controllable from a test, so a journey that needs a SPECIFIC arm (Variant A vs
// Variant B) cannot rely on the auto-split. The faithful way to pin the arm is the
// same construct an operator uses in Backstage: an `assigned_by='operator'` assignment
// that SUPERSEDES the auto row (spec-426 ac-14 — "reassignment supersedes the prior
// row while retaining history"). This helper exposes that operator-reassign over the
// env-gated test surface, plus the one-time experiment+variants ensure, plus running
// the variant's provisioning behaviour so the memex carries the arm's seeded content.
//
// ── REQUIRES A SERVER TEST ENDPOINT THAT DOES NOT EXIST YET ───────────────────
// This module is a thin HTTP client of `POST /api/__test__/seed-experiment-arm`. That
// endpoint is NOT yet mounted in packages/server/src/routes/__test__.ts — it is the
// hook these journeys need and is described in the task's integrationNotes. Until it
// lands, `seedExperimentArm` throws `ExperimentHookUnavailableError` (the endpoint
// 404s), and the journeys `test.skip()` on it — so they stay visibly unverified
// (afterEach no-ops AC emission on skip) rather than failing the PR gate. Once the
// endpoint is mounted the journeys run for real with no test change.
//
// Mirrors helpers/seed.ts: hits the server origin directly (default 8090), never the
// Vite proxy, so seeding is independent of the browser page. No raw SQL [per std-28].

const API_URL =
  process.env.E2E_API_URL ??
  `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;

/** Thrown when the /seed-experiment-arm test endpoint is not mounted (404) — the
 *  signal the spec-426 journeys use to skip cleanly until the hook lands. */
export class ExperimentHookUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentHookUnavailableError";
  }
}

/** The provisioning-experiment arm this helper can seed (spec-426 dec-4 registry id):
 *  starter_spec = the "Understanding Memex" real, system-attributed spec. spec-474
 *  ended the experiment and removed the former handhold_demo (control) arm. */
export type ExperimentBehaviour = "starter_spec";

export interface SeededExperimentArm {
  /** The user the arm was pinned onto (resolved/ensured from `email`). */
  userId: string;
  /** That user's personal memex — the surface the arm's behaviour seeded into. */
  memexId: string;
  /** The arm's variant key on the experiment (e.g. "A" / "B"). */
  variantKey: string;
  /** The behaviour id that was run (echoes the request). */
  behaviour: ExperimentBehaviour;
  /** The new active assignment row's id. */
  assignmentId: string;
  /** For the starter_spec arm: the seeded "Understanding Memex" spec's handle, so a
   *  journey can navigate straight to its canonical path. */
  starterSpecHandle?: string;
}

/**
 * Pin `email`'s user onto the experiment arm with behaviour `behaviour`, seeding that
 * arm's content into their personal memex. Deterministic and idempotent: re-pinning
 * the same arm is a no-op beyond superseding any active assignment.
 *
 * The backing endpoint (see module header) must, in one call:
 *   1. ensure the user + personal memex exist (ensureUserNamespace),
 *   2. ensure the first provisioning experiment + its A/B variants exist (idempotent),
 *   3. supersede any active assignment for (user, experiment) and insert a fresh
 *      `assigned_by='operator'` assignment to the variant whose behaviour matches
 *      (spec-426 ac-14 — one active assignment per (user, experiment), history kept),
 *   4. RESET the memex's seeded onboarding content (delete any is_demo specs AND any
 *      system-attributed "Understanding Memex" starter spec) so the two arms' seeds
 *      can't coexist when signup already auto-seeded the other arm, then
 *   5. run the variant's behaviour (experiments.ts runVariantBehaviour) to seed it.
 */
export async function seedExperimentArm(opts: {
  email: string;
  behaviour: ExperimentBehaviour;
  /** Optional override of the provisioning experiment key (the endpoint defaults it). */
  experimentKey?: string;
}): Promise<SeededExperimentArm> {
  const res = await fetch(`${API_URL}/api/__test__/seed-experiment-arm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (res.status === 404) {
    throw new ExperimentHookUnavailableError(
      "spec-426: POST /api/__test__/seed-experiment-arm is not mounted yet — the " +
        "experiment-arm test hook (see helpers/experiments.ts header) has not landed. " +
        "Skipping until it does; this journey carries no verification meanwhile.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `__test__ POST /seed-experiment-arm failed (${res.status}): ${text}`,
    );
  }
  return (await res.json()) as SeededExperimentArm;
}
