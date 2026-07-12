// spec-474 dec-2 (ac-2 / ac-13) — the boot seed CONCLUDES the provisioning experiment.
//
// The demo-vs-starter A/B is over: Variant B (starter_spec) won and is now the
// unconditional seed. ensureDefaultExperiment must leave the canonical experiment row at
// status='concluded' with winner='B' recorded for the Backstage scoreboard — and it must
// SELF-HEAL a prod row still stuck at 'running' from when the experiment was live (the
// experiment INSERT is ON CONFLICT DO NOTHING, so only the guarded UPDATE can flip it).
// Crucially, concluding deletes NO history: both variant rows and every historical
// assignment remain present (the scoreboard still renders the A/B result).
//
// Runs against REAL Postgres. The experiment tables are platform-global + RLS-excluded, so
// this drives ensureDefaultExperiment directly (no runWithMemexId), exactly as the boot does.

import { describe, it, expect, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "./connection.js";
import { experiments, experimentVariants, experimentAssignments, users } from "./schema.js";
import { ensureDefaultExperiment, DEFAULT_EXPERIMENT_KEY } from "./seed-experiments.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-474/acs/ac-${n}`;

const createdAssignmentIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  // Only remove the synthetic assignment + user this test minted. The canonical experiment
  // row + its two variants are the boot seed — leave them (ensureDefaultExperiment already
  // restored status='concluded' as its final act).
  if (createdAssignmentIds.length) {
    await db.delete(experimentAssignments).where(inArray(experimentAssignments.id, createdAssignmentIds)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

describe("seed-experiments — the provisioning experiment is concluded on boot (spec-474 dec-2)", () => {
  it("ensureDefaultExperiment self-heals a 'running' row to concluded/winner=B and deletes no history (ac-2 / ac-13)", async () => {
    tagAc(AC(2)); // scope: experiment concluded with Variant B recorded as winner; tallies stay readable
    tagAc(AC(13)); // impl: status='concluded'; variants + historical assignments all remain present

    // Make sure the canonical experiment + variants exist to hang the fixtures off.
    await ensureDefaultExperiment();

    const [experiment] = await db
      .select({ id: experiments.id })
      .from(experiments)
      .where(eq(experiments.key, DEFAULT_EXPERIMENT_KEY))
      .limit(1);
    expect(experiment).toBeDefined();

    const variantsBefore = await db
      .select({ id: experimentVariants.id, key: experimentVariants.key, behaviour: experimentVariants.behaviour })
      .from(experimentVariants)
      .where(eq(experimentVariants.experimentId, experiment.id));
    const armA = variantsBefore.find((v) => v.key === "A");
    const armB = variantsBefore.find((v) => v.key === "B");
    expect(armA?.behaviour).toBe("handhold_demo"); // the historical control arm row survives
    expect(armB?.behaviour).toBe("starter_spec");

    // A historical assignment on the control arm — the kind the scoreboard tallies. It must
    // still be present after the experiment is concluded (conclusion is not a purge).
    const [user] = await db
      .insert(users)
      .values({ email: `exp474-concl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com` })
      .returning();
    createdUserIds.push(user.id);
    const [assignment] = await db
      .insert(experimentAssignments)
      .values({ experimentId: experiment.id, variantId: armA!.id, userId: user.id, assignedBy: "auto" })
      .returning();
    createdAssignmentIds.push(assignment.id);

    // Regress the row to 'running' (simulating a prod row from when the experiment was live)
    // — only the guarded UPDATE inside ensureDefaultExperiment can flip it back.
    await db.update(experiments).set({ status: "running" }).where(eq(experiments.id, experiment.id));

    // Boot again: the conclusion self-heals.
    await ensureDefaultExperiment();

    const [after] = await db
      .select({ status: experiments.status, outcomeRule: experiments.outcomeRule })
      .from(experiments)
      .where(eq(experiments.id, experiment.id))
      .limit(1);
    expect(after.status).toBe("concluded");
    expect((after.outcomeRule as { winner?: string } | null)?.winner).toBe("B");

    // ac-13: no rows deleted — both variants and the historical assignment remain.
    const variantsAfter = await db
      .select({ key: experimentVariants.key })
      .from(experimentVariants)
      .where(eq(experimentVariants.experimentId, experiment.id));
    expect(new Set(variantsAfter.map((v) => v.key))).toEqual(new Set(["A", "B"]));

    const [stillAssigned] = await db
      .select({ id: experimentAssignments.id })
      .from(experimentAssignments)
      .where(and(eq(experimentAssignments.id, assignment.id)));
    expect(stillAssigned).toBeDefined();

    // A second boot is a cheap no-op (idempotent) — still concluded.
    await ensureDefaultExperiment();
    const [twice] = await db
      .select({ status: experiments.status })
      .from(experiments)
      .where(eq(experiments.id, experiment.id))
      .limit(1);
    expect(twice.status).toBe("concluded");
  });
});
