// spec-520 t-7 / ac-32 — the ingest path establishes tenant context, so its READS see
// their own rows. Runs ONLY under vitest.rls.config.ts, as the restricted `memex_app`
// role. In the default owner-connection suite RLS is bypassed (std-36: ENABLE, never
// FORCE), so this defect is INVISIBLE there — which is exactly why it lived in prod.
//
// THE DEFECT (spec-520 issue-6, measured on prod): the ingest path's issue auto-resolve
// returns empty for 99.96% of passing events. Not a tuning problem. `processOneEvent`
// calls `maybeAutoResolveIssuesForAcUid`, whose FIRST statement is a
// `documents ⋈ memexes ⋈ namespaces` join; `documents` carries `documents_memex_isolation`
// on `app.memex_id`; and `runWithMemexId` appeared NOWHERE in routes/test-events.ts. Under
// the non-owner runtime role the lookup is filtered to zero rows, so the chain concludes
// "nothing to resolve" — every time. spec-112 ac-22's second auto-resolve trigger, the one
// that closes the bug→failing-AC→green-AC→resolved loop from ingest, has been dead.
//
// THREE LAYERS OF SILENCE hid it, and each is individually reasonable:
//   1. the call is `.catch(() => {})` by design, so a test-result write can never fail
//   2. the owner role bypasses RLS, so dev and the default suite cannot reproduce it
//   3. the tenant-context guard that exists for this class watches WRITES — this is a READ
// A fix is not finished until at least one of those layers would now speak up. This file
// is that layer: under the real role, the route either resolves the Issue or it does not.
//
// SECOND INSTANCE OF A CLASS SPEC-440 WAS MEANT TO CLOSE. spec-440 t-6 fixed exactly this
// shape in `markPresent` (its own rls-restricted test sits beside this one) and shipped the
// write-side guard. The class is not closed for READS. Worth carrying to spec-440.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db, runWithMemexId } from "../db/connection.js";
import {
  acs,
  documents,
  issues,
  memexEmissionKeys,
  memexes,
  namespaces,
  taskSatisfiesAc,
  tasks,
  testEvents,
  testRunDaily,
  users,
} from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { createDocDraft } from "../services/documents.js";
import { mintEmissionKey } from "../services/emission-keys.js";
import { maybeAutoResolveIssuesForAcUid } from "../services/issues.js";
import { app } from "../app.js";

const AC_TENANT_CONTEXT = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-32";
// ac-22 is the ROLLUP's own claim: RLS enabled + not forced + a memex_id policy that an
// emission write actually satisfies, proven under this harness. Distinct from ac-32, which
// is the handler establishing context for its READS. The WRITE block below carries ac-22.
const AC_ROLLUP_RLS = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-22";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let memexId: string;
let userId: string;
let namespaceSlug: string;
let memexSlug: string;
let docId: string;
let taskId: string;
let acId: string;
let issueId: string;
let emissionKey: string;
let acRef: string;
let specHandle: string;

/** The AC ref the route will receive, and the one the auto-resolve chain reverses. */
const AC_SEQ = 1;

beforeAll(async () => {
  const user = await upsertUserByEmail(`spec520-t7-${runId}@example.com`);
  userId = user.id;

  // namespace + memex are NOT RLS-gated — writable by memex_app with no tenant GUC.
  const created = await ensureUserNamespace(userId);
  memexId = created.memex.id;
  memexSlug = created.memex.slug;
  const [ns] = await db
    .select({ slug: namespaces.slug })
    .from(namespaces)
    .where(eq(namespaces.id, created.memex.namespaceId))
    .limit(1);
  namespaceSlug = ns!.slug;

  // Everything below is RLS-gated, so seed it under the matching tenant context. Seeding
  // is NOT what is under test — the route's own context is.
  //
  // Worth recording: the first draft of this file read `documents.handle` back OUTSIDE the
  // wrapper and crashed on `undefined` — RLS filtered the row away. The test fell into the
  // very defect it exists to pin, which is how easy this class is to reintroduce.
  await runWithMemexId(memexId, async () => {
    const doc = await createDocDraft(memexId, `spec520 t7 target ${runId}`, "", "spec");
    docId = doc.id;
    specHandle = doc.handle;

    const [ac] = await db
      .insert(acs)
      .values({
        memexId,
        briefId: docId,
        seq: AC_SEQ,
        kind: "implementation",
        statement: "the verifying criterion",
        status: "active",
      } as typeof acs.$inferInsert)
      .returning();
    acId = ac!.id;

    const [task] = await db
      .insert(tasks)
      .values({
        memexId,
        docId,
        seq: 1,
        title: "the satisfying task",
        description: "",
        // COMPLETE is a precondition: maybeAutoResolveIssuesForTask returns [] otherwise.
        status: "complete",
      } as typeof tasks.$inferInsert)
      .returning();
    taskId = task!.id;

    await db.insert(taskSatisfiesAc).values({ taskId, acId } as typeof taskSatisfiesAc.$inferInsert);

    // A CONVERTED issue pointing at that task — the shape the down-bridge produces and the
    // only shape auto-resolve acts on.
    const [issue] = await db
      .insert(issues)
      .values({
        memexId,
        docId,
        seq: 1,
        title: "the issue awaiting a green AC",
        body: "",
        type: "bug",
        severity: "high",
        status: "converted",
        source: "agent",
        satisfyingTaskId: taskId,
        createdByUserId: userId,
      } as typeof issues.$inferInsert)
      .returning();
    issueId = issue!.id;
  });

  // The ref the emitter will send, built exactly as the chain reverses it. The handle comes
  // from the create result rather than a read-back — one less gated query to get wrong.
  acRef = `${namespaceSlug}/${memexSlug}/specs/${specHandle}/acs/ac-${AC_SEQ}`;

  emissionKey = (await mintEmissionKey(memexId, `spec520-t7-${runId}`, userId)).raw;
});

afterAll(async () => {
  await runWithMemexId(memexId, async () => {
    await db.delete(testEvents).where(eq(testEvents.subjectRef, acRef)).catch(() => {});
    await db.delete(testRunDaily).where(eq(testRunDaily.subjectRef, acRef)).catch(() => {});
    if (issueId) await db.delete(issues).where(eq(issues.id, issueId)).catch(() => {});
    if (taskId) await db.delete(tasks).where(eq(tasks.id, taskId)).catch(() => {});
    if (acId) await db.delete(acs).where(eq(acs.id, acId)).catch(() => {});
    if (docId) await db.delete(documents).where(eq(documents.id, docId)).catch(() => {});
  });
  await db.delete(memexEmissionKeys).where(eq(memexEmissionKeys.memexId, memexId)).catch(() => {});
  await db.delete(memexes).where(eq(memexes.id, memexId)).catch(() => {});
  await db.delete(namespaces).where(eq(namespaces.slug, namespaceSlug)).catch(() => {});
  await db.delete(users).where(inArray(users.id, [userId])).catch(() => {});
});

describe("spec-520 ac-32: the DIAGNOSIS — tenant context is what the chain needs", () => {
  // These two do not prove the fix (the fix is at the call site, not in this function).
  // They pin WHY the fix is what it is, under the real role — so a future reader cannot
  // conclude the auto-resolve chain is simply broken and rewrite the wrong thing.
  it("WITHOUT tenant context the chain finds nothing, though the Issue is resolvable", async () => {
    tagAc(AC_TENANT_CONTEXT);
    const resolved = await maybeAutoResolveIssuesForAcUid(acRef);
    // Zero, and not because there is nothing to resolve — the next test resolves the very
    // same Issue from the very same row. The documents lookup is filtered to no rows.
    expect(resolved).toEqual([]);
  });

  it("WITH tenant context the same call resolves the same Issue", async () => {
    tagAc(AC_TENANT_CONTEXT);
    // Give the AC a green event first: verifyingAcIsGreen gates the resolve.
    await runWithMemexId(memexId, async () => {
      await db.insert(testEvents).values({
        memexId,
        subjectRef: acRef,
        status: "pass",
        testIdentifier: "spec520-t7::diagnosis",
        durationMs: 1,
      } as typeof testEvents.$inferInsert);
    });

    const resolved = await runWithMemexId(memexId, async () =>
      maybeAutoResolveIssuesForAcUid(acRef),
    );
    expect(resolved).toContain(issueId);

    // Put it back to converted so the route test below starts from the same state.
    await runWithMemexId(memexId, async () => {
      await db.update(issues).set({ status: "converted" }).where(eq(issues.id, issueId));
    });
  });
});

describe("spec-520 ac-32: the FIX — the ROUTE establishes the context", () => {
  it("a passing emission through POST /api/test-events resolves the converted Issue", async () => {
    tagAc(AC_TENANT_CONTEXT);
    // THE red→green assertion. Before the fix the route called auto-resolve with no tenant
    // context, so this Issue stayed `converted` forever while the event was written happily
    // — silent, because the call is best-effort by design. Nothing in the response differs;
    // only the row does, which is why this asserts the ROW and not the status code.
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${emissionKey}`,
      },
      body: JSON.stringify({
        ac_uid: acRef,
        status: "pass",
        test_identifier: "spec520-t7::route",
        duration_ms: 1,
      }),
    });
    expect(res.status).toBe(201);

    // NOTE the `async` callback. `runWithMemexId(id, () => db.select(...))` returns the
    // QUERY BUILDER, and AsyncLocalStorage.run() has already returned by the time the
    // outer await executes it — so the query runs OUTSIDE the context and RLS filters it
    // to nothing. Cost me a debugging round; the async form keeps execution in the subtree.
    const [row] = await runWithMemexId(memexId, async () =>
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).limit(1),
    );
    expect(row?.status).toBe("resolved");
  });

  it("the event itself still lands — the fix must not cost the write", async () => {
    tagAc(AC_TENANT_CONTEXT);
    // The auto-resolve call is deliberately best-effort so it can never fail a CI run's
    // result write. Wrapping it in tenant context must not change that: assert the event
    // row exists regardless of what the resolve did.
    const [latest] = await runWithMemexId(memexId, async () =>
      db
        .select({ status: testEvents.status, id: testEvents.testIdentifier })
        .from(testEvents)
        .where(and(eq(testEvents.subjectRef, acRef), eq(testEvents.status, "pass")))
        .orderBy(desc(testEvents.createdAt))
        .limit(1),
    );
    expect(latest?.status).toBe("pass");
  });
});

describe("spec-520 ac-22 / issue-8: the WRITE half — an RLS-gated write inside the transaction", () => {
  // ac-32 (above) closed the READ half: the auto-resolve chain now runs in context. This
  // block closes the WRITE half, and the two are genuinely different failures.
  //
  // WHY THIS EXISTS AS A SEPARATE BLOCK. t-7 wrapped only the auto-resolve call, and that
  // was the right scope at the time — the write transaction touched no RLS-gated table, so
  // there was no policy for it to fail. t-9's rollup is the first one, which is what turned
  // a latent gap into a blocker (issue-8).
  //
  // THE FAILURE THIS PINS IS NOT SILENT, unlike the read half. Every tenant policy here
  // carries an explicit `IS NOT NULL` conjunct, so an unset `app.memex_id` makes the
  // predicate FALSE rather than NULL. For SELECT/UPDATE that filters to nothing — quiet.
  // For INSERT it RAISES. The rollup write is an upsert inside the same transaction as the
  // test_events insert, and mutate() rethrows, so the whole emission fails: this test went
  // red as a 500 on POST /api/test-events, not as a missing rollup row.
  //
  // And it can ONLY go red here. Under the owner role the policy is bypassed entirely
  // (std-36: ENABLE, never FORCE), so the default suite returns 201 either way — 6409 tests
  // passed against the unwrapped write. That is the whole reason this file exists.
  it("a passing emission lands its rollup row — the write ran inside tenant context", async () => {
    tagAc(AC_ROLLUP_RLS);
    tagAc(AC_TENANT_CONTEXT);

    // Scope every assertion to THIS test's own test_identifier. The ac-32 block above
    // already POSTed an emission for the same ref on the same UTC day, but under
    // `spec520-t7::route` — and test_identifier is part of the rollup key, so that is a
    // DIFFERENT row. Filtering only by (subject_ref, memex_id) returns both, which is the
    // grain working correctly and an assertion of `toHaveLength(1)` being wrong.
    const TEST_ID = "spec520-t9::rollup-under-rls";

    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${emissionKey}`,
      },
      body: JSON.stringify({
        ac_uid: acRef,
        status: "pass",
        test_identifier: TEST_ID,
        duration_ms: 1,
      }),
    });

    // 201, not 500. Without the wrap the rollup's WITH CHECK fails, the transaction aborts,
    // and this is a 500 — the event itself never lands either, which is the part that makes
    // the missing wrap an ingest outage rather than a lost metric. Verified: with migration
    // 0135 applied and the wrap absent, this returned 500 and so did ac-32's route test
    // above, because the transaction dies before the auto-resolve is even reached.
    expect(res.status).toBe(201);

    const after = await runWithMemexId(memexId, async () =>
      db
        .select({ runCount: testRunDaily.runCount, passCount: testRunDaily.passCount })
        .from(testRunDaily)
        .where(
          and(
            eq(testRunDaily.subjectRef, acRef),
            eq(testRunDaily.memexId, memexId),
            eq(testRunDaily.testIdentifier, TEST_ID),
          ),
        ),
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.runCount).toBe(1);
    expect(after[0]!.passCount).toBe(1);
  });

  it("the rollup row is stamped with the authenticated Memex, not left for a read-time parse", async () => {
    tagAc(AC_ROLLUP_RLS);
    tagAc(AC_TENANT_CONTEXT);

    // The row is only visible under its OWN tenant context — which is the policy doing its
    // job, and also the proof that memex_id was written correctly rather than defaulted.
    // A row stamped with the wrong memex would be invisible here; this asserts the column
    // directly so the reason is legible rather than inferred from an empty result.
    //
    // Every row for this ref, not one: the ac-32 block's emission used a different
    // test_identifier and therefore holds its own rollup row. Both must carry this memex.
    const rows = await runWithMemexId(memexId, async () =>
      db
        .select({ memexId: testRunDaily.memexId })
        .from(testRunDaily)
        .where(eq(testRunDaily.subjectRef, acRef)),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.memexId === memexId)).toBe(true);
  });

  it("under ANOTHER tenant's context the same rollup row is invisible — the policy is really on", async () => {
    tagAc(AC_ROLLUP_RLS);
    tagAc(AC_TENANT_CONTEXT);

    // Guards against the two tests above passing for the wrong reason. If RLS were not
    // actually enabled here (a migration that did not run, an ENABLE/FORCE mix-up), this
    // read would return the row and the whole block would assert nothing about tenancy.
    //
    // Reads under a FOREIGN tenant rather than with no context at all, deliberately. The
    // no-context version is not a clean assertion: with `app.memex_id` set to an empty
    // string the policy's own `::uuid` cast can be evaluated before the guarding
    // `IS NOT NULL` conjunct — SQL does not promise AND short-circuits — and the query
    // fails with `invalid input syntax for type uuid: ""` instead of returning no rows.
    // That failure still "proves" the policy is attached, but it proves it by erroring,
    // which is indistinguishable from a dozen other faults. A foreign tenant exercises the
    // predicate the way production does and can only come back empty.
    const otherTenant = "00000000-0000-4000-8000-000000000001";
    const leaked = await runWithMemexId(otherTenant, async () =>
      db
        .select({ subjectRef: testRunDaily.subjectRef })
        .from(testRunDaily)
        .where(eq(testRunDaily.subjectRef, acRef)),
    );
    expect(leaked).toEqual([]);
  });
});
