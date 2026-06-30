// spec-426 — the verdict sweep (services/experiment-sweep.ts), the Verify gap's
// other half. sweepExperimentVerdicts is the clock that settles each assignment's
// outcome (dec-1): one pass reads ACTIVE `pending` assignments whose experiment is
// `running`, asks computeVerdict per row, and stamps `succeeded`/`failed` + decided_at
// on those that resolve. These tests prove the stamping contract end-to-end against
// REAL Postgres (the experiment tables are RLS-EXCLUDED; tests run as the table OWNER,
// same posture as experiments.test.ts): stamps the right verdict, freezes non-running
// and superseded rows, is idempotent + a no-op once decided, and honours the batch
// bound (ac-9; the window math that drives succeeded/failed is ac-10).
//
// Each test starts from a clean slate (beforeEach wipes the experiment + documents
// tables) so a global sweep + the batch-limit assertion see only this test's rows —
// safe because the suite runs against a throwaway per-worker DB clone.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

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
import { sweepExperimentVerdicts } from "./experiment-sweep.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-426/acs/ac-${n}`;

const rand = () => Math.random().toString(36).slice(2, 8);
const unique = (p: string) => `${p}-${Date.now().toString(36)}-${rand()}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

const createdMemexIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdUserIds: string[] = [];

// Clean slate per test so a global sweep (it scans the whole table) and the
// batch-limit count see only the rows this test created. experiments cascade to
// variants + assignments; documents are wiped directly (verdict reads them).
beforeEach(async () => {
  await db.delete(experimentAssignments);
  await db.delete(experiments);
  await db.delete(documents);
});

afterAll(async () => {
  await db.delete(experiments).catch(() => {});
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

/** A 2-arm experiment (A=control, B=treatment); status + window are the knobs. */
async function makeExperiment(opts: { windowDays?: number; status?: string } = {}) {
  const [exp] = await db
    .insert(experiments)
    .values({
      key: unique("exp"),
      statement: "sweep test hypothesis",
      status: opts.status ?? "running",
      windowDays: opts.windowDays ?? 7,
    })
    .returning();
  const variants = await db
    .insert(experimentVariants)
    .values([
      { experimentId: exp.id, key: "A", label: "Control", isControl: true, behaviour: "handhold_demo" },
      { experimentId: exp.id, key: "B", label: "Treatment", isControl: false, behaviour: "starter_spec" },
    ])
    .returning();
  return { exp, variantA: variants.find((v) => v.key === "A")! };
}

async function makeUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `exp426sweep-${unique("u")}@example.com` })
    .returning({ id: users.id });
  createdUserIds.push(u.id);
  return u.id;
}

async function makeMemex(): Promise<string> {
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: unique("ex426sw").slice(0, 39), kind: "org" })
    .returning();
  createdNamespaceIds.push(ns.id);
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: "Sweep verdict test" })
    .returning();
  createdMemexIds.push(mx.id);
  return mx.id;
}

/** A spec authored by `authorId` (drives computeVerdict's hasSpec signal). */
async function seedSpec(
  memexId: string,
  opts: { authorId: string; isDemo?: boolean; createdAt: Date },
): Promise<void> {
  await db.insert(documents).values({
    memexId,
    handle: unique("spec"),
    title: "Authored spec",
    docType: "spec",
    createdByUserId: opts.authorId,
    isDemo: opts.isDemo ?? false,
    createdAt: opts.createdAt,
  });
}

/** Insert an assignment row with full control over the columns the sweep reads. */
async function makeAssignment(
  experimentId: string,
  variantId: string,
  userId: string,
  opts: { assignedAt: Date; outcome?: string; supersededAt?: Date | null; decidedAt?: Date | null },
) {
  const [a] = await db
    .insert(experimentAssignments)
    .values({
      experimentId,
      variantId,
      userId,
      assignedAt: opts.assignedAt,
      assignedBy: "auto",
      outcome: opts.outcome ?? "pending",
      supersededAt: opts.supersededAt ?? null,
      decidedAt: opts.decidedAt ?? null,
    })
    .returning();
  return a;
}

async function rowById(id: string) {
  const [r] = await db.select().from(experimentAssignments).where(eq(experimentAssignments.id, id));
  return r;
}

// ── stamping the right verdict (ac-9 / ac-10) ─────────────────────────────────

describe("sweepExperimentVerdicts", () => {
  it("stamps 'succeeded' + decided_at when the user authored a real spec inside the window", async () => {
    tagAc(AC(9));
    const { exp, variantA } = await makeExperiment({ windowDays: 7 });
    const userId = await makeUser();
    const memexId = await makeMemex();
    const a = await makeAssignment(exp.id, variantA.id, userId, { assignedAt: daysAgo(2) });
    // a non-demo spec authored by the user AFTER assignment → success signal
    await seedSpec(memexId, { authorId: userId, createdAt: daysAgo(1) });

    const decided = await sweepExperimentVerdicts();

    expect(decided).toBeGreaterThanOrEqual(1);
    const row = await rowById(a.id);
    expect(row.outcome).toBe("succeeded");
    expect(row.decidedAt).not.toBeNull();
  });

  it("stamps 'failed' + decided_at once the window has closed with no spec", async () => {
    tagAc(AC(9));
    tagAc(AC(10));
    const { exp, variantA } = await makeExperiment({ windowDays: 1 });
    const userId = await makeUser();
    const a = await makeAssignment(exp.id, variantA.id, userId, { assignedAt: daysAgo(5) });

    await sweepExperimentVerdicts();

    const row = await rowById(a.id);
    expect(row.outcome).toBe("failed");
    expect(row.decidedAt).not.toBeNull();
  });

  it("leaves an assignment 'pending' while its window is still open (no spec yet)", async () => {
    tagAc(AC(9));
    tagAc(AC(10));
    const { exp, variantA } = await makeExperiment({ windowDays: 30 });
    const userId = await makeUser();
    const a = await makeAssignment(exp.id, variantA.id, userId, { assignedAt: daysAgo(2) });

    const decided = await sweepExperimentVerdicts();

    expect(decided).toBe(0);
    const row = await rowById(a.id);
    expect(row.outcome).toBe("pending");
    expect(row.decidedAt).toBeNull();
  });

  it("freezes assignments whose experiment is not 'running' (draft / concluded)", async () => {
    tagAc(AC(9));
    for (const status of ["draft", "concluded"]) {
      // a would-be-FAILED assignment (window closed, no spec) under a non-running experiment
      const { exp, variantA } = await makeExperiment({ windowDays: 1, status });
      const userId = await makeUser();
      const a = await makeAssignment(exp.id, variantA.id, userId, { assignedAt: daysAgo(5) });

      const decided = await sweepExperimentVerdicts();

      expect(decided).toBe(0);
      const row = await rowById(a.id);
      expect(row.outcome).toBe("pending");
      expect(row.decidedAt).toBeNull();
      // reset for the next status (beforeEach only runs between top-level its)
      await db.delete(experiments);
    }
  });

  it("never touches a superseded assignment — it is frozen history", async () => {
    tagAc(AC(9));
    const { exp, variantA } = await makeExperiment({ windowDays: 1 });
    const userId = await makeUser();
    // would FAIL on the merits, but it has been superseded → out of scope for the sweep
    const a = await makeAssignment(exp.id, variantA.id, userId, {
      assignedAt: daysAgo(5),
      supersededAt: daysAgo(1),
    });

    const decided = await sweepExperimentVerdicts();

    expect(decided).toBe(0);
    const row = await rowById(a.id);
    expect(row.outcome).toBe("pending");
  });

  it("is idempotent — a second pass decides nothing new and never re-stamps", async () => {
    tagAc(AC(9));
    const { exp, variantA } = await makeExperiment({ windowDays: 1 });
    const userId = await makeUser();
    const a = await makeAssignment(exp.id, variantA.id, userId, { assignedAt: daysAgo(5) });

    const first = await sweepExperimentVerdicts();
    expect(first).toBe(1);
    const afterFirst = await rowById(a.id);
    expect(afterFirst.outcome).toBe("failed");
    const stampedAt = afterFirst.decidedAt;

    const second = await sweepExperimentVerdicts();
    expect(second).toBe(0); // no-op once every live assignment is decided
    const afterSecond = await rowById(a.id);
    expect(afterSecond.outcome).toBe("failed");
    expect(afterSecond.decidedAt?.getTime()).toBe(stampedAt?.getTime()); // not re-stamped
  });

  it("honours the per-pass batch limit, draining the backlog across ticks", async () => {
    tagAc(AC(9));
    const { exp, variantA } = await makeExperiment({ windowDays: 1 });
    // two independent, decidable (failed) assignments
    const a1 = await makeAssignment(exp.id, variantA.id, await makeUser(), { assignedAt: daysAgo(5) });
    const a2 = await makeAssignment(exp.id, variantA.id, await makeUser(), { assignedAt: daysAgo(5) });

    const firstPass = await sweepExperimentVerdicts(1); // bound to one row
    expect(firstPass).toBe(1);
    const decidedCount1 =
      ((await rowById(a1.id)).outcome === "failed" ? 1 : 0) +
      ((await rowById(a2.id)).outcome === "failed" ? 1 : 0);
    expect(decidedCount1).toBe(1); // exactly one decided this pass

    const secondPass = await sweepExperimentVerdicts(1); // next tick drains the rest
    expect(secondPass).toBe(1);
    expect((await rowById(a1.id)).outcome).toBe("failed");
    expect((await rowById(a2.id)).outcome).toBe("failed");
  });
});
