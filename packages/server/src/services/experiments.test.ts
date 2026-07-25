// spec-426 — pure domain logic for the A/B experiment construct (Verify gap).
//
// Covers the three exported domain fns in services/experiments.ts against REAL
// Postgres (the experiment tables are RLS-EXCLUDED; tests run as the table OWNER so
// inserts + the verdict's documents count see every row directly — see
// home-specs.integration.test.ts for the same "owner role, RLS bypassed" posture):
//   - resolveOrCreateAssignment — deterministic bucketing, ~50/50 split, idempotent
//     active-row reuse, single-active-row supersession invariant, assigned_by='auto'
//     (ac-1 / ac-14).
//   - computeVerdict — succeeded / failed / pending against the per-experiment
//     window_days, including the boundary that proves the window (not a constant)
//     drives the verdict (ac-5 / ac-10).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-509 dec-3: the behaviour registry and runVariantBehaviour are GONE, along with the
// last seeder they dispatched to — so there is no seeder to mock here any more. What
// remains under test is the general construct: bucketing, assignment, and the verdict.
import { db } from "../db/connection.js";
import {
  documents,
  experiments,
  experimentVariants,
  experimentAssignments,
  memexes,
  namespaces,
  users,
} from "../db/schema.js";
import {
  resolveOrCreateAssignment,
  pinAssignmentByBehaviour,
  computeVerdict,
} from "./experiments.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-426/acs/ac-${n}`;
// spec-474 co-tags: this suite is the living proof that the reusable experiment framework
// (deterministic bucketing, the verdict sweep, behaviour dispatch) survives the demo-arm
// retirement intact (ac-6), that the behaviour registry now dispatches to the starter-spec
// control with no handhold_demo entry (ac-11), and that the variant CHECK still permits the
// historical 'handhold_demo' A-arm row (ac-14).
const AC474 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-474/acs/ac-${n}`;
// spec-509 dec-3: this suite is now also the proof that the variant-behaviour hook is
// gone and that the general construct survived its removal.
const AC509 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-509/acs/ac-${n}`;

const rand = () => Math.random().toString(36).slice(2, 8);
const unique = (p: string) => `${p}-${Date.now().toString(36)}-${rand()}`;
const DAY_MS = 24 * 60 * 60 * 1000;

const createdExperimentIds: string[] = [];
const createdMemexIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  // experiments CASCADE to their variants + assignments; memexes CASCADE to their
  // documents. Users last (assignments cascade on user delete too, but the experiment
  // delete already removed them).
  if (createdExperimentIds.length) {
    await db.delete(experiments).where(inArray(experiments.id, createdExperimentIds)).catch(() => {});
  }
  if (createdMemexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
});

/** Create a running 2-arm experiment (A=control/handhold_demo, B=treatment/starter_spec). */
async function makeExperiment(opts: { windowDays?: number; status?: string } = {}) {
  const [exp] = await db
    .insert(experiments)
    .values({
      key: unique("exp"),
      statement: "test hypothesis",
      status: opts.status ?? "running",
      windowDays: opts.windowDays ?? 7,
    })
    .returning();
  createdExperimentIds.push(exp.id);
  await db.insert(experimentVariants).values([
    { experimentId: exp.id, key: "A", label: "Control", isControl: true, behaviour: "handhold_demo" },
    { experimentId: exp.id, key: "B", label: "Treatment", isControl: false, behaviour: "starter_spec" },
  ]);
  return exp;
}

async function makeUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `exp426-${unique("u")}@example.com` })
    .returning({ id: users.id });
  createdUserIds.push(u.id);
  return u.id;
}

async function makeMemex(): Promise<string> {
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: unique("exp426").slice(0, 39), kind: "org" })
    .returning();
  createdNamespaceIds.push(ns.id);
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: "Experiments verdict test" })
    .returning();
  createdMemexIds.push(mx.id);
  return mx.id;
}

/** Insert a documents row with full control over the columns the verdict reads. */
async function seedSpec(
  memexId: string,
  opts: { authorId: string | null; docType?: string; isDemo?: boolean; createdAt: Date },
): Promise<void> {
  await db.insert(documents).values({
    memexId,
    handle: unique("spec"),
    title: "Test spec",
    docType: opts.docType ?? "spec",
    createdByUserId: opts.authorId,
    isDemo: opts.isDemo ?? false,
    createdAt: opts.createdAt,
  });
}

async function activeRows(userId: string, experimentId: string) {
  return db
    .select()
    .from(experimentAssignments)
    .where(
      and(
        eq(experimentAssignments.userId, userId),
        eq(experimentAssignments.experimentId, experimentId),
        isNull(experimentAssignments.supersededAt),
      ),
    );
}

// ── resolveOrCreateAssignment (ac-1 / ac-14) ──────────────────────────────────

describe("resolveOrCreateAssignment", () => {
  it("buckets the same user to the same variant on a re-roll — deterministic & reproducible", async () => {
    tagAc(AC(1));
    tagAc(AC(14));
    const exp = await makeExperiment();
    const userId = await makeUser();

    const first = await resolveOrCreateAssignment(userId, exp.key);
    // Delete the active row so the next call re-buckets from scratch (rather than
    // returning the existing row), proving the bucketing is a pure fn of the user id.
    await db.delete(experimentAssignments).where(eq(experimentAssignments.id, first.id));
    const second = await resolveOrCreateAssignment(userId, exp.key);

    expect(second.variantId).toBe(first.variantId);
  });

  it("splits many synthetic users roughly 50/50 across the two arms (each arm > 30%)", async () => {
    tagAc(AC(1));
    tagAc(AC(14));
    tagAc(AC474(6)); // spec-474: deterministic bucketing across both arms remains intact
    tagAc(AC474(14)); // spec-474: the A-arm 'handhold_demo' variant row still inserts (CHECK permits it)
    // spec-509 dec-3: same two facts are what ac-17 commits to — the construct still
    // buckets, and the legacy handhold_demo variant row is still insertable/readable
    // after the behaviour hook was deleted.
    tagAc(AC509(17));
    const exp = await makeExperiment();
    const N = 200;

    const rows = Array.from({ length: N }, () => ({ email: `exp426-dist-${unique("u")}@example.com` }));
    const inserted = await db.insert(users).values(rows).returning({ id: users.id });
    for (const u of inserted) createdUserIds.push(u.id);

    const [variantA] = await db
      .select()
      .from(experimentVariants)
      .where(and(eq(experimentVariants.experimentId, exp.id), eq(experimentVariants.key, "A")));

    let a = 0;
    for (const u of inserted) {
      const assignment = await resolveOrCreateAssignment(u.id, exp.key);
      if (assignment.variantId === variantA.id) a += 1;
    }
    const b = N - a;
    expect(a / N).toBeGreaterThan(0.3);
    expect(b / N).toBeGreaterThan(0.3);
  }, 60_000);

  it("returns the existing active assignment on a second call — no duplicate active row", async () => {
    tagAc(AC(14));
    const exp = await makeExperiment();
    const userId = await makeUser();

    const first = await resolveOrCreateAssignment(userId, exp.key);
    const second = await resolveOrCreateAssignment(userId, exp.key);

    expect(second.id).toBe(first.id);
    const active = await activeRows(userId, exp.id);
    expect(active).toHaveLength(1);
  });

  it("records the auto split with assigned_by='auto' and no human principal", async () => {
    tagAc(AC(14));
    const exp = await makeExperiment();
    const userId = await makeUser();

    const assignment = await resolveOrCreateAssignment(userId, exp.key);

    expect(assignment.assignedBy).toBe("auto");
    expect(assignment.assignedByUserId).toBeNull();
    expect(assignment.outcome).toBe("pending");
  });

  it("supersession retains history yet leaves exactly one active row per (user, experiment)", async () => {
    tagAc(AC(14));
    const exp = await makeExperiment();
    const userId = await makeUser();

    const auto = await resolveOrCreateAssignment(userId, exp.key);
    // Supersede the auto row + insert a new active (operator) row — the Backstage
    // reassignment shape. The partial unique index permits this because only ONE row
    // has superseded_at IS NULL.
    await db
      .update(experimentAssignments)
      .set({ supersededAt: new Date() })
      .where(eq(experimentAssignments.id, auto.id));
    const [reassigned] = await db
      .insert(experimentAssignments)
      .values({
        experimentId: auto.experimentId,
        variantId: auto.variantId,
        userId,
        assignedBy: "operator",
        reason: "test reassignment",
      })
      .returning();

    const active = await activeRows(userId, exp.id);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(reassigned.id);

    // History is retained — both rows still exist.
    const all = await db
      .select()
      .from(experimentAssignments)
      .where(and(eq(experimentAssignments.userId, userId), eq(experimentAssignments.experimentId, exp.id)));
    expect(all).toHaveLength(2);

    // resolveOrCreateAssignment now returns the active (reassigned) row, not history.
    const resolved = await resolveOrCreateAssignment(userId, exp.key);
    expect(resolved.id).toBe(reassigned.id);

    // The single-active invariant is index-enforced: a second active row is rejected.
    await expect(
      db.insert(experimentAssignments).values({
        experimentId: auto.experimentId,
        variantId: auto.variantId,
        userId,
        assignedBy: "agent",
      }),
    ).rejects.toThrow();
  });

  it("throws on an unknown experiment key", async () => {
    await expect(resolveOrCreateAssignment(await makeUser(), "no-such-experiment")).rejects.toThrow(
      /no experiment/,
    );
  });
});

// ── pinAssignmentByBehaviour — operator/agent override (ac-14) ────────────────

describe("pinAssignmentByBehaviour", () => {
  it("pins a user to the behaviour's variant, recorded as an operator assignment", async () => {
    tagAc(AC(14));
    const exp = await makeExperiment();
    const userId = await makeUser();

    const { assignment, variantKey } = await pinAssignmentByBehaviour(
      userId,
      exp.key,
      "starter_spec",
      { assignedBy: "operator", reason: "test pin" },
    );

    expect(variantKey).toBe("B"); // B = the starter_spec arm (makeExperiment)
    expect(assignment.assignedBy).toBe("operator");
    const active = await activeRows(userId, exp.id);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(assignment.id);
  });

  it("supersedes a prior active assignment — one active row, history retained", async () => {
    tagAc(AC(14));
    const exp = await makeExperiment();
    const userId = await makeUser();

    const auto = await resolveOrCreateAssignment(userId, exp.key); // organic auto-bucket
    const { assignment } = await pinAssignmentByBehaviour(userId, exp.key, "starter_spec");

    const active = await activeRows(userId, exp.id);
    expect(active).toHaveLength(1); // exactly one active row after the pin
    expect(active[0].id).toBe(assignment.id);
    expect(active[0].id).not.toBe(auto.id); // the auto row was superseded, not deleted
  });

  it("throws on an unknown behaviour", async () => {
    const exp = await makeExperiment();
    const userId = await makeUser();
    await expect(
      pinAssignmentByBehaviour(userId, exp.key, "not_a_real_behaviour"),
    ).rejects.toThrow(/no variant for behaviour/);
  });
});

// ── The provisioning-behaviour hook is GONE (spec-509 dec-3) ──────────────────
//
// spec-426 ac-12 used to be verified here by a dispatch test. spec-509 dec-3 deleted the
// whole hook — VariantBehaviour / CONTROL_BEHAVIOUR / BEHAVIOUR_REGISTRY /
// runVariantBehaviour — after grounding that runVariantBehaviour had NO production
// callers (spec-474 dec-1 wired provisioning to call the seeder directly and orphaned the
// dispatcher), and after dec-2 deleted the last seeder it could have dispatched to.
//
// So the assertion inverts: the module must export none of them. This is the guard
// against a well-meaning future change re-adding an empty registry or a no-op control
// behaviour — either would put a switchboard wired to nothing back on the signup path.

describe("provisioning-behaviour hook (spec-509 dec-3: removed)", () => {
  it("exports no variant-behaviour registry, control constant, or dispatcher", async () => {
    tagAc(AC509(16));
    const mod = await import("./experiments.js");
    const surface = Object.keys(mod);

    expect(surface).not.toContain("runVariantBehaviour");
    expect(surface).not.toContain("CONTROL_BEHAVIOUR");
    expect(surface).not.toContain("BEHAVIOUR_REGISTRY");
    expect(surface).not.toContain("VariantBehaviour");
  });

  // The other half of dec-3: what SURVIVES. The general construct is still exported and
  // still exercised by the suites above — deleting the hook must not have taken the
  // bucketing/assignment/verdict API with it.
  it("still exports the general experiments construct", async () => {
    tagAc(AC509(17));
    const mod = await import("./experiments.js");
    const surface = Object.keys(mod);

    expect(surface).toContain("resolveOrCreateAssignment");
    expect(surface).toContain("pinAssignmentByBehaviour");
    expect(surface).toContain("computeVerdict");
  });
});

// ── computeVerdict (ac-5 / ac-10) ─────────────────────────────────────────────

describe("computeVerdict", () => {
  let memexId: string;
  let author: string;

  beforeAll(async () => {
    memexId = await makeMemex();
    author = await makeUser();
  });

  it("'succeeded' when the user authored a non-demo spec AFTER assignment", async () => {
    tagAc(AC(5));
    tagAc(AC(10));
    const assignedAt = new Date(Date.now() - 2 * DAY_MS);
    await seedSpec(memexId, { authorId: author, createdAt: new Date(Date.now() - 1 * DAY_MS) });

    const verdict = await computeVerdict({ userId: author, assignedAt }, 7);
    expect(verdict).toBe("succeeded");
  });

  it("'failed' once the window has FULLY elapsed with no qualifying spec", async () => {
    tagAc(AC(5));
    tagAc(AC(10));
    const loner = await makeUser(); // a user who authored nothing
    const assignedAt = new Date(Date.now() - 10 * DAY_MS);

    const verdict = await computeVerdict({ userId: loner, assignedAt }, 7);
    expect(verdict).toBe("failed");
  });

  it("'pending' while still inside the window with no qualifying spec", async () => {
    tagAc(AC(5));
    tagAc(AC(10));
    const loner = await makeUser();
    const assignedAt = new Date(Date.now() - 1 * DAY_MS);

    const verdict = await computeVerdict({ userId: loner, assignedAt }, 7);
    expect(verdict).toBe("pending");
  });

  it("the per-experiment window_days — NOT a constant — drives the failed/pending boundary", async () => {
    tagAc(AC(10));
    const loner = await makeUser();
    const assignedAt = new Date(Date.now() - 3 * DAY_MS); // 3 days ago, no spec

    // Same assignment, two windows: a 1-day window has elapsed (failed); a 30-day
    // window is still open (pending). Proves the verdict reads the window per row.
    expect(await computeVerdict({ userId: loner, assignedAt }, 1)).toBe("failed");
    expect(await computeVerdict({ userId: loner, assignedAt }, 30)).toBe("pending");
  });

  it("ignores demo specs, pre-assignment specs, and other users' specs", async () => {
    tagAc(AC(5));
    const subject = await makeUser();
    const other = await makeUser();
    const assignedAt = new Date(Date.now() - 5 * DAY_MS);

    // (a) a DEMO spec after assignment — excluded (is_demo=false predicate).
    await seedSpec(memexId, { authorId: subject, isDemo: true, createdAt: new Date(Date.now() - 1 * DAY_MS) });
    // (b) a real spec authored BEFORE assignment — excluded (created_at > since).
    await seedSpec(memexId, { authorId: subject, createdAt: new Date(Date.now() - 9 * DAY_MS) });
    // (c) another user's real spec after assignment — excluded (created_by = subject).
    await seedSpec(memexId, { authorId: other, createdAt: new Date(Date.now() - 1 * DAY_MS) });

    // Window fully elapsed and none of the above qualify → failed, not succeeded.
    expect(await computeVerdict({ userId: subject, assignedAt }, 1)).toBe("failed");
  });
});
