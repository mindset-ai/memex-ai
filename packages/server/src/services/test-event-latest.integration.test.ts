// Integration tests for the test_event_latest summary table (spec-162).
//
// DB-backed by necessity: the whole point of this change is the SQL-level
// maintenance (ON CONFLICT upsert, discontinue delete, the backfill migration)
// and the read paths that consume the summary. A unit test on the pure helpers
// would miss the conflict semantics, the NULL→'' keying, and the schema shape.
//
// Tagged to the spec-162 implementation ACs. Emissions route to the prod Memex
// (namespace-derived) and need MEMEX_EMIT_KEY in CI to land; locally they are
// inert (MEMEX_EMIT=false) — the assertions below are what actually verify the
// behaviour, the tags just attribute that verification to the AC.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { db, sqlClient } from "../db/connection.js";
import {
  documents,
  acs,
  testEvents,
  testEventLatest,
  memexes,
  namespaces,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import {
  createAc,
  aggregateAcHealthForBriefs,
  discontinueTestEventsForAc,
} from "./acs.js";
import { applyEmissionToSummary } from "./test-event-latest.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-162";

const createdDocIds: string[] = [];
const createdAcUids: string[] = [];

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
let refCounter = 0;

beforeAll(async () => {
  memexId = await makeTestMemex("tel");
  const [row] = await db
    .select({ memexSlug: memexes.slug, namespaceSlug: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (!row) throw new Error("could not resolve test memex slugs");
  memexSlug = row.memexSlug;
  namespaceSlug = row.namespaceSlug;
});

afterAll(async () => {
  if (createdAcUids.length) {
    await db
      .delete(testEvents)
      .where(inArray(testEvents.acUid, createdAcUids))
      .catch(() => {});
    await db
      .delete(testEventLatest)
      .where(inArray(testEventLatest.acUid, createdAcUids))
      .catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

/** A unique synthetic ac_uid under the test memex — for summary-table
 *  assertions that don't need a real AC row. */
function uniqueRef(): string {
  refCounter += 1;
  const ref = `${namespaceSlug}/${memexSlug}/specs/spec-x/acs/ac-${refCounter}`;
  createdAcUids.push(ref);
  return ref;
}

async function seedSpec(): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, "tel test", "purpose", "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle! };
}

function refOf(briefHandle: string, seq: number): string {
  return `${namespaceSlug}/${memexSlug}/specs/${briefHandle}/acs/ac-${seq}`;
}

async function summaryRow(acUid: string, testIdentifier = "") {
  const [row] = await db
    .select()
    .from(testEventLatest)
    .where(
      and(
        eq(testEventLatest.acUid, acUid),
        eq(testEventLatest.testIdentifier, testIdentifier),
      ),
    );
  return row;
}

describe("test_event_latest maintenance (spec-162)", () => {
  it("upserts the summary on emission: latest status/run_at advance, run_count bumps [ac-5]", async () => {
    tagAc(`${SPEC}/acs/ac-5`);
    const ref = uniqueRef();
    const tid = "tests/a.test.ts::it works";

    await seedTestEvent({
      acUid: ref,
      status: "pass",
      testIdentifier: tid,
      createdAt: new Date(Date.now() - 2000),
    });
    let row = await summaryRow(ref, tid);
    expect(row?.latestStatus).toBe("pass");
    expect(row?.runCount).toBe(1);

    // A newer fail for the same pair flips latest and increments run_count.
    await seedTestEvent({
      acUid: ref,
      status: "fail",
      testIdentifier: tid,
      createdAt: new Date(Date.now() - 1000),
    });
    row = await summaryRow(ref, tid);
    expect(row?.latestStatus).toBe("fail");
    expect(row?.runCount).toBe(2);
  });

  it("keeps run_count as count-of-non-hidden and never regresses latest on an older event [ac-5]", async () => {
    tagAc(`${SPEC}/acs/ac-5`);
    const ref = uniqueRef();
    const tid = "tests/order.test.ts::it works";

    await seedTestEvent({ acUid: ref, status: "fail", testIdentifier: tid, createdAt: new Date() });
    // An OLDER pass arrives after the newer fail (out-of-order seed): run_count
    // still counts it, but latest must NOT regress to pass.
    await seedTestEvent({
      acUid: ref,
      status: "pass",
      testIdentifier: tid,
      createdAt: new Date(Date.now() - 60_000),
    });
    const row = await summaryRow(ref, tid);
    expect(row?.latestStatus).toBe("fail");
    expect(row?.runCount).toBe(2);
  });

  it("a hidden emission leaves the summary untouched and never creates a row [ac-6]", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    // ac-3 (scope): hidden-event semantics holding in the new read path.
    tagAc(`${SPEC}/acs/ac-3`);

    // (a) hidden-only pair → no summary row at all.
    const hiddenOnly = uniqueRef();
    await seedTestEvent({ acUid: hiddenOnly, status: "pass", testIdentifier: "t", hidden: true });
    expect(await summaryRow(hiddenOnly, "t")).toBeUndefined();

    // (b) a visible row, then a newer hidden fail — summary must NOT change.
    const ref = uniqueRef();
    const tid = "tests/h.test.ts::it works";
    await seedTestEvent({
      acUid: ref,
      status: "pass",
      testIdentifier: tid,
      createdAt: new Date(Date.now() - 1000),
    });
    const before = await summaryRow(ref, tid);
    await seedTestEvent({ acUid: ref, status: "fail", testIdentifier: tid, hidden: true });
    const after = await summaryRow(ref, tid);
    expect(after?.latestStatus).toBe("pass");
    expect(after?.runCount).toBe(1);
    expect(after?.latestRunAt?.getTime()).toBe(before?.latestRunAt?.getTime());
  });

  it("discontinue deletes the summary row so the pair drops out of the badge [ac-7]", async () => {
    tagAc(`${SPEC}/acs/ac-7`);
    // ac-3 (scope): badge stays correct under the discontinue hard-delete with
    // no stale 'latest' left behind — the b-96 orphan failure mode.
    tagAc(`${SPEC}/acs/ac-3`);
    const spec = await seedSpec();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "discontinue me",
    });
    const ref = refOf(spec.handle, ac.seq);
    createdAcUids.push(ref);
    const tid = "tests/gone.test.ts::it works";
    await seedTestEvent({ acUid: ref, status: "fail", testIdentifier: tid });
    expect(await summaryRow(ref, tid)).toBeDefined();

    await discontinueTestEventsForAc(memexId, ac.id, tid);

    expect(await summaryRow(ref, tid)).toBeUndefined();
    // And the board read now sees the AC as untested (covered 0), not failing.
    const health = await aggregateAcHealthForBriefs(memexId, [spec.id]);
    expect(health.get(spec.id)).toMatchObject({ totalActive: 1, covered: 0, untested: 1, failing: 0 });
  });

  it("the board read consumes the summary, not the raw log [ac-8]", async () => {
    tagAc(`${SPEC}/acs/ac-8`);
    // ac-1 (scope): this is the bounded-read property — the roll-up derives from
    // the O(active AC×test pairs) summary, not the O(history) log. The <300ms
    // prod-volume figure in ac-1 is the emergent consequence of that bound.
    tagAc(`${SPEC}/acs/ac-1`);
    const spec = await seedSpec();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "log vs summary",
    });
    const ref = refOf(spec.handle, ac.seq);
    createdAcUids.push(ref);

    // A raw log insert that BYPASSES summary maintenance must be invisible to
    // the badge — proving the read derives from test_event_latest, not the log.
    await db.insert(testEvents).values({
      acUid: ref,
      status: "pass",
      testIdentifier: "tests/raw.test.ts::it works",
    });
    let health = await aggregateAcHealthForBriefs(memexId, [spec.id]);
    expect(health.get(spec.id)).toMatchObject({ totalActive: 1, covered: 0, untested: 1 });

    // Once the same event is recorded through the maintained path, it shows.
    await seedTestEvent({ acUid: ref, status: "pass", testIdentifier: "tests/raw.test.ts::it works" });
    health = await aggregateAcHealthForBriefs(memexId, [spec.id]);
    expect(health.get(spec.id)).toMatchObject({ totalActive: 1, covered: 1, verified: 1 });
  });

  it("two null-test_identifier emissions collapse to a single '' row [ac-9]", async () => {
    tagAc(`${SPEC}/acs/ac-9`);
    const ref = uniqueRef();
    await seedTestEvent({ acUid: ref, status: "pass", testIdentifier: null, createdAt: new Date(Date.now() - 1000) });
    await seedTestEvent({ acUid: ref, status: "fail", testIdentifier: null });

    const rows = await db
      .select()
      .from(testEventLatest)
      .where(eq(testEventLatest.acUid, ref));
    expect(rows.length).toBe(1);
    expect(rows[0]?.testIdentifier).toBe("");
    expect(rows[0]?.latestStatus).toBe("fail");
    expect(rows[0]?.runCount).toBe(2);
  });
});

describe("test_event_latest schema + backfill (spec-162)", () => {
  it("test_identifier is NOT NULL DEFAULT '' and the PK is (ac_uid, test_identifier) [ac-10]", async () => {
    tagAc(`${SPEC}/acs/ac-10`);

    const cols = (await db.execute(sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'test_event_latest' AND column_name = 'test_identifier'
    `)) as unknown as Array<{ is_nullable: string; column_default: string | null }>;
    expect(cols[0]?.is_nullable).toBe("NO");
    expect(cols[0]?.column_default ?? "").toContain("''");

    const pk = (await db.execute(sql`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'test_event_latest'::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)
    `)) as unknown as Array<{ column_name: string }>;
    expect(pk.map((r) => r.column_name)).toEqual(["ac_uid", "test_identifier"]);
  });

  it("the backfill migration is correct (newest non-hidden, count of non-hidden, hidden-only excluded) and idempotent [ac-11]", async () => {
    tagAc(`${SPEC}/acs/ac-11`);
    // ac-4 (scope): existing history is backfilled so badges are correct
    // immediately after deploy, with no all-untested window.
    tagAc(`${SPEC}/acs/ac-4`);
    const ref = uniqueRef();
    const now = Date.now();
    const at = (sAgo: number) => new Date(now - sAgo * 1000);

    // Seed RAW test_events (bypassing summary maintenance) so the backfill has
    // something to reconstruct from a cold summary.
    await db.insert(testEvents).values([
      { acUid: ref, status: "pass", testIdentifier: "tA", createdAt: at(50) },
      { acUid: ref, status: "pass", testIdentifier: "tA", createdAt: at(40) },
      { acUid: ref, status: "fail", testIdentifier: "tA", createdAt: at(30) }, // newest visible
      { acUid: ref, status: "error", testIdentifier: "tA", hidden: true, createdAt: at(10) }, // newest overall but hidden
      { acUid: ref, status: "pass", testIdentifier: "tHidden", hidden: true, createdAt: at(20) }, // hidden-only pair
      { acUid: ref, status: "pass", testIdentifier: null, createdAt: at(15) }, // null → ''
    ]);

    const migrationSql = readFileSync(
      new URL("../../drizzle/0075_add_test_event_latest.sql", import.meta.url),
      "utf8",
    );
    await sqlClient.unsafe(migrationSql);

    const rowsAfterFirst = await db
      .select()
      .from(testEventLatest)
      .where(eq(testEventLatest.acUid, ref));

    const byTid = new Map(rowsAfterFirst.map((r) => [r.testIdentifier, r]));
    // (ref, 'tA'): newest non-hidden is the fail; the hidden error is excluded;
    // run_count counts the three non-hidden events only.
    expect(byTid.get("tA")?.latestStatus).toBe("fail");
    expect(byTid.get("tA")?.runCount).toBe(3);
    // (ref, '') from the null-identifier event.
    expect(byTid.get("")?.latestStatus).toBe("pass");
    expect(byTid.get("")?.runCount).toBe(1);
    // A pair whose only events are hidden produces NO row.
    expect(byTid.has("tHidden")).toBe(false);

    // Idempotent: re-running the migration changes nothing (ON CONFLICT DO NOTHING).
    await sqlClient.unsafe(migrationSql);
    const rowsAfterSecond = await db
      .select()
      .from(testEventLatest)
      .where(eq(testEventLatest.acUid, ref));
    expect(rowsAfterSecond.length).toBe(rowsAfterFirst.length);
    const byTid2 = new Map(rowsAfterSecond.map((r) => [r.testIdentifier, r]));
    expect(byTid2.get("tA")?.runCount).toBe(3);
    expect(byTid2.get("")?.runCount).toBe(1);
  });

  it("applyEmissionToSummary is a no-op for hidden inside a transaction [ac-6]", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const ref = uniqueRef();
    await db.transaction(async (tx) => {
      await applyEmissionToSummary(tx, {
        acUid: ref,
        testIdentifier: "t",
        status: "fail",
        latestRunAt: new Date(),
        hidden: true,
      });
    });
    expect(await summaryRow(ref, "t")).toBeUndefined();
  });
});
