// spec-151 dec-7 (t-8 / ac-20, ac-21) — the adversarial verifier gates a clause
// test's green/red. An unverified clause test leaves the clause PENDING (ac-20); the
// verifier rejects a wrong-reason test, which then never confirms (ac-21). The LLM
// judge is exercised via its injectable seam (key-free) + a fail-closed unit.

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
  clauseTestVerifications,
} from "../db/schema.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";
import { mintEmissionKey } from "../services/emission-keys.js";
import { listClausesForStandardWithVerification, buildClauseRef } from "./clause-coverage.js";
import {
  verifyClauseTest,
  verifyAndRecord,
  type AnthropicLike,
} from "./clause-test-verifier.js";

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

const refFor = (seq: number): string =>
  buildClauseRef({ namespace: ns, memex: memexSlug, standardHandle: "std-1" }, seq);

async function stateOf(seq: number): Promise<string> {
  const cov = await listClausesForStandardWithVerification(memexId, docId);
  return cov.clauses.find((c) => c.clause.seq === seq)!.state;
}

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

async function emit(seq: number): Promise<void> {
  const res = await app.request("/api/test-events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "memex.ai", Authorization: `Bearer ${ciKey}` },
    body: JSON.stringify({
      subject_ref: refFor(seq),
      status: "pass",
      test_identifier: `verifier::cl-${seq}`,
      duration_ms: 1,
      run_id: "ci-run-verifier",
      metadata: { clause_surface: "whole-surface", clause_kind: "grep-denylist" },
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
    .values({ email: `verifier-${crypto.randomUUID()}@example.com`, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  ownerUserId = u.id;
  createdUserIds.push(u.id);
  const seeded = await createOrgWithMemexAndOwner({ slug: `verifier-${crypto.randomUUID().slice(0, 8)}`, ownerUserId });
  ns = seeded.namespace.slug;
  memexSlug = seeded.memex.slug;
  memexId = seeded.memex.id;
  createdMemexIds.push(memexId);
  createdOrgIds.push(seeded.org.id);
  createdNamespaceIds.push(seeded.namespace.id);
  ciKey = (await mintEmissionKey(memexId, "ci", ownerUserId)).raw;

  const [std] = await db
    .insert(documents)
    .values({ memexId, handle: "std-1", title: "Verifier standard", docType: "standard", status: "approved" })
    .returning();
  docId = std.id;
  const [sec] = await db.insert(docSections).values({ docId, sectionType: "rule", content: "x", seq: 1, position: 1 }).returning();
  for (const seq of [1, 2]) {
    await db.insert(standardClauses).values({
      memexId, docId, sectionId: sec.id, seq, position: seq, body: `Every mutation must emit on the bus (clause ${seq}).`,
      isObligation: true, testable: true, archetype: "grep-denylist",
    });
    allRefs.push(refFor(seq));
  }
  // Both clauses get a CI-backed whole-surface PASS — but no verification yet.
  await emit(1);
  await emit(2);
});

describe("spec-151 dec-7 — adversarial verifier gates clause green/red", () => {
  it("an unverified clause test leaves the clause PENDING; confirming it resolves the state [ac-20]", async () => {
    tagAc(AC(20));
    // cl-1 has a CI-backed whole-surface PASS but no verifier confirmation yet → its
    // green does NOT count: the clause is pending, neither green nor red.
    expect(await stateOf(1)).toBe("pending");

    // An independent verifier confirms the test genuinely + universally asserts the clause.
    const verdict = await verifyAndRecord(
      {
        memexId,
        subjectRef: refFor(1),
        testIdentifier: "verifier::cl-1",
        clauseBody: "Every mutation must emit on the bus.",
        testSource: "AST scan asserting every db.insert/update/delete is inside a mutate() callback across the whole source tree",
      },
      { judge: () => ({ confirmed: true, reason: "genuinely + universally asserts the clause" }) },
    );
    expect(verdict.confirmed).toBe(true);
    // Now the green counts.
    expect(await stateOf(1)).toBe("verified");
  });

  it("the verifier REJECTS a wrong-reason test; a rejected test never confirms (clause stays pending) [ac-21]", async () => {
    tagAc(AC(21));
    // cl-2 also has a passing CI-backed emission. But the test is tautological — it
    // passes without genuinely asserting the clause. The verifier refuses it.
    const verdict = await verifyAndRecord(
      {
        memexId,
        subjectRef: refFor(2),
        testIdentifier: "verifier::cl-2",
        clauseBody: "Every mutation must emit on the bus.",
        testSource: "expect(true).toBe(true)",
      },
      {
        // A judge that refuses a tautological test (stands in for the LLM, key-free).
        judge: ({ testSource }) =>
          /expect\(true\)|toBe\(true\)|^\s*$/.test(testSource)
            ? { confirmed: false, reason: "tautological — cannot fail when the clause is violated" }
            : { confirmed: true, reason: "ok" },
      },
    );
    expect(verdict.confirmed).toBe(false);
    // A rejected verdict is not a confirmation → the clause's passing green still does
    // NOT count: it stays pending despite the green emission.
    expect(await stateOf(2)).toBe("pending");
  });

  it("the verifier FAILS CLOSED — no structured output never silently confirms [ac-21]", async () => {
    tagAc(AC(21));
    const nullClient: AnthropicLike = {
      messages: { parse: async () => ({ parsed_output: null }) },
    };
    const verdict = await verifyClauseTest(
      { clauseBody: "Every mutation must emit on the bus.", testSource: "anything" },
      { client: nullClient },
    );
    expect(verdict.confirmed).toBe(false);
  });
});
