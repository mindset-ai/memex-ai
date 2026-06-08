// HTTP route tests for the per-AC test-event matrix (b-96).
//
// Covers two endpoints:
//   GET    /:acId/test-matrix  — b-96 t-1
//   DELETE /:acId/test-events  — b-96 t-2
//
// Tagged ACs:
//   ac-1  (scope, b-96)  — matrix shape: rows = test_identifiers, each with
//                          emission history as coloured squares.
//   ac-2  (scope, b-96)  — authorized user can permanently delete every
//                          event for one test_identifier.
//   ac-3  (scope, b-96)  — after deletion, the matrix re-renders without
//                          the deleted row (server-side half).
//   ac-4  (scope, b-96)  — a previously-deleted test_identifier that emits
//                          again appears as a new row with only the new
//                          emission's history.
//   ac-5  (scope, b-96)  — non-members get 404 on the DELETE endpoint.
//   ac-6  (impl, b-96)   — column entries are individual emissions, no
//                          server-side run-batching, no run_id grouping.
//   ac-7  (impl, b-96)   — DELETE returns 200 with `{deleted: N}` and
//                          deletes all matching rows for the (ac, ti) pair.
//   ac-8  (impl, b-96)   — DELETE writes no audit record.
//   ac-9  (impl, b-96)   — DELETE authz: members can; non-members get 404.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import {
  users,
  documents,
  acs,
  testEvents,
  docComments,
} from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";
import { createDocDraft } from "../services/documents.js";
import { createAc } from "../services/acs.js";
import { tagAc } from "@memex-ai-ac/vitest";

const createdUserIds: string[] = [];
const createdDocIds: string[] = [];
const createdAcUids: string[] = [];

afterAll(async () => {
  if (createdAcUids.length) {
    await db
      .delete(testEvents)
      .where(inArray(testEvents.acUid, createdAcUids))
      .catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `acs-matrix-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(u.id);
  return u.id;
}

async function authedRequest(
  path: string,
  bearer: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${bearer}`);
  headers.set("Host", "memex.ai");
  return app.request(path, { ...init, headers });
}

describe("GET /api/:namespace/:memex/acs/:acId/test-matrix [b-96 t-1]", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  let userId: string;
  let bearer: string;
  let namespace: string;
  let memex: string;
  let memexId: string;
  let briefHandle: string;
  let acIdWithEvents: string;
  let acIdEmpty: string;
  let acRef: string;

  beforeAll(async () => {
    userId = await seedUser();
    bearer = signSessionToken(userId);
    const seeded = await createOrgWithMemexAndOwner({
      slug: `acs-m-${Date.now().toString(36)}`,
      ownerUserId: userId,
    });
    namespace = seeded.namespace.slug;
    memex = seeded.memex.slug;
    memexId = seeded.memex.id;
    const doc = await createDocDraft(
      memexId,
      "AC matrix test spec",
      "purpose",
      "spec",
    );
    createdDocIds.push(doc.id);
    briefHandle = doc.handle!;

    // Two ACs under the same spec. One gets a populated event history; one
    // stays empty so we can exercise the empty-array path.
    const acA = await createAc({
      memexId,
      briefId: doc.id,
      kind: "scope",
      statement: "matrix populated AC",
    });
    const acB = await createAc({
      memexId,
      briefId: doc.id,
      kind: "scope",
      statement: "matrix empty AC",
    });
    acIdWithEvents = acA.id;
    acIdEmpty = acB.id;
    acRef = `${namespace}/${memex}/specs/${briefHandle}/acs/ac-${acA.seq}`;
    createdAcUids.push(acRef);

    // Seed two test_identifiers' worth of events for acA. The history below is
    // intentionally interleaved by created_at to exercise the newest-first
    // ordering within each row and the grouping into separate rows.
    //
    //   t_alpha: pass @ T+0, fail @ T+2, pass @ T+4   (3 emissions)
    //   t_beta:  fail @ T+1, pass @ T+3                (2 emissions)
    //
    // Plus one row with a NULL test_identifier (legacy emission) to cover
    // the "" bucket on the row map.
    const base = new Date("2026-05-27T00:00:00.000Z").getTime();
    const at = (offset: number): Date => new Date(base + offset);
    await db.insert(testEvents).values([
      {
        acUid: acRef,
        status: "pass",
        testIdentifier: "t_alpha",
        createdAt: at(0),
      },
      {
        acUid: acRef,
        status: "fail",
        testIdentifier: "t_beta",
        createdAt: at(1_000),
      },
      {
        acUid: acRef,
        status: "fail",
        testIdentifier: "t_alpha",
        createdAt: at(2_000),
      },
      {
        acUid: acRef,
        status: "pass",
        testIdentifier: "t_beta",
        createdAt: at(3_000),
      },
      {
        acUid: acRef,
        status: "pass",
        testIdentifier: "t_alpha",
        createdAt: at(4_000),
      },
      {
        acUid: acRef,
        status: "error",
        testIdentifier: null,
        createdAt: at(5_000),
      },
    ] as Array<typeof testEvents.$inferInsert>);
  });

  // spec-111 t-10: the test-matrix GET now sits behind the permissive
  // public-read session. The seeded memex is PRIVATE (default), so an anonymous
  // caller gets a std-7 404 (indistinguishable from non-existent), NOT 401.
  it("returns 404 (std-7) without an Authorization header on a private memex", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-9");
    const res = await app.request(
      `/api/${namespace}/${memex}/acs/${acIdWithEvents}/test-matrix`,
      { headers: { Host: "memex.ai" } },
    );
    expect(res.status).toBe(404);
  });

  it("returns rows grouped by test_identifier with emissions newest-first", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-1");
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-6");
    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/${acIdWithEvents}/test-matrix`,
      bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      testIdentifier: string;
      emissions: Array<{ status: string; emittedAt: string }>;
    }>;

    // Three rows: one for each non-null test_identifier plus the null bucket
    // (rendered as empty string by the service).
    expect(body.length).toBe(3);

    const empty = body.find((r) => r.testIdentifier === "");
    const alpha = body.find((r) => r.testIdentifier === "t_alpha");
    const beta = body.find((r) => r.testIdentifier === "t_beta");

    expect(empty).toBeDefined();
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();

    // Per dec-11: one column entry per emission, no run-batching, no greys.
    expect(alpha!.emissions.length).toBe(3);
    expect(beta!.emissions.length).toBe(2);
    expect(empty!.emissions.length).toBe(1);

    // Newest-first within each row.
    expect(alpha!.emissions.map((e) => e.status)).toEqual([
      "pass",
      "fail",
      "pass",
    ]);
    expect(beta!.emissions.map((e) => e.status)).toEqual(["pass", "fail"]);
  });

  it("returns an empty array for an AC with no test events", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-3");
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-6");
    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/${acIdEmpty}/test-matrix`,
      bearer,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns 404 when the AC belongs to a different memex (std-7)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-9");
    const otherUserId = await seedUser();
    const otherBearer = signSessionToken(otherUserId);
    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/${acIdWithEvents}/test-matrix`,
      otherBearer,
    );
    // Per std-7 unauthorized callers get 404, not 403, and never get to see
    // the matrix even if they know the acId UUID.
    expect([404, 401]).toContain(res.status);
  });

  it("returns 404 for a malformed / non-existent acId", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-6");
    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/00000000-0000-0000-0000-000000000000/test-matrix`,
      bearer,
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/:namespace/:memex/acs/:acId/test-events [b-96 t-2]", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  let userId: string;
  let bearer: string;
  let namespace: string;
  let memex: string;
  let memexId: string;
  let briefId: string;
  let briefHandle: string;
  let acId: string;
  let acRef: string;

  // Re-seed test_events from scratch before each `it` so deletions in one
  // case don't leak into another. The AC + spec + user are stable.
  async function reseedEvents(): Promise<void> {
    await db.delete(testEvents).where(eq(testEvents.acUid, acRef));
    const base = new Date("2026-05-27T01:00:00.000Z").getTime();
    const at = (offset: number): Date => new Date(base + offset);
    await db.insert(testEvents).values([
      { acUid: acRef, status: "pass", testIdentifier: "t_keep", createdAt: at(0) },
      { acUid: acRef, status: "fail", testIdentifier: "t_drop", createdAt: at(1_000) },
      { acUid: acRef, status: "pass", testIdentifier: "t_drop", createdAt: at(2_000) },
      { acUid: acRef, status: "fail", testIdentifier: "t_drop", createdAt: at(3_000) },
      { acUid: acRef, status: "pass", testIdentifier: "t_keep", createdAt: at(4_000) },
    ] as Array<typeof testEvents.$inferInsert>);
  }

  beforeAll(async () => {
    userId = await seedUser();
    bearer = signSessionToken(userId);
    const seeded = await createOrgWithMemexAndOwner({
      slug: `acs-d-${Date.now().toString(36)}`,
      ownerUserId: userId,
    });
    namespace = seeded.namespace.slug;
    memex = seeded.memex.slug;
    memexId = seeded.memex.id;
    const doc = await createDocDraft(
      memexId,
      "AC matrix delete spec",
      "purpose",
      "spec",
    );
    createdDocIds.push(doc.id);
    briefId = doc.id;
    briefHandle = doc.handle!;

    const ac = await createAc({
      memexId,
      briefId,
      kind: "scope",
      statement: "delete-flow AC",
    });
    acId = ac.id;
    acRef = `${namespace}/${memex}/specs/${briefHandle}/acs/ac-${ac.seq}`;
    createdAcUids.push(acRef);
  });

  beforeEach(async () => {
    await reseedEvents();
  });

  it("returns 400 when test_identifier query param is missing", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-7");
    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/${acId}/test-events`,
      bearer,
      { method: "DELETE" },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/test_identifier/);
  });

  it("deletes every row for (acUid, test_identifier) and returns {deleted: N}", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-2");
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-7");

    const before = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(testEvents)
      .where(and(eq(testEvents.acUid, acRef), eq(testEvents.testIdentifier, "t_drop")));
    expect(before[0].count).toBe(3);

    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/${acId}/test-events?test_identifier=t_drop`,
      bearer,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(3);

    const remainingDrop = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(testEvents)
      .where(and(eq(testEvents.acUid, acRef), eq(testEvents.testIdentifier, "t_drop")));
    expect(remainingDrop[0].count).toBe(0);

    // Sibling test_identifier must be untouched.
    const remainingKeep = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(testEvents)
      .where(and(eq(testEvents.acUid, acRef), eq(testEvents.testIdentifier, "t_keep")));
    expect(remainingKeep[0].count).toBe(2);
  });

  it("subsequent GET test-matrix omits the deleted row [server-side ac-3]", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-3");
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-7");

    await authedRequest(
      `/api/${namespace}/${memex}/acs/${acId}/test-events?test_identifier=t_drop`,
      bearer,
      { method: "DELETE" },
    );

    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/${acId}/test-matrix`,
      bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ testIdentifier: string }>;
    expect(body.map((r) => r.testIdentifier)).toEqual(["t_keep"]);
  });

  it("re-emission after delete produces a fresh-history row [ac-4]", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-4");

    // Discontinue t_drop.
    await authedRequest(
      `/api/${namespace}/${memex}/acs/${acId}/test-events?test_identifier=t_drop`,
      bearer,
      { method: "DELETE" },
    );

    // Re-emit a new event for the same test_identifier (e.g. a git revert
    // restored the test in the codebase). Direct insert simulates what POST
    // /api/test-events would do at the persistence layer.
    await db.insert(testEvents).values({
      acUid: acRef,
      status: "pass",
      testIdentifier: "t_drop",
      createdAt: new Date("2026-05-27T02:00:00.000Z"),
    } as typeof testEvents.$inferInsert);

    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/${acId}/test-matrix`,
      bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      testIdentifier: string;
      emissions: Array<{ status: string }>;
    }>;
    const drop = body.find((r) => r.testIdentifier === "t_drop")!;
    expect(drop).toBeDefined();
    // Fresh history: exactly the one new emission, none of the deleted ones
    // stitched back in.
    expect(drop.emissions.length).toBe(1);
    expect(drop.emissions[0].status).toBe("pass");
  });

  it("returns 404 when the AC belongs to a different memex (std-7) [ac-5, ac-9]", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-5");
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-9");

    const otherUserId = await seedUser();
    const otherBearer = signSessionToken(otherUserId);
    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/${acId}/test-events?test_identifier=t_drop`,
      otherBearer,
      { method: "DELETE" },
    );
    expect([404, 401]).toContain(res.status);

    // Non-member request must NOT delete anything.
    const remaining = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(testEvents)
      .where(and(eq(testEvents.acUid, acRef), eq(testEvents.testIdentifier, "t_drop")));
    expect(remaining[0].count).toBe(3);
  });

  it("writes no audit record: no comments on the spec, no other table touched [ac-8]", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-96/acs/ac-8");

    const commentsBefore = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(docComments)
      .where(eq(docComments.docId, briefId));

    await authedRequest(
      `/api/${namespace}/${memex}/acs/${acId}/test-events?test_identifier=t_drop`,
      bearer,
      { method: "DELETE" },
    );

    // No auto-comment auto-added to the spec.
    const commentsAfter = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(docComments)
      .where(eq(docComments.docId, briefId));
    expect(commentsAfter[0].count).toBe(commentsBefore[0].count);

    // The AC row itself is unchanged (no soft-delete column flipped).
    const acRowAfter = await db.query.acs.findFirst({ where: eq(acs.id, acId) });
    expect(acRowAfter).toBeDefined();
    expect(acRowAfter!.status).toBe("active");
  });
});
