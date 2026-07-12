// spec-426 — pure domain logic for the A/B experiment construct (Verify gap).
//
// Covers the three exported domain fns in services/experiments.ts against REAL
// Postgres (the experiment tables are RLS-EXCLUDED; tests run as the table OWNER so
// inserts + the verdict's documents count see every row directly — see
// home-specs.integration.test.ts for the same "owner role, RLS bypassed" posture):
//   - resolveOrCreateAssignment — deterministic bucketing, ~50/50 split, idempotent
//     active-row reuse, single-active-row supersession invariant, assigned_by='auto'
//     (ac-1 / ac-14).
//   - runVariantBehaviour — behaviour-id → seed-fn dispatch + unknown→control
//     fallback (ac-12). The two seeders are mocked so dispatch is observable without
//     running a full seed.
//   - computeVerdict — succeeded / failed / pending against the per-experiment
//     window_days, including the boundary that proves the window (not a constant)
//     drives the verdict (ac-5 / ac-10).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-474 dec-1: the behaviour registry now dispatches to a SINGLE seeder
// (seedStarterSpec) — the demo-vs-starter experiment concluded with the starter Spec as
// the winner and seedHandholdDemo was deleted. Mock the seeder so runVariantBehaviour's
// dispatch is observable without a real DB seed. experiments.ts imports `seedStarterSpec`
// from this exact path, so the mock lands on its import. The assignment + verdict tests
// below don't touch the seed.
vi.mock("./starter-spec.js", () => ({ seedStarterSpec: vi.fn().mockResolvedValue(undefined) }));

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
  runVariantBehaviour,
  computeVerdict,
  CONTROL_BEHAVIOUR,
} from "./experiments.js";
import { seedStarterSpec } from "./starter-spec.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-426/acs/ac-${n}`;

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

// ── runVariantBehaviour (ac-12) ───────────────────────────────────────────────

describe("runVariantBehaviour", () => {
  beforeEach(() => {
    vi.mocked(seedStarterSpec).mockClear();
  });

  it("dispatches 'starter_spec' to seedStarterSpec", async () => {
    tagAc(AC(12));
    await runVariantBehaviour("starter_spec", "memex-2", { channel: "server" });
    expect(seedStarterSpec).toHaveBeenCalledWith("memex-2", { channel: "server" });
  });

  // spec-474 dec-1: with a single behaviour left, an UNKNOWN / legacy (e.g. the retired
  // `handhold_demo`) behaviour id falls back to the control — the seeded starter Spec.
  it("falls back to the control behaviour for an UNKNOWN / legacy behaviour id", async () => {
    tagAc(AC(12));
    expect(CONTROL_BEHAVIOUR).toBe("starter_spec");
    await runVariantBehaviour("handhold_demo", "memex-3");
    expect(seedStarterSpec).toHaveBeenCalledWith("memex-3", expect.anything());
  });

  it("falls back to the control behaviour for a MISSING (empty) behaviour id", async () => {
    tagAc(AC(12));
    await runVariantBehaviour("", "memex-4");
    expect(seedStarterSpec).toHaveBeenCalledWith("memex-4", expect.anything());
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
