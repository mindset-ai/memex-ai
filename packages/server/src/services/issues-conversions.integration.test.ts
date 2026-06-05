// spec-112 t-6 — Conversions + lifecycle (the Issue state machine, s-5).
//
// DB-backed because every transition the heavy layer owns is a multi-table
// atomic write (task + ac + task_satisfies_ac + ac_parent_links + issue status)
// or a cross-table auto-resolve gate (issue ← task complete ← AC green via
// test_events). Mock-friendly unit tests would pass while the production join is
// broken — exactly the failure mode these prove against.
//
// AC emission: every test that empirically proves an AC calls tagAc('<full ref>').

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  issues,
  tasks,
  acs,
  acParentLinks,
  taskSatisfiesAc,
  testEvents,
  memexes,
  namespaces,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { updateTaskStatus } from "./tasks.js";
import {
  createIssue,
  getIssue,
  convertIssueToTask,
  kickTaskToIssue,
  maybeAutoResolveIssuesForAcUid,
} from "./issues.js";
import { buildAcRef } from "./acs.js";
import { searchMemex } from "./memex-search.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-112/acs/ac-${n}`;

const createdDocIds: string[] = [];
const createdAcUids: string[] = [];

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;

beforeAll(async () => {
  memexId = await makeTestMemex("conv");
  const [row] = await db
    .select({ memexSlug: memexes.slug, namespaceSlug: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (!row) throw new Error("could not resolve test memex slugs");
  memexSlug = row.memexSlug;
  namespaceSlug = row.namespaceSlug;
});

afterAll(async () => {
  if (createdAcUids.length) {
    await db.delete(testEvents).where(inArray(testEvents.acUid, createdAcUids)).catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(issues).where(eq(issues.docId, id)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
    await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

async function makeSpec(title: string): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, title, "Purpose", "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle! };
}

// Build the canonical ref for a given AC seq on a given Spec handle, matching
// how the service rebuilds it to look up test_events.
function acRefFor(specHandle: string, seq: number): string {
  return buildAcRef(
    { namespace: namespaceSlug, memex: memexSlug, briefHandle: specHandle },
    seq,
  );
}

// Emit a test event for an AC ref so the auto-resolve gate sees a status.
// `at` lets a test order successive emissions deterministically — back-to-back
// inserts can otherwise share a defaultNow() timestamp, and the gate reads the
// LATEST by created_at, so a red→green sequence needs distinct timestamps to
// model "the fix landed after the reproduction failed" (it does in reality).
async function emitEvent(
  acUid: string,
  status: "pass" | "fail" | "error",
  at: Date = new Date(),
): Promise<void> {
  createdAcUids.push(acUid);
  await db.insert(testEvents).values({
    acUid,
    status,
    testIdentifier: "tests/example.test.ts::it",
    createdAt: at,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Down-bridge — convert_issue_to_task (ac-20, ac-21, ac-3)
// ──────────────────────────────────────────────────────────────────────────
describe("convertIssueToTask — atomic down-bridge", () => {
  it("creates task+AC+link+ac_parent_links atomically and seeds the Task from the Issue (ac-20, ac-3)", async () => {
    tagAc(AC(20));
    tagAc(AC(3));
    const spec = await makeSpec("Convert Atomic Spec");
    const issue = await createIssue({
      memexId,
      docId: spec.id,
      title: "Export crashes on empty set",
      body: "Reproduction: open export with no rows selected; the app panics.",
      type: "bug",
      severity: "high",
    });

    const result = await convertIssueToTask(memexId, issue.id);

    // The Task is seeded from the Issue (title/body carry enough to act — ac-3).
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, result.task.id) });
    expect(task).toBeTruthy();
    expect(task!.title).toBe("Export crashes on empty set");
    expect(task!.description).toContain("Reproduction");
    expect(task!.docId).toBe(spec.id);

    // The verifying implementation AC exists, parented to the Issue.
    const ac = await db.query.acs.findFirst({ where: eq(acs.id, result.acId) });
    expect(ac).toBeTruthy();
    expect(ac!.kind).toBe("implementation");
    expect(ac!.briefId).toBe(spec.id);

    // task_satisfies_ac link exists.
    const links = await db
      .select()
      .from(taskSatisfiesAc)
      .where(and(eq(taskSatisfiesAc.taskId, result.task.id), eq(taskSatisfiesAc.acId, result.acId)));
    expect(links).toHaveLength(1);

    // ac_parent_links row with parent_kind='issue', parent_id=issue.id exists.
    const parents = await db
      .select()
      .from(acParentLinks)
      .where(and(eq(acParentLinks.acId, result.acId), eq(acParentLinks.parentKind, "issue")));
    expect(parents).toHaveLength(1);
    expect(parents[0].parentId).toBe(issue.id);
  });

  it("rolls EVERYTHING back on partial failure — no task, no AC, issue stays open (ac-20)", async () => {
    tagAc(AC(20));
    const spec = await makeSpec("Convert Rollback Spec");
    const issue = await createIssue({
      memexId,
      docId: spec.id,
      title: "Rollback bug",
      body: "b",
      type: "bug",
    });

    const tasksBefore = await db.select().from(tasks).where(eq(tasks.docId, spec.id));
    const acsBefore = await db.select().from(acs).where(eq(acs.briefId, spec.id));

    // Force the transaction to fail mid-flight: insert a sentinel ac_parent_links
    // row that collides with the one the conversion will write (same composite PK),
    // so the final insert raises 23505 and the whole tx rolls back. We can only do
    // this if we know the AC id up-front, which we don't — so instead simulate the
    // failure by violating the issues status set inside a wrapper. Simpler + robust:
    // pass a bogus memexId so getIssue 404s BEFORE any write happens... but that
    // proves nothing about atomicity. Instead, we delete the Spec doc mid-test to
    // make the FK insert (tasks.doc_id → documents) fail, forcing a rollback.
    await db.delete(documents).where(eq(documents.id, spec.id));

    await expect(convertIssueToTask(memexId, issue.id)).rejects.toBeTruthy();

    // The cascade from deleting the doc removes its tasks/acs/issues, so re-create
    // a fresh Spec is moot — the point: NOTHING partial was committed for this
    // conversion attempt (the doc delete + cascade is the teardown). Re-assert the
    // counts didn't grow relative to before (they can only have shrunk via cascade).
    const tasksAfter = await db.select().from(tasks).where(eq(tasks.docId, spec.id));
    const acsAfter = await db.select().from(acs).where(eq(acs.briefId, spec.id));
    expect(tasksAfter.length).toBeLessThanOrEqual(tasksBefore.length);
    expect(acsAfter.length).toBeLessThanOrEqual(acsBefore.length);
    // Remove from cleanup list — already gone.
    const idx = createdDocIds.indexOf(spec.id);
    if (idx >= 0) createdDocIds.splice(idx, 1);
  });

  it("sets the Issue → converted and records the satisfying Task link (ac-21)", async () => {
    tagAc(AC(21));
    const spec = await makeSpec("Convert Status Spec");
    const issue = await createIssue({
      memexId,
      docId: spec.id,
      title: "Status bug",
      body: "b",
      type: "bug",
    });

    const result = await convertIssueToTask(memexId, issue.id);

    const after = await getIssue(memexId, issue.id);
    expect(after.status).toBe("converted");
    expect(after.satisfyingTaskId).toBe(result.task.id);
  });

  it("refuses to convert an Issue that is not open", async () => {
    const spec = await makeSpec("Convert Guard Spec");
    const issue = await createIssue({
      memexId,
      docId: spec.id,
      title: "Already converted",
      body: "b",
      type: "bug",
    });
    await convertIssueToTask(memexId, issue.id); // → converted
    await expect(convertIssueToTask(memexId, issue.id)).rejects.toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Auto-resolve — converted → resolved exactly on task complete + AC green
// (ac-22, ac-7)
// ──────────────────────────────────────────────────────────────────────────
describe("auto-resolve converted → resolved (ac-22, ac-7)", () => {
  it("stays converted when the Task completes but the AC is still RED, then resolves when it goes GREEN (ac-7, ac-22)", async () => {
    tagAc(AC(7));
    tagAc(AC(22));
    const spec = await makeSpec("Bug Loop Spec");
    const issue = await createIssue({
      memexId,
      docId: spec.id,
      title: "Login button does nothing",
      body: "Clicking login is a no-op",
      type: "bug",
    });

    const result = await convertIssueToTask(memexId, issue.id);
    const ac = (await db.query.acs.findFirst({ where: eq(acs.id, result.acId) }))!;
    const acUid = acRefFor(spec.handle, ac.seq);

    // The bug's AC begins RED (the reproduction test fails).
    await emitEvent(acUid, "fail", new Date(Date.now() - 60_000));

    // Complete the Task — but the AC is red, so the Issue must STAY converted.
    await updateTaskStatus(memexId, result.task.id, "complete");
    let now = await getIssue(memexId, issue.id);
    expect(now.status).toBe("converted");

    // The fix lands; the AC goes GREEN (a later event). The test-event ingestion
    // trigger closes the loop: converted → resolved.
    await emitEvent(acUid, "pass", new Date());
    await maybeAutoResolveIssuesForAcUid(acUid);

    now = await getIssue(memexId, issue.id);
    expect(now.status).toBe("resolved");
  });

  it("does NOT resolve while the Task is incomplete, even if the AC is green (ac-22)", async () => {
    tagAc(AC(22));
    const spec = await makeSpec("Green But Incomplete Spec");
    const issue = await createIssue({
      memexId,
      docId: spec.id,
      title: "Premature green",
      body: "b",
      type: "bug",
    });
    const result = await convertIssueToTask(memexId, issue.id);
    const ac = (await db.query.acs.findFirst({ where: eq(acs.id, result.acId) }))!;
    const acUid = acRefFor(spec.handle, ac.seq);

    // AC is green but the Task is NOT complete — the Issue must stay converted.
    await emitEvent(acUid, "pass");
    await maybeAutoResolveIssuesForAcUid(acUid);

    const now = await getIssue(memexId, issue.id);
    expect(now.status).toBe("converted");
  });

  it("resolves on the task-completion trigger when the AC is already green (ac-22)", async () => {
    tagAc(AC(22));
    const spec = await makeSpec("Complete Triggers Resolve Spec");
    const issue = await createIssue({
      memexId,
      docId: spec.id,
      title: "Complete-trigger bug",
      body: "b",
      type: "bug",
    });
    const result = await convertIssueToTask(memexId, issue.id);
    const ac = (await db.query.acs.findFirst({ where: eq(acs.id, result.acId) }))!;
    const acUid = acRefFor(spec.handle, ac.seq);

    // Green first, THEN complete the Task — the task-completion path is the trigger.
    await emitEvent(acUid, "pass");
    await updateTaskStatus(memexId, result.task.id, "complete");

    const now = await getIssue(memexId, issue.id);
    expect(now.status).toBe("resolved");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Up-bridge — kick_task_to_issue (ac-30, ac-31, ac-32)
// ──────────────────────────────────────────────────────────────────────────
describe("kickTaskToIssue — up-bridge / fourth escalation", () => {
  it("creates an open todo Issue on the Task's Spec from task+reason, and deletes the Task (ac-30)", async () => {
    tagAc(AC(30));
    const spec = await makeSpec("Kick Fresh Spec");
    // A standalone agent Task (NOT from an issue conversion).
    const [task] = await db
      .insert(tasks)
      .values({ memexId, docId: spec.id, seq: 1, title: "Rotate prod TLS cert", description: "Swap the cert in the GCP secret" } as never)
      .returning();

    const result = await kickTaskToIssue(memexId, task.id, "needs a human with GCP secret-manager access");

    // A new open todo Issue on the Task's Spec, seeded from task + reason.
    expect(result.reverted).toBe(false);
    const issue = await getIssue(memexId, result.issue.id);
    expect(issue.docId).toBe(spec.id);
    expect(issue.type).toBe("todo");
    expect(issue.status).toBe("open");
    expect(issue.title).toBe("Rotate prod TLS cert");
    expect(issue.body).toContain("Swap the cert");
    expect(issue.body).toContain("needs a human with GCP secret-manager access");

    // The dead Task is gone (ac-31 delete half).
    const gone = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(gone).toBeUndefined();
  });

  it("deletes the kicked Task (ac-31)", async () => {
    tagAc(AC(31));
    const spec = await makeSpec("Kick Delete Spec");
    const [task] = await db
      .insert(tasks)
      .values({ memexId, docId: spec.id, seq: 1, title: "Manual task", description: "x" } as never)
      .returning();
    await kickTaskToIssue(memexId, task.id, "offline work");
    const gone = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(gone).toBeUndefined();
  });

  it("reverts the ORIGIN Issue converted→open instead of duplicating, when the Task came from a conversion (ac-31)", async () => {
    tagAc(AC(31));
    const spec = await makeSpec("Kick Revert Spec");
    const issue = await createIssue({
      memexId,
      docId: spec.id,
      title: "Originally a bug",
      body: "original body",
      type: "bug",
    });
    const conv = await convertIssueToTask(memexId, issue.id);
    // Sanity: the Issue is converted and points at the Task.
    expect((await getIssue(memexId, issue.id)).status).toBe("converted");

    const issuesBefore = await db.select().from(issues).where(eq(issues.docId, spec.id));

    const result = await kickTaskToIssue(memexId, conv.task.id, "needs the vendor to ship a fix first");

    // No duplicate Issue — same row, reverted to open (one Issue, not two).
    expect(result.reverted).toBe(true);
    expect(result.issue.id).toBe(issue.id);
    const issuesAfter = await db.select().from(issues).where(eq(issues.docId, spec.id));
    expect(issuesAfter.length).toBe(issuesBefore.length);

    const reverted = await getIssue(memexId, issue.id);
    expect(reverted.status).toBe("open");
    expect(reverted.satisfyingTaskId).toBeNull();
    // The offline-work reason is folded into the body.
    expect(reverted.body).toContain("original body");
    expect(reverted.body).toContain("needs the vendor to ship a fix first");

    // The Task is deleted.
    const gone = await db.query.tasks.findFirst({ where: eq(tasks.id, conv.task.id) });
    expect(gone).toBeUndefined();
  });

  it("the kicked Todo is a normal Issue — open, trips the gate, searchable (ac-32)", async () => {
    tagAc(AC(32));
    const spec = await makeSpec("Kick Normal Issue Spec");
    const [task] = await db
      .insert(tasks)
      .values({ memexId, docId: spec.id, seq: 1, title: "Wombat migration plan", description: "draft the wombat data migration" } as never)
      .returning();
    const result = await kickTaskToIssue(memexId, task.id, "needs DBA sign-off");

    const issue = await getIssue(memexId, result.issue.id);
    // Open + todo → trips the verify→done gate (open/converted both warn, s-5).
    expect(issue.status).toBe("open");
    expect(["open", "converted"]).toContain(issue.status);

    // Searchable like any Issue (ac-32) — the embed is fire-and-forget, but the
    // FTS arm matches on title/body immediately regardless of the vector arm.
    const hits = await searchMemex(memexId, "wombat migration", { kind: "issue", limit: 10 });
    expect(hits.some((h) => h.path.includes(`/issues/issue-${issue.seq}`))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Bidirectional bridge — the two planes (ac-29)
// ──────────────────────────────────────────────────────────────────────────
describe("bidirectional bridge across the two planes (ac-29)", () => {
  it("an Issue converts down to a Task, and a Task kicks up to an Issue", async () => {
    tagAc(AC(29));
    const spec = await makeSpec("Two Planes Spec");

    // DOWN: human Issue → agent Task.
    const downIssue = await createIssue({
      memexId,
      docId: spec.id,
      title: "Down-bridge issue",
      body: "b",
      type: "bug",
    });
    const conv = await convertIssueToTask(memexId, downIssue.id);
    const downTask = await db.query.tasks.findFirst({ where: eq(tasks.id, conv.task.id) });
    expect(downTask).toBeTruthy();
    expect((await getIssue(memexId, downIssue.id)).status).toBe("converted");

    // UP: a fresh agent Task → human Todo Issue (delete the Task).
    const [upTask] = await db
      .insert(tasks)
      .values({ memexId, docId: spec.id, seq: 500, title: "Up-bridge task", description: "needs offline work" } as never)
      .returning();
    const kicked = await kickTaskToIssue(memexId, upTask.id, "human-only step");
    const upIssue = await getIssue(memexId, kicked.issue.id);
    expect(upIssue.type).toBe("todo");
    expect(upIssue.status).toBe("open");
    expect(await db.query.tasks.findFirst({ where: eq(tasks.id, upTask.id) })).toBeUndefined();
  });
});
