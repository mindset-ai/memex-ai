// spec-566 t-6 — superseding a criterion must not rewrite the past.
//
//   ac-12  capture the coverage series for the days preceding a supersession,
//          supersede, re-read, and assert those days are byte-identical.
//
// THE DEFECT, in the code's own words. `listAcAlignmentOverTime` builds its AC
// set with `eq(acs.status, "active")` — today's status — and the doc comment
// states the consequence plainly:
//
//   "An AC currently `rejected` or `superseded` is excluded from the total even
//    on days when it was active."
//
// So a supersession does not only change today's number; it retroactively
// redraws the whole trend. A Spec that genuinely stood at 10 of 11 last Tuesday
// is shown as having stood at 10 of 10. The comment calls this a V0.0.1
// simplification, acceptable "because nothing supersedes ACs at volume", and
// names the missing piece: "a status-event log we don't have". spec-566 builds
// both — the verb that creates the volume (t-2) and the journal (t-1) — so the
// caveat expires the day the verb ships.
//
// WHY THE FIXTURE LOOKS LIKE THIS. The series gates `total` on the AC's
// `created_at`, so an AC created today counts toward nothing on any earlier day:
// a case asserting anything about the past has to put the ACs in the past first.
// And `verified` reads `test_run_daily`, not the raw log, so the rollup is what
// gets seeded.
//
// The supersession is performed through the REAL verb (propose → accept), not by
// writing `status = 'superseded'` into the table. The fix reconstructs history
// from the journal rows the accept writes; a hand-stamped status would leave no
// journal row, and the test would then pass by proving the fix cannot see the
// transition at all.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  acs,
  documents,
  memexes,
  namespaces,
  specLifecycleEvents,
  testEventLatest,
  testEvents,
  testRunDaily,
} from "../db/schema.js";
import { createAc, listAcAlignmentOverTime, type AlignmentDay } from "./acs.js";
import { acceptAcSupersession, proposeAcSupersession } from "./ac-supersession.js";
import { createDecision } from "./decisions.js";
import { createDocDraft } from "./documents.js";
import { makeTestMemex } from "./test-helpers.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

/** How far back the ACs are created, and where the green rollup rows sit. */
const AC_AGE_DAYS = 10;
const ROLLUP_DAY_OFFSET = 5;

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

async function seedRollup(ref: string, dayOffset: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO test_run_daily
      (memex_id, subject_ref, test_identifier, day, run_count, pass_count, fail_count, error_count)
    VALUES (
      ${memexId}::uuid, ${ref}, ${"suite.test.ts::claim"},
      CURRENT_DATE - ${dayOffset}::int, 1, 1, 0, 0
    )
    ON CONFLICT (memex_id, subject_ref, test_identifier, day) DO NOTHING
  `);
}

/**
 * A Spec that has stood at 2 of 2 for ten days, and a decision to retire one of
 * its criteria under.
 */
async function seedTwoOfTwo(): Promise<{
  briefId: string;
  doomedAcId: string;
  decisionId: string;
}> {
  const doc = await createDocDraft(memexId, "alignment honesty fixture", "purpose", "spec");
  createdDocIds.push(doc.id);

  const acIds: string[] = [];
  for (let i = 1; i <= 2; i++) {
    const ac = await createAc({
      memexId,
      briefId: doc.id,
      kind: "implementation",
      statement: `Criterion ${i} holds.`,
    });
    acIds.push(ac.id);
    const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;
    createdRefs.push(ref);
    await seedRollup(ref, ROLLUP_DAY_OFFSET);
  }

  // The series gates on the AC's own createdAt, so the criteria have to have
  // existed on the days this test makes claims about.
  await db.execute(sql`
    UPDATE acs SET created_at = now() - (${AC_AGE_DAYS} || ' days')::interval
    WHERE id IN (${sql.join(acIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);

  const decision = await createDecision(
    memexId,
    doc.id,
    "Criterion 2 was written against a model we abandoned",
  );

  return { briefId: doc.id, doomedAcId: acIds[1]!, decisionId: decision.id };
}

/** The days strictly before today — the past this test is about. */
function past(series: AlignmentDay[]): AlignmentDay[] {
  const today = series[series.length - 1]?.date;
  return series.filter((d) => d.date !== today);
}

beforeAll(async () => {
  // A Memex of this file's own: `measured` is computed from min(day) across the
  // WHOLE tenant's rollup, so a row seeded by another suite would move the
  // boundary underneath these assertions [std-37].
  memexId = await makeTestMemex("hist566");
  const [row] = await db
    .select({ m: memexes.slug, n: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(memexes.id, memexId))
    .limit(1);
  memexSlug = row!.m;
  namespaceSlug = row!.n;
});

afterAll(async () => {
  await db.delete(specLifecycleEvents).where(eq(specLifecycleEvents.memexId, memexId)).catch(() => {});
  await db.delete(testRunDaily).where(eq(testRunDaily.memexId, memexId)).catch(() => {});
  if (createdRefs.length) {
    await db
      .delete(testEventLatest)
      .where(inArray(testEventLatest.subjectRef, createdRefs))
      .catch(() => {});
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdRefs)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
  const [row] = await db
    .select({ namespaceId: memexes.namespaceId })
    .from(memexes)
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (row) await db.delete(namespaces).where(eq(namespaces.id, row.namespaceId)).catch(() => {});
});

describe("spec-566 ac-12 — superseding a criterion changes today, never the past", () => {
  it("leaves every day before the supersession byte-identical", async () => {
    tagAc(acRef(12));
    // ac-2's "a Spec's coverage can go DOWN", over time rather than in a
    // snapshot: the counterpart assertion at the end of this case is that TODAY's
    // total really drops from 2 to 1. A Spec whose live set can only ever grow is
    // the structural incapacity ac-2 names.
    tagAc(acRef(2));

    const { briefId, doomedAcId, decisionId } = await seedTwoOfTwo();

    const before = await listAcAlignmentOverTime(memexId, briefId, 30);

    // ── Vacuity guards, before the claim ──
    // "byte-identical" is trivially true over a series of zeros, and it is true
    // for a Spec whose history the query could never see. Pin that the past this
    // test compares actually carries the number the supersession must not move.
    expect(before.length).toBeGreaterThan(0);
    const beforePast = past(before);
    const sample = beforePast.find(
      (d) => d.date === new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
    );
    expect(sample, "the series must cover three days ago").toBeDefined();
    expect(sample!.total, "three days ago the Spec stood at 2 committed criteria").toBe(2);
    expect(sample!.verified, "…and both were green, from the day-5 rollup").toBe(2);

    // ── The act, through the real verb ──
    const proposed = await proposeAcSupersession(
      { memexId, acId: doomedAcId, decisionId },
      { channel: "mcp" },
    );
    await acceptAcSupersession(memexId, proposed.comment.id, { channel: "rest_ui" });

    // The transition really happened — otherwise everything below compares a
    // series to itself.
    const doomed = await db.query.acs.findFirst({ where: eq(acs.id, doomedAcId) });
    expect(doomed!.status).toBe("superseded");

    const after = await listAcAlignmentOverTime(memexId, briefId, 30);

    // ── The claim ──
    // Every day before today reads exactly as it did. Compared as whole rows, so
    // a fix that preserved `total` while moving `verified` or `measured` fails
    // here too.
    expect(past(after)).toEqual(beforePast);

    // ── And the counterpart, so this is not satisfied by changing nothing ──
    // Today DOES move: the live set is smaller. That is dec-2's "a Spec's
    // coverage can go DOWN", and a fix that froze the whole series would pass
    // the assertion above while breaking the feature.
    const todayBefore = before[before.length - 1]!;
    const todayAfter = after[after.length - 1]!;
    expect(todayBefore.total).toBe(2);
    expect(todayAfter.total).toBe(1);
    expect(todayAfter.date).toBe(todayBefore.date);
  });

  it("keeps a Spec that has superseded nothing byte-identical to the old behaviour", async () => {
    tagAc(acRef(12));

    // The reconstruction must be inert where there is nothing to reconstruct.
    // Every Spec in production is this case today, so a regression here is a
    // regression everywhere.
    const { briefId } = await seedTwoOfTwo();

    const series = await listAcAlignmentOverTime(memexId, briefId, 30);

    const journal = await db
      .select()
      .from(specLifecycleEvents)
      .where(eq(specLifecycleEvents.memexId, memexId));
    const forThisBrief = journal.filter((r) => r.briefId === briefId);
    expect(forThisBrief, "this fixture supersedes nothing").toEqual([]);

    // Ten-day-old ACs, one green rollup day: 2 of 2 from the day they were
    // created, 0 of 0 before it.
    const todayRow = series[series.length - 1]!;
    expect(todayRow.total).toBe(2);
    expect(todayRow.verified).toBe(2);

    const beforeTheyExisted = series.find(
      (d) =>
        d.date ===
        new Date(Date.now() - (AC_AGE_DAYS + 5) * 86_400_000).toISOString().slice(0, 10),
    );
    expect(beforeTheyExisted!.total).toBe(0);
  });
});
