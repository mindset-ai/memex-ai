// spec-151 dec-4 (t-7 / ac-2, ac-12, ac-13, ac-16) — a standard's clause-coverage
// view: which clauses are covered + latest green (ac-2), CI-backed green only with
// local-only surfaced distinctly (ac-12/ac-13), and a denominator of testable
// obligations only (ac-16). Exercises the full pipeline: seed clauses, emit through
// POST /api/test-events, then read listClausesForStandardWithVerification.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import {
  users,
  memexEmissionKeys,
  testEvents,
  testEventLatest,
  memexes,
  orgs,
  orgMemberships,
  namespaces,
  documents,
  docSections,
  standardClauses,
} from "../db/schema.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";
import { mintEmissionKey } from "../services/emission-keys.js";
import {
  listClausesForStandardWithVerification,
  buildClauseRef,
} from "./clause-coverage.js";

const M = "mindset-prod/memex-building-itself/specs/spec-151/acs";
const AC = (n: number) => `${M}/ac-${n}`;

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdOrgIds: string[] = [];
const createdNamespaceIds: string[] = [];
let allRefs: string[] = [];

let ns: string;
let memexSlug: string;
let memexId: string;
let ownerUserId: string;
let docId: string;
let ciKey: string;

afterAll(async () => {
  if (allRefs.length) {
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, allRefs)).catch(() => {});
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, allRefs)).catch(() => {});
  }
  if (createdMemexIds.length) {
    await db.delete(memexEmissionKeys).where(inArray(memexEmissionKeys.memexId, createdMemexIds)).catch(() => {});
    await db.delete(documents).where(inArray(documents.memexId, createdMemexIds)).catch(() => {});
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  }
  if (createdOrgIds.length) {
    await db.delete(orgMemberships).where(inArray(orgMemberships.orgId, createdOrgIds)).catch(() => {});
    await db.delete(orgs).where(inArray(orgs.id, createdOrgIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
  for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id)).catch(() => {});
});

interface ClauseSeed {
  seq: number;
  isObligation: boolean | null;
  testable: boolean | null;
  archetype: string | null;
}

async function emit(seq: number, status: string, opts: { runId?: string } = {}): Promise<void> {
  const ref = buildClauseRef({ namespace: ns, memex: memexSlug, standardHandle: "std-1" }, seq);
  const res = await app.request("/api/test-events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "memex.ai", Authorization: `Bearer ${ciKey}` },
    body: JSON.stringify({
      subject_ref: ref,
      status,
      test_identifier: `clause-cov::cl-${seq}`,
      duration_ms: 1,
      ...(opts.runId ? { run_id: opts.runId } : {}),
    }),
  });
  if (res.status !== 201) throw new Error(`emit cl-${seq} failed: ${res.status}`);
}

beforeEach(() => {
  if (!process.env.GOOGLE_CLIENT_ID) process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
});

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ email: `cov-${crypto.randomUUID()}@example.com`, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  ownerUserId = u.id;
  createdUserIds.push(u.id);
  const seeded = await createOrgWithMemexAndOwner({ slug: `clause-cov-${crypto.randomUUID().slice(0, 8)}`, ownerUserId });
  ns = seeded.namespace.slug;
  memexSlug = seeded.memex.slug;
  memexId = seeded.memex.id;
  createdMemexIds.push(memexId);
  createdOrgIds.push(seeded.org.id);
  createdNamespaceIds.push(seeded.namespace.id);
  ciKey = (await mintEmissionKey(memexId, "ci", ownerUserId)).raw;

  const [std] = await db
    .insert(documents)
    .values({ memexId, handle: "std-1", title: "A standard", docType: "standard", status: "approved" })
    .returning();
  docId = std.id;
  const [sec] = await db.insert(docSections).values({ docId, sectionType: "rule", content: "x", seq: 1, position: 1 }).returning();

  // Six clauses spanning the matrix of (obligation, testable) + verification states.
  const seeds: ClauseSeed[] = [
    { seq: 1, isObligation: true, testable: true, archetype: "static-scan" }, // → CI green → verified
    { seq: 2, isObligation: true, testable: true, archetype: "grep-denylist" }, // → local pass → local
    { seq: 3, isObligation: true, testable: true, archetype: "runtime-property" }, // → fail → failing
    { seq: 4, isObligation: true, testable: true, archetype: "static-scan" }, // → no test → untested
    { seq: 5, isObligation: false, testable: false, archetype: null }, // non-obligation → not countable
    { seq: 6, isObligation: true, testable: false, archetype: null }, // untestable obligation → not countable
  ];
  for (const s of seeds) {
    await db.insert(standardClauses).values({
      memexId, docId, sectionId: sec.id, seq: s.seq, position: s.seq, body: `clause ${s.seq}`,
      isObligation: s.isObligation, testable: s.testable, archetype: s.archetype,
    });
    allRefs.push(buildClauseRef({ namespace: ns, memex: memexSlug, standardHandle: "std-1" }, s.seq));
  }

  // Emit: cl-1 CI-backed pass, cl-2 local-only pass, cl-3 fail. cl-4/5/6 untested.
  await emit(1, "pass", { runId: "ci-run-42" });
  await emit(2, "pass"); // no run_id → local-only
  await emit(3, "fail", { runId: "ci-run-43" });
});

describe("spec-151 dec-4 — standard clause-coverage view", () => {
  it("shows per-clause coverage + latest-green state, mirroring the AC matrix [ac-2]", async () => {
    tagAc(AC(2));
    const cov = await listClausesForStandardWithVerification(memexId, docId);
    const bySeq = new Map(cov.clauses.map((c) => [c.clause.seq, c]));
    expect(bySeq.get(1)!.tests.length).toBeGreaterThanOrEqual(1); // covered
    expect(bySeq.get(3)!.state).toBe("failing");
    expect(bySeq.get(4)!.state).toBe("untested");
    expect(bySeq.get(4)!.tests).toHaveLength(0);
  });

  it("counts a clause verified-green ONLY when its latest emission is CI-backed [ac-12]", async () => {
    tagAc(AC(12));
    const cov = await listClausesForStandardWithVerification(memexId, docId);
    const bySeq = new Map(cov.clauses.map((c) => [c.clause.seq, c]));
    // cl-1 passed WITH a run_id → verified + ciBacked.
    expect(bySeq.get(1)!.state).toBe("verified");
    expect(bySeq.get(1)!.ciBacked).toBe(true);
    // cl-2 passed WITHOUT CI provenance → must NOT read verified.
    expect(bySeq.get(2)!.state).not.toBe("verified");
    expect(bySeq.get(2)!.ciBacked).toBe(false);
  });

  it("surfaces CI-backed green distinctly from local-only passing [ac-13]", async () => {
    tagAc(AC(13));
    const cov = await listClausesForStandardWithVerification(memexId, docId);
    const bySeq = new Map(cov.clauses.map((c) => [c.clause.seq, c]));
    expect(bySeq.get(1)!.state).toBe("verified"); // enforced at merge
    expect(bySeq.get(2)!.state).toBe("local"); // ran on a laptop
  });

  it("counts only testable obligations in the coverage denominator [ac-16]", async () => {
    tagAc(AC(16));
    const cov = await listClausesForStandardWithVerification(memexId, docId);
    // cl-1..4 are testable obligations (countable); cl-5 (non-obligation) and cl-6
    // (untestable) are excluded.
    expect(cov.countableTotal).toBe(4);
    const bySeq = new Map(cov.clauses.map((c) => [c.clause.seq, c]));
    expect(bySeq.get(5)!.countable).toBe(false);
    expect(bySeq.get(6)!.countable).toBe(false);
    // covered = countable with ≥1 test (cl-1,2,3); verified = CI-backed green (cl-1).
    expect(cov.coveredCount).toBe(3);
    expect(cov.verifiedCount).toBe(1);
  });
});
