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
  users,
} from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { createDocDraft } from "../services/documents.js";
import { mintEmissionKey } from "../services/emission-keys.js";
import { maybeAutoResolveIssuesForAcUid } from "../services/issues.js";
import { app } from "../app.js";

const AC_TENANT_CONTEXT = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-32";

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
