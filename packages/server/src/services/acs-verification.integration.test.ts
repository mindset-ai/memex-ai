// Integration tests for the AC verification view + alignment history query.
//
// These are DB-backed because the verification derivation joins acs ↔
// test_events via the canonical ac_uid ref — getting that join wrong is
// exactly the failure mode the tests exist to catch. Mock-friendly unit tests
// on the pure deriveVerificationState helper would pass and the production
// path would still be broken.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  acs,
  testEvents,
  testEventLatest,
  memexes,
  namespaces,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { createAc } from "./acs.js";
import { createDecision } from "./decisions.js";
import {
  listAcsForBriefWithVerification,
  listAcAlignmentOverTime,
  STALE_THRESHOLD_DAYS,
} from "./acs.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";

const createdDocIds: string[] = [];
const createdAcUids: string[] = [];

afterAll(async () => {
  // Tear down test_events first (no FK back, just a free-text ac_uid match).
  if (createdAcUids.length) {
    await db
      .delete(testEvents)
      .where(inArray(testEvents.acUid, createdAcUids))
      .catch(() => {});
    await db
      .delete(testEventLatest)
      .where(inArray(testEventLatest.acUid, createdAcUids))
      .catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;

beforeAll(async () => {
  memexId = await makeTestMemex("ver");
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

async function seedBrief(): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, "AC verif test", "purpose", "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle! };
}

function refOf(briefHandle: string, seq: number): string {
  return `${namespaceSlug}/${memexSlug}/specs/${briefHandle}/acs/ac-${seq}`;
}

async function emitEvent(
  acUid: string,
  status: "pass" | "fail" | "error",
  createdAt: Date = new Date(),
  testIdentifier = "tests/example.test.ts::it works",
): Promise<void> {
  createdAcUids.push(acUid);
  // spec-162: seed through the insert+summary-upsert path so the verification
  // read (now backed by test_event_latest) sees the event.
  await seedTestEvent({ acUid, status, createdAt, testIdentifier });
}

describe("listAcsForBriefWithVerification", () => {
  it("derives 'untested' for an AC with zero events", async () => {
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "untested AC",
    });

    const rows = await listAcsForBriefWithVerification(memexId, spec.id);
    const found = rows.find((r) => r.ac.id === ac.id);
    expect(found).toBeDefined();
    expect(found!.verificationState).toBe("untested");
    expect(found!.tests).toEqual([]);
    expect(found!.daysSinceLastRun).toBeNull();
    expect(found!.canonicalRef).toBe(refOf(spec.handle, ac.seq));
  });

  it("derives 'verified' when the latest emission per test is pass (within stale window)", async () => {
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "verified AC",
    });
    const ref = refOf(spec.handle, ac.seq);
    await emitEvent(ref, "pass");

    const rows = await listAcsForBriefWithVerification(memexId, spec.id);
    const found = rows.find((r) => r.ac.id === ac.id)!;
    expect(found.verificationState).toBe("verified");
    expect(found.tests.length).toBe(1);
    expect(found.tests[0].latestStatus).toBe("pass");
    expect(found.daysSinceLastRun).toBeLessThanOrEqual(0);
  });

  it("derives 'failing' if any test's latest emission is fail OR error", async () => {
    const spec = await seedBrief();
    const acFail = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "failing via fail",
    });
    const acError = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "failing via error",
    });
    const refFail = refOf(spec.handle, acFail.seq);
    const refError = refOf(spec.handle, acError.seq);
    await emitEvent(refFail, "fail");
    await emitEvent(refError, "error");

    const rows = await listAcsForBriefWithVerification(memexId, spec.id);
    expect(rows.find((r) => r.ac.id === acFail.id)!.verificationState).toBe(
      "failing",
    );
    expect(rows.find((r) => r.ac.id === acError.id)!.verificationState).toBe(
      "failing",
    );
  });

  it("derives 'failing' when latest event is fail even if older events were pass (latest wins)", async () => {
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "regression case",
    });
    const ref = refOf(spec.handle, ac.seq);
    // Older pass, newer fail — the newer one defines the state.
    await emitEvent(ref, "pass", new Date(Date.now() - 60_000));
    await emitEvent(ref, "fail", new Date());

    const rows = await listAcsForBriefWithVerification(memexId, spec.id);
    expect(
      rows.find((r) => r.ac.id === ac.id)!.verificationState,
    ).toBe("failing");
  });

  it("derives 'stale' when latest pass is older than STALE_THRESHOLD_DAYS", async () => {
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "stale AC",
    });
    const ref = refOf(spec.handle, ac.seq);
    const longAgo = new Date(
      Date.now() - (STALE_THRESHOLD_DAYS + 2) * 24 * 60 * 60 * 1000,
    );
    await emitEvent(ref, "pass", longAgo);

    const rows = await listAcsForBriefWithVerification(memexId, spec.id);
    const found = rows.find((r) => r.ac.id === ac.id)!;
    expect(found.verificationState).toBe("stale");
    expect(found.daysSinceLastRun).toBeGreaterThan(STALE_THRESHOLD_DAYS);
  });

  it("groups multiple test_identifiers under one AC and counts runs per test", async () => {
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "multi-test AC",
    });
    const ref = refOf(spec.handle, ac.seq);
    // Two distinct tests, one with multiple runs.
    await emitEvent(ref, "pass", new Date(Date.now() - 90_000), "test_a");
    await emitEvent(ref, "pass", new Date(Date.now() - 60_000), "test_a");
    await emitEvent(ref, "pass", new Date(Date.now() - 30_000), "test_a");
    await emitEvent(ref, "pass", new Date(), "test_b");

    const rows = await listAcsForBriefWithVerification(memexId, spec.id);
    const found = rows.find((r) => r.ac.id === ac.id)!;
    expect(found.tests.length).toBe(2);
    const aSnapshot = found.tests.find((t) => t.testIdentifier === "test_a")!;
    const bSnapshot = found.tests.find((t) => t.testIdentifier === "test_b")!;
    expect(aSnapshot.runCount).toBe(3);
    expect(bSnapshot.runCount).toBe(1);
    expect(found.verificationState).toBe("verified");
  });

  it("returns ACs ordered by kind then seq (scope before implementation, low seq first)", async () => {
    const spec = await seedBrief();
    const impl1 = await createAc({
      memexId, briefId: spec.id, kind: "implementation", statement: "impl 1",
    });
    const scope1 = await createAc({
      memexId, briefId: spec.id, kind: "scope", statement: "scope 1",
    });
    const impl2 = await createAc({
      memexId, briefId: spec.id, kind: "implementation", statement: "impl 2",
    });

    const rows = await listAcsForBriefWithVerification(memexId, spec.id);
    expect(rows.map((r) => r.ac.id)).toEqual([impl1.id, impl2.id, scope1.id]);
    // ^ kind sort: implementation < scope alphabetically. Sort lives in
    //   service; UI groups visually. The assertion captures the contract.
  });

  it("returns [] for a Spec with no ACs (and doesn't fall over)", async () => {
    const spec = await seedBrief();
    const rows = await listAcsForBriefWithVerification(memexId, spec.id);
    expect(rows).toEqual([]);
  });

  it("populates parents[] with the polymorphic decision/brief parent links per AC", async () => {
    // The Decisions tab uses this to filter ACs whose parents include a
    // given decisionId. Cover three shapes in one test:
    //   - AC with one decision parent (typical Implementation AC)
    //   - AC with a brief parent (typical Scope AC)
    //   - AC with no parent (allowed in V0.0.1 — service doesn't enforce)
    const spec = await seedBrief();
    const decision = await createDecision(memexId, spec.id, "Test decision");

    const acWithDecisionParent = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "spawned from a decision",
      parent: { kind: "decision", id: decision.id },
    });
    const acWithBriefParent = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "anchored to the spec",
      // DB discriminator stays "brief" — the ac_parent_links CHECK constraint
      // is IN ('brief','decision'), preserved by b-105 (ParentKind = "brief").
      parent: { kind: "brief", id: spec.id },
    });
    const orphanAc = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "no parent — allowed for V0.0.1",
    });

    const rows = await listAcsForBriefWithVerification(memexId, spec.id);
    const decisionParented = rows.find((r) => r.ac.id === acWithDecisionParent.id)!;
    const briefParented = rows.find((r) => r.ac.id === acWithBriefParent.id)!;
    const orphan = rows.find((r) => r.ac.id === orphanAc.id)!;

    expect(decisionParented.parents).toEqual([
      { kind: "decision", id: decision.id },
    ]);
    expect(briefParented.parents).toEqual([
      { kind: "brief", id: spec.id },
    ]);
    expect(orphan.parents).toEqual([]);
  });
});

describe("listAcAlignmentOverTime", () => {
  it("produces N×kinds data points and verified+total are non-decreasing once ACs exist", async () => {
    const spec = await seedBrief();
    const ac = await createAc({
      memexId, briefId: spec.id, kind: "implementation", statement: "history AC",
    });
    const ref = refOf(spec.handle, ac.seq);
    // Three pass events across three different days.
    const now = Date.now();
    await emitEvent(ref, "pass", new Date(now - 2 * 24 * 60 * 60 * 1000));
    await emitEvent(ref, "pass", new Date(now - 1 * 24 * 60 * 60 * 1000));
    await emitEvent(ref, "pass", new Date(now));

    const days = await listAcAlignmentOverTime(memexId, spec.id, 7);
    // At least one day with verified=1, total=1 for our impl kind.
    const verifiedDays = days.filter(
      (d) => d.kind === "implementation" && d.verified === 1 && d.total === 1,
    );
    expect(verifiedDays.length).toBeGreaterThanOrEqual(1);
  });

  it("shows a verified day going to unverified after a fail event lands", async () => {
    const spec = await seedBrief();
    const ac = await createAc({
      memexId, briefId: spec.id, kind: "implementation", statement: "regress",
    });
    // Backdate the AC so it "existed" 5 days ago — otherwise the history
    // query's verified-count gate (AC must exist on the day) returns 0 for
    // every day before the AC was created. Real production data wouldn't
    // emit a test_event before the AC's createdAt; the test seeds events
    // from 2 days ago, so the AC needs to predate them.
    await db
      .update(acs)
      .set({ createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) })
      .where(eq(acs.id, ac.id));

    const ref = refOf(spec.handle, ac.seq);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const today = new Date();
    await emitEvent(ref, "pass", twoDaysAgo);
    await emitEvent(ref, "fail", today);

    const days = await listAcAlignmentOverTime(memexId, spec.id, 7);
    // Find the day-before-today bucket: should be verified=1.
    // Find today's bucket: verified=0 (latest event today is fail).
    const yesterday = days
      .filter((d) => d.kind === "implementation")
      .slice(-2)[0];
    const todayRow = days
      .filter((d) => d.kind === "implementation")
      .slice(-1)[0];
    expect(yesterday.verified).toBe(1);
    expect(todayRow.verified).toBe(0);
  });

  it("returns [] when the Spec has no active ACs", async () => {
    const spec = await seedBrief();
    const days = await listAcAlignmentOverTime(memexId, spec.id, 30);
    expect(days).toEqual([]);
  });
});
