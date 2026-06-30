// spec-151 dec-1 (ac-1, ac-6) — a standard CLAUSE ref is a first-class
// verifiable subject on the SAME emission pipeline as an AC. The route resolves
// the memex by namespace+slug and stores the ref verbatim; it does NOT validate
// the ref against the `acs` table, so a clause-ref subject lands a test_events
// row with no parallel pipeline. Mirrors the spec-234 emission harness (seed a
// throwaway org/memex/user, post events through the real app).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import {
  users,
  memexEmissionKeys,
  testEvents,
  memexes,
  orgs,
  orgMemberships,
  namespaces,
} from "../db/schema.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";
import {
  mintEmissionKey,
  mintEphemeralEmissionKey,
} from "../services/emission-keys.js";

const M = "mindset-prod/memex-building-itself/specs/spec-151/acs";
const AC_1 = `${M}/ac-1`; // same mechanism as AC tagging, no parallel pipeline
const AC_6 = `${M}/ac-6`; // route accepts non-AC subjects, no acs-table rejection

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdOrgIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdSubjectRefs: string[] = [];

afterAll(async () => {
  // Full ordered teardown — leave zero rows in the shared per-worker DB (std-37).
  if (createdSubjectRefs.length) {
    await db
      .delete(testEvents)
      .where(inArray(testEvents.subjectRef, createdSubjectRefs))
      .catch(() => {});
  }
  if (createdMemexIds.length) {
    await db
      .delete(memexEmissionKeys)
      .where(inArray(memexEmissionKeys.memexId, createdMemexIds))
      .catch(() => {});
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  }
  if (createdOrgIds.length) {
    await db.delete(orgMemberships).where(inArray(orgMemberships.orgId, createdOrgIds)).catch(() => {});
    await db.delete(orgs).where(inArray(orgs.id, createdOrgIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `clause-emit-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(u.id);
  return u.id;
}

let ns: string;
let memexSlug: string;
let memexId: string;
let ownerUserId: string;
let clauseRef: string;
let otherClauseRef: string;

async function postSubject(subjectRef: string, bearer: string): Promise<Response> {
  return app.request("/api/test-events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "memex.ai",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      ac_uid: subjectRef,
      status: "pass",
      test_identifier: "tests/clause.test.ts::clause holds everywhere",
      duration_ms: 3,
    }),
  });
}

describe("spec-151 — a standard clause is a first-class emission subject (dec-1)", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  beforeAll(async () => {
    ownerUserId = await seedUser();
    // std-37: worker-and-call-unique slug, not a bare Date.now().
    const seeded = await createOrgWithMemexAndOwner({
      slug: `clause-emit-${crypto.randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    ns = seeded.namespace.slug;
    memexSlug = seeded.memex.slug;
    memexId = seeded.memex.id;
    createdMemexIds.push(memexId);
    createdOrgIds.push(seeded.org.id);
    createdNamespaceIds.push(seeded.namespace.id);
    clauseRef = `${ns}/${memexSlug}/standards/std-1/clauses/cl-1`;
    otherClauseRef = `${ns}/${memexSlug}/standards/std-2/clauses/cl-3`;
    createdSubjectRefs.push(clauseRef, otherClauseRef);
  });

  it("a memex-wide CI key lands a test_events row for a clause-ref subject, with no acs-table lookup [ac-6]", async () => {
    tagAc(AC_6);
    const ci = await mintEmissionKey(memexId, "ci", ownerUserId);
    const res = await postSubject(clauseRef, ci.raw);
    expect(res.status).toBe(201);
    // The row landed keyed on the clause ref — there is NO `acs` row for this
    // ref, so a 201 + a stored row proves the route never validated against the
    // acs table (ac-6).
    const rows = await db
      .select()
      .from(testEvents)
      .where(eq(testEvents.subjectRef, clauseRef));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.status).toBe("pass");
  });

  it("a clause attestation uses the SAME pipeline as an AC — one route, one test_events log, no parallel store [ac-1]", async () => {
    tagAc(AC_1);
    const ci = await mintEmissionKey(memexId, "ci", ownerUserId);
    // An AC ref (for a non-existent spec) and a clause ref both land in the one
    // test_events log via the one route — the ref's grammar carries the subject
    // type; there is no AC-vs-clause branch and no second table.
    const acRef = `${ns}/${memexSlug}/specs/spec-9/acs/ac-1`;
    createdSubjectRefs.push(acRef);
    expect((await postSubject(acRef, ci.raw)).status).toBe(201);
    expect((await postSubject(otherClauseRef, ci.raw)).status).toBe(201);
    const both = await db
      .select()
      .from(testEvents)
      .where(inArray(testEvents.subjectRef, [acRef, otherClauseRef]));
    const refs = new Set(both.map((r) => r.subjectRef));
    expect(refs.has(acRef)).toBe(true);
    expect(refs.has(otherClauseRef)).toBe(true);
  });

  it("a spec-scoped (agent) key cannot emit for a clause subject — a clause is not a Spec (safe default)", async () => {
    const scoped = await mintEphemeralEmissionKey(memexId, "spec-1", ownerUserId);
    // specHandleFromAcUid returns "" for a `/standards/…/clauses/…` ref, so a
    // scoped key matches nothing and is rejected — the documented safe default.
    const res = await postSubject(clauseRef, scoped.raw);
    expect(res.status).toBe(401);
  });
});
