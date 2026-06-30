// spec-151 dec-2 (t-4 / ac-3, ac-7, ac-8) — a clause attestation records the swept
// surface + check-kind, and a SPOT attestation never reads as universal coverage even
// when CI-backed (a green must not silently overstate). Exercises the emit pipeline +
// the clause-coverage read.

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
import { listClausesForStandardWithVerification, buildClauseRef } from "./clause-coverage.js";
import { recordClauseTestVerification } from "./clause-verification.js";
import { clauseTestVerifications } from "../db/schema.js";

const M = "mindset-prod/memex-building-itself/specs/spec-151/acs";
const AC = (n: number) => `${M}/ac-${n}`;

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdOrgIds: string[] = [];
const createdNamespaceIds: string[] = [];
const allRefs: string[] = [];

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
    await db.delete(clauseTestVerifications).where(inArray(clauseTestVerifications.subjectRef, allRefs)).catch(() => {});
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

async function emit(seq: number, metadata: Record<string, string>): Promise<void> {
  const ref = buildClauseRef({ namespace: ns, memex: memexSlug, standardHandle: "std-1" }, seq);
  const res = await app.request("/api/test-events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "memex.ai", Authorization: `Bearer ${ciKey}` },
    body: JSON.stringify({
      subject_ref: ref,
      status: "pass",
      test_identifier: `surface::cl-${seq}`,
      duration_ms: 1,
      run_id: "ci-run-surface", // CI-backed in all cases — the surface is the variable under test
      metadata,
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
    .values({ email: `surface-${crypto.randomUUID()}@example.com`, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  ownerUserId = u.id;
  createdUserIds.push(u.id);
  const seeded = await createOrgWithMemexAndOwner({ slug: `surface-${crypto.randomUUID().slice(0, 8)}`, ownerUserId });
  ns = seeded.namespace.slug;
  memexSlug = seeded.memex.slug;
  memexId = seeded.memex.id;
  createdMemexIds.push(memexId);
  createdOrgIds.push(seeded.org.id);
  createdNamespaceIds.push(seeded.namespace.id);
  ciKey = (await mintEmissionKey(memexId, "ci", ownerUserId)).raw;

  const [std] = await db
    .insert(documents)
    .values({ memexId, handle: "std-1", title: "Surface standard", docType: "standard", status: "approved" })
    .returning();
  docId = std.id;
  const [sec] = await db.insert(docSections).values({ docId, sectionType: "rule", content: "x", seq: 1, position: 1 }).returning();
  for (const seq of [1, 2]) {
    await db.insert(standardClauses).values({
      memexId, docId, sectionId: sec.id, seq, position: seq, body: `clause ${seq}`,
      isObligation: true, testable: true, archetype: "grep-denylist",
    });
    allRefs.push(buildClauseRef({ namespace: ns, memex: memexSlug, standardHandle: "std-1" }, seq));
  }

  // cl-1: a CI-backed WHOLE-SURFACE sweep. cl-2: a CI-backed SPOT check.
  await emit(1, { clause_surface: "whole-surface", clause_kind: "grep-denylist" });
  await emit(2, { clause_surface: "spot", clause_kind: "grep-denylist" });
  // dec-7: confirm both so their state resolves past "pending" (the verifier gate is
  // orthogonal to the surface dimension under test here).
  for (const seq of [1, 2]) {
    await recordClauseTestVerification({
      memexId,
      subjectRef: buildClauseRef({ namespace: ns, memex: memexSlug, standardHandle: "std-1" }, seq),
      testIdentifier: `surface::cl-${seq}`,
      verdict: "confirmed",
      verifier: "test",
    });
  }
});

describe("spec-151 dec-2 — swept surface + check-kind on a clause attestation", () => {
  it("persists the swept surface and check-kind alongside the pass/fail event [ac-7]", async () => {
    tagAc(AC(7));
    const cov = await listClausesForStandardWithVerification(memexId, docId);
    const cl1 = cov.clauses.find((c) => c.clause.seq === 1)!;
    expect(cl1.sweptSurface).toBe("whole-surface");
    expect(cl1.checkKind).toBe("grep-denylist");
  });

  it("a spot-only attestation never displays as universal coverage, even CI-backed [ac-8]", async () => {
    tagAc(AC(8));
    const cov = await listClausesForStandardWithVerification(memexId, docId);
    const cl2 = cov.clauses.find((c) => c.clause.seq === 2)!;
    expect(cl2.ciBacked).toBe(true); // it IS CI-backed…
    expect(cl2.sweptSurface).toBe("spot");
    expect(cl2.state).toBe("spot"); // …yet must NOT read as the universal "verified"
    expect(cl2.state).not.toBe("verified");
    // It is not counted toward the CI-verified (universal) tally.
    expect(cov.verifiedCount).toBe(1); // only cl-1 (whole-surface)
  });

  it("whole-surface and spot attestations are distinguishable [ac-3]", async () => {
    tagAc(AC(3));
    const cov = await listClausesForStandardWithVerification(memexId, docId);
    const cl1 = cov.clauses.find((c) => c.clause.seq === 1)!;
    const cl2 = cov.clauses.find((c) => c.clause.seq === 2)!;
    expect(cl1.wholeSurface).toBe(true);
    expect(cl2.wholeSurface).toBe(false);
    expect(cl1.state).not.toBe(cl2.state); // verified vs spot — never silently equal
  });
});
