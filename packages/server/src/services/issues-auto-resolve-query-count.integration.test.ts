// spec-520 t-15 / ac-33 — the ingest path's auto-resolve reverse lookup costs ONE query,
// not three.
//
// WHY THIS IS DB-BACKED AND COUNTS AGAINST A REAL `db`. Two ways to write this test are
// available and both are wrong, and t-15 exists partly because the second one hid the cost
// for months:
//
//   1. Against the route's mocked `db.select`: the bare stub makes `.from()` throw, the
//      handler's deliberate best-effort catch swallows it, and the spy records exactly ONE
//      call however many the real path makes. A count assertion there reports 1 forever —
//      it would have passed against the three-query implementation and against a one-query
//      one, identically.
//   2. Without tenant context: pre-t-7, `documents` RLS filtered the first lookup to zero
//      rows, so the chain returned at statement 1. A test in that state also sees one
//      query, also passes, and also measures nothing. That is precisely the reading that
//      made s-4 §4 conclude the cost was 0.44% of DB time and t-15's premise dead.
//
// So the count is taken against a real database, with a resolvable document, inside
// `runWithMemexId`. (Under the default owner connection RLS is bypassed anyway — std-36:
// ENABLE, never FORCE — so the wrapper is not what makes this work here. It is kept
// because the property under test is "the chain runs to completion", and the wrapper is
// how the production path guarantees that.)
//
// THE COST BEING REMOVED, measured on prod as a 600s delta 2026-08-28 (c-9):
//   documents ⋈ memexes ⋈ namespaces   30.970 calls/s   0.0770 ms
//   task_satisfies_ac                  30.972 calls/s   0.0314 ms
//   (event rate                        30.973 calls/s)
// The chain runs on essentially every event and costs ≈18% of the emission path. A third
// statement — the `acs` lookup — is in the chain but was outside that query filter, so
// 0.1084 ms/event is a lower bound.

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db, runWithMemexId } from "../db/connection.js";
import { acs, documents, memexes, namespaces, taskSatisfiesAc, tasks } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { maybeAutoResolveIssuesForAcUid } from "./issues.js";
import { makeTestMemex } from "./test-helpers.js";

const AC_ONE_QUERY = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-33";

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];

/** Seed a Spec + one AC, and return the ref the ingest path would receive. */
async function seedAcRef(seq: number, withSatisfyingTask: boolean): Promise<string> {
  return runWithMemexId(memexId, async () => {
    const doc = await createDocDraft(memexId, `t15 target ${seq}`, "", "spec");
    createdDocIds.push(doc.id);

    const [ac] = await db
      .insert(acs)
      .values({
        memexId,
        briefId: doc.id,
        seq,
        kind: "implementation",
        statement: "the criterion under reverse lookup",
        status: "active",
      } as typeof acs.$inferInsert)
      .returning();

    if (withSatisfyingTask) {
      const [task] = await db
        .insert(tasks)
        .values({
          memexId,
          docId: doc.id,
          seq: 1,
          title: "the satisfying task",
          description: "",
          status: "complete",
        } as typeof tasks.$inferInsert)
        .returning();
      await db
        .insert(taskSatisfiesAc)
        .values({ taskId: task!.id, acId: ac!.id } as typeof taskSatisfiesAc.$inferInsert);
    }

    return `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${seq}`;
  });
}

beforeAll(async () => {
  memexId = await makeTestMemex("t15");
  const [row] = await db
    .select({ m: memexes.slug, n: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  memexSlug = row!.m;
  namespaceSlug = row!.n;
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

describe("spec-520 ac-33: the auto-resolve reverse lookup issues ONE query", () => {
  it("costs exactly one query on the common path — an AC with no satisfying task", async () => {
    tagAc(AC_ONE_QUERY);

    // THE dominant case, and the one the prod delta measures: the overwhelming majority of
    // passing events are for ACs that no converted Issue is waiting on. Before this change
    // such an event still paid all three statements to discover there was nothing to do —
    // `documents ⋈ memexes ⋈ namespaces`, then `acs`, then `task_satisfies_ac` — because
    // every early return in the chain is a NOT-FOUND return, never a cheap-path return.
    const acRef = await seedAcRef(1, false);

    const spy = vi.spyOn(db, "select");
    try {
      const resolved = await runWithMemexId(memexId, async () =>
        maybeAutoResolveIssuesForAcUid(acRef),
      );
      expect(resolved).toEqual([]);
      // Was 3. Counting db.select isolates the reverse lookup: everything downstream
      // (maybeAutoResolveIssuesForTask, verifyingAcIsGreen) goes through db.query.*, and on
      // this path the satisfying set is empty so none of it runs at all.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      // std-37 cl-5: restore what the test replaced, or the next file inherits the spy.
      spy.mockRestore();
    }
  });

  it("still finds the satisfying task through that single query", async () => {
    tagAc(AC_ONE_QUERY);

    // The collapse must not lose the join's RESULT. This asserts the lookup still reaches
    // the satisfying task — the row the old third statement existed to fetch — rather than
    // only asserting that fewer queries ran, which a broken implementation returning []
    // would also satisfy.
    const acRef = await seedAcRef(2, true);

    const spy = vi.spyOn(db, "select");
    try {
      await runWithMemexId(memexId, async () => maybeAutoResolveIssuesForAcUid(acRef));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the tenant scoping — a ref naming another namespace resolves to nothing [per std-7]", async () => {
    tagAc(AC_ONE_QUERY);

    // `documents.handle` is per-memex, NOT globally unique. Collapsing three statements
    // into one join is exactly where a scoping conjunct is easiest to drop, and dropping it
    // turns a bare handle match into a cross-tenant resolution. The one-query form must
    // still require namespace AND memex to match.
    const acRef = await seedAcRef(3, true);
    const foreign = acRef.replace(`${namespaceSlug}/${memexSlug}/`, `${namespaceSlug}/not-this-memex/`);
    expect(foreign).not.toBe(acRef);

    const resolved = await runWithMemexId(memexId, async () =>
      maybeAutoResolveIssuesForAcUid(foreign),
    );
    expect(resolved).toEqual([]);
  });

  it("returns nothing for a ref that is not an AC ref at all", async () => {
    tagAc(AC_ONE_QUERY);
    // The grammar guard runs before any query. Kept so the collapse cannot accidentally
    // move parsing after the database round trip.
    const spy = vi.spyOn(db, "select");
    try {
      expect(await maybeAutoResolveIssuesForAcUid("not/a/valid/ref")).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
