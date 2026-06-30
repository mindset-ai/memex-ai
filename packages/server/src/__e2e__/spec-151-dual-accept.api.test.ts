// spec-151 dec-3 (t-3 / ac-10, ac-11) — POST /api/test-events dual-accepts the
// neutral `subject_ref` field AND the legacy `ac_uid` field, mapping both to the
// subject_ref column. A legacy ac_uid emitter still lands a row (ac-10), and the
// same ref under either field produces identical rows (ac-11). Mirrors the
// spec-234 / clause-emission harness.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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
import { mintEmissionKey } from "../services/emission-keys.js";

const M = "mindset-prod/memex-building-itself/specs/spec-151/acs";
const AC_10 = `${M}/ac-10`;
const AC_11 = `${M}/ac-11`;

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdOrgIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdSubjectRefs: string[] = [];

afterAll(async () => {
  if (createdSubjectRefs.length) {
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdSubjectRefs)).catch(() => {});
  }
  if (createdMemexIds.length) {
    await db.delete(memexEmissionKeys).where(inArray(memexEmissionKeys.memexId, createdMemexIds)).catch(() => {});
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

let ns: string;
let memexSlug: string;
let memexId: string;
let ownerUserId: string;
let ciKey: string;

interface PostFields {
  ac_uid?: string;
  subject_ref?: string;
  test_identifier: string;
}

async function post(fields: PostFields): Promise<Response> {
  return app.request("/api/test-events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "memex.ai",
      Authorization: `Bearer ${ciKey}`,
    },
    body: JSON.stringify({ ...fields, status: "pass", duration_ms: 5 }),
  });
}

beforeEach(() => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  }
});

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ email: `dual-${crypto.randomUUID()}@example.com`, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  ownerUserId = u.id;
  createdUserIds.push(u.id);
  const seeded = await createOrgWithMemexAndOwner({
    slug: `dual-accept-${crypto.randomUUID().slice(0, 8)}`,
    ownerUserId,
  });
  ns = seeded.namespace.slug;
  memexSlug = seeded.memex.slug;
  memexId = seeded.memex.id;
  createdMemexIds.push(memexId);
  createdOrgIds.push(seeded.org.id);
  createdNamespaceIds.push(seeded.namespace.id);
  ciKey = (await mintEmissionKey(memexId, "ci", ownerUserId)).raw;
});

describe("spec-151 dec-3 — /api/test-events dual-accepts ac_uid and subject_ref", () => {
  it("a request using the legacy ac_uid field still lands a row [ac-10]", async () => {
    tagAc(AC_10);
    const ref = `${ns}/${memexSlug}/specs/spec-legacy/acs/ac-1`;
    createdSubjectRefs.push(ref);
    const res = await post({ ac_uid: ref, test_identifier: "legacy::ac_uid" });
    expect(res.status).toBe(201);
    const rows = await db.select().from(testEvents).where(eq(testEvents.subjectRef, ref));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("a request using the new subject_ref field lands a row in the subject_ref column [ac-10]", async () => {
    tagAc(AC_10);
    const ref = `${ns}/${memexSlug}/standards/std-1/clauses/cl-7`;
    createdSubjectRefs.push(ref);
    const res = await post({ subject_ref: ref, test_identifier: "neutral::subject_ref" });
    expect(res.status).toBe(201);
    const rows = await db.select().from(testEvents).where(eq(testEvents.subjectRef, ref));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("the same ref via ac_uid and via subject_ref produces identical rows (lossless mapping) [ac-11]", async () => {
    tagAc(AC_11);
    const ref = `${ns}/${memexSlug}/specs/spec-loss/acs/ac-9`;
    createdSubjectRefs.push(ref);
    expect((await post({ ac_uid: ref, test_identifier: "loss::via-ac_uid" })).status).toBe(201);
    expect((await post({ subject_ref: ref, test_identifier: "loss::via-subject_ref" })).status).toBe(201);

    const rows = await db
      .select()
      .from(testEvents)
      .where(eq(testEvents.subjectRef, ref));
    const viaAcUid = rows.find((r) => r.testIdentifier === "loss::via-ac_uid");
    const viaSubjectRef = rows.find((r) => r.testIdentifier === "loss::via-subject_ref");
    expect(viaAcUid).toBeDefined();
    expect(viaSubjectRef).toBeDefined();
    // Identical on every mapped column except the per-row identity (id, created_at,
    // test_identifier): the field name on the wire does not change what is stored.
    expect(viaAcUid!.subjectRef).toBe(viaSubjectRef!.subjectRef);
    expect(viaAcUid!.subjectRef).toBe(ref);
    expect(viaAcUid!.memexId).toBe(viaSubjectRef!.memexId);
    expect(viaAcUid!.status).toBe(viaSubjectRef!.status);
    expect(viaAcUid!.durationMs).toBe(viaSubjectRef!.durationMs);
  });

  it("subject_ref wins when BOTH fields are present", async () => {
    tagAc(AC_11);
    const winner = `${ns}/${memexSlug}/standards/std-2/clauses/cl-2`;
    const loser = `${ns}/${memexSlug}/specs/spec-x/acs/ac-1`;
    createdSubjectRefs.push(winner, loser);
    const res = await post({
      subject_ref: winner,
      ac_uid: loser,
      test_identifier: "both::subject_ref-wins",
    });
    expect(res.status).toBe(201);
    expect(
      await db.select().from(testEvents).where(and(eq(testEvents.subjectRef, winner), eq(testEvents.testIdentifier, "both::subject_ref-wins"))),
    ).toHaveLength(1);
    expect(await db.select().from(testEvents).where(eq(testEvents.subjectRef, loser))).toHaveLength(0);
  });
});
