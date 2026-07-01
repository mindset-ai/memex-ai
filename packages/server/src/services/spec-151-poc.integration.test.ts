// spec-151 (t-9 / ac-4) — the PoC thread end to end: a universal test (std-8's
// mutate() coverage scanner attests cl-69) emits a clause attestation, and the clause
// appears GREEN ("passing") in the standard's clause-coverage view. The real wiring
// lives in __regression__/mutate-coverage.static-scan.regression.test.ts (tagClause
// cl-69); this test drives the same thread against a seeded std-8 and asserts the view
// goes green. A green means exactly "a tagged test reported pass" — no CI-provenance or
// verifier gate (the dec-2/dec-4/dec-7 reversal).

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

const AC_4 = "mindset-prod/memex-building-itself/specs/spec-151/acs/ac-4";

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdOrgIds: string[] = [];
const createdNamespaceIds: string[] = [];
let cl69Ref = "";

let ns: string;
let memexSlug: string;
let memexId: string;
let ownerUserId: string;
let docId: string;
let ciKey: string;

afterAll(async () => {
  if (cl69Ref) {
    await db.delete(testEvents).where(eq(testEvents.subjectRef, cl69Ref)).catch(() => {});
    await db.delete(testEventLatest).where(eq(testEventLatest.subjectRef, cl69Ref)).catch(() => {});
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

beforeEach(() => {
  if (!process.env.GOOGLE_CLIENT_ID) process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
});

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ email: `poc-${crypto.randomUUID()}@example.com`, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  ownerUserId = u.id;
  createdUserIds.push(u.id);
  const seeded = await createOrgWithMemexAndOwner({ slug: `poc-${crypto.randomUUID().slice(0, 8)}`, ownerUserId });
  ns = seeded.namespace.slug;
  memexSlug = seeded.memex.slug;
  memexId = seeded.memex.id;
  createdMemexIds.push(memexId);
  createdOrgIds.push(seeded.org.id);
  createdNamespaceIds.push(seeded.namespace.id);
  ciKey = (await mintEmissionKey(memexId, "ci", ownerUserId)).raw;

  // Seed std-8 with cl-69 — the very clause the mutate() coverage scanner attests.
  const [std] = await db
    .insert(documents)
    .values({ memexId, handle: "std-8", title: "Every mutation goes through mutate()", docType: "standard", status: "approved" })
    .returning();
  docId = std.id;
  const [sec] = await db.insert(docSections).values({ docId, sectionType: "rule", content: "x", seq: 1, position: 1 }).returning();
  await db.insert(standardClauses).values({
    memexId, docId, sectionId: sec.id, seq: 69, position: 1,
    body: "Every mutation of a tenancy-scoped resource MUST go through mutate(ctx, key, fn).",
    isObligation: true, testable: true, archetype: "static-scan",
  });
  cl69Ref = buildClauseRef({ namespace: ns, memex: memexSlug, standardHandle: "std-8" }, 69);
});

describe("spec-151 PoC — a wired universal test turns a clause green in the view (ac-4)", () => {
  it("std-8 cl-69 appears green (passing) once the universal scanner attests it [ac-4]", async () => {
    tagAc(AC_4);
    const testIdentifier = "src/__regression__/mutate-coverage.static-scan.regression.test.ts::std-8 cl-69";

    // The universal scanner emits a clause attestation for cl-69. Memex records the
    // claim; no CI-provenance or verifier gate stands between the pass and the green.
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "memex.ai", Authorization: `Bearer ${ciKey}` },
      body: JSON.stringify({
        subject_ref: cl69Ref,
        status: "pass",
        test_identifier: testIdentifier,
        duration_ms: 7,
      }),
    });
    expect(res.status).toBe(201);

    // The clause appears GREEN in the standard's clause-coverage view and counts toward
    // the standard's passing tally.
    const coverage = await listClausesForStandardWithVerification(memexId, docId);
    const cl69 = coverage.clauses.find((c) => c.clause.seq === 69)!;
    expect(cl69.state).toBe("passing");
    expect(coverage.passingCount).toBe(1);
    expect(coverage.countableTotal).toBe(1);
  });
});
