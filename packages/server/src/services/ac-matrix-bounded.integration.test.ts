// spec-520 t-12 precondition — the AC tab's two full-history reads get an explicit bound
// before the retention trim that was silently providing one is deleted.
//
// WHAT NOBODY WROTE DOWN. `listTestMatrixForAc` and `listTestEventDigestForAc` both read
// EVERY test_events row for an AC with no LIMIT. That is survivable today only because
// spec-398's trim caps each (subject_ref, test_identifier) pair at RETENTION_KEEP=10 — so
// the matrix renders at most ten columns per row, not by any display decision but as a
// side effect of retention. t-12 deletes the trim. At ~2.68M emissions/day (spec-520 c-12)
// a three-day window leaves roughly an order of magnitude more rows per pair, and the AC
// tab would degrade on the day the migration ships, with nothing in that diff to explain
// it.
//
// THE TWO READS NEED DIFFERENT FIXES, and that is the point of this file.
//
//   • The MATRIX returns the emissions themselves, so it takes a per-pair cap — the bound
//     the trim was providing by accident, now stated as a display decision.
//
//   • The DIGEST returns no emissions at all. It reads every row to compute `count`,
//     documented as "Total emissions recorded (hidden + visible) — the audit depth", and
//     to find the latest non-hidden one. Putting a LIMIT on it would silently redefine a
//     displayed number as "the last N" — a quieter defect than the one being fixed. It
//     becomes an aggregate query instead, which also stops pulling every row into Node
//     just to call .length on them.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces, testEventLatest, testEvents } from "../db/schema.js";
import {
  MATRIX_EMISSIONS_PER_TEST,
  createAc,
  listTestEventDigestForAc,
  listTestMatrixForAc,
} from "./acs.js";
import { createDocDraft } from "./documents.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";

const AC_BOUND = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-41";

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

async function seedAc(statement: string): Promise<{ acId: string; ref: string }> {
  const doc = await createDocDraft(memexId, "matrix bound", "purpose", "spec");
  createdDocIds.push(doc.id);
  const ac = await createAc({
    memexId, briefId: doc.id, kind: "implementation", statement,
  });
  const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;
  createdRefs.push(ref);
  return { acId: ac.id, ref };
}

/** `n` emissions for one pair, oldest first, one minute apart. */
async function seedRun(
  ref: string,
  testIdentifier: string,
  n: number,
  status: "pass" | "fail" | "error" = "pass",
  opts: { hidden?: boolean } = {},
): Promise<void> {
  const base = Date.now() - n * 60_000;
  for (let i = 0; i < n; i++) {
    await seedTestEvent({
      subjectRef: ref,
      status,
      testIdentifier,
      createdAt: new Date(base + i * 60_000),
      ...(opts.hidden ? { hidden: true } : {}),
    });
  }
}

beforeAll(async () => {
  memexId = await makeTestMemex("t12m");
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
  if (createdRefs.length) {
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, createdRefs)).catch(() => {});
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdRefs)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

describe("spec-520 ac-41: the AC matrix carries its own bound", () => {
  it("caps emissions per test at the display bound and keeps the NEWEST", async () => {
    tagAc(AC_BOUND);
    const { acId, ref } = await seedAc("over the bound");
    const over = MATRIX_EMISSIONS_PER_TEST + 7;
    await seedRun(ref, "a::t", over);

    const rows = await listTestMatrixForAc(memexId, acId);
    const row = rows.find((r) => r.testIdentifier === "a::t")!;
    expect(row.emissions).toHaveLength(MATRIX_EMISSIONS_PER_TEST);
    // Newest-first, and the ones dropped are the oldest — a bound that kept the oldest
    // would show a stale column set that never changes as tests run.
    const times = row.emissions.map((e) => e.emittedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(Math.min(...times)).toBeGreaterThan(Date.now() - over * 60_000);
  });

  it("applies the bound PER TEST, not across the whole AC", async () => {
    tagAc(AC_BOUND);
    const { acId, ref } = await seedAc("two tests");
    await seedRun(ref, "a::t", MATRIX_EMISSIONS_PER_TEST + 3);
    await seedRun(ref, "b::t", MATRIX_EMISSIONS_PER_TEST + 3);

    const rows = await listTestMatrixForAc(memexId, acId);
    // A global LIMIT would starve whichever test sorted later — the matrix would lose an
    // entire row rather than trim a long one.
    expect(rows.find((r) => r.testIdentifier === "a::t")!.emissions).toHaveLength(MATRIX_EMISSIONS_PER_TEST);
    expect(rows.find((r) => r.testIdentifier === "b::t")!.emissions).toHaveLength(MATRIX_EMISSIONS_PER_TEST);
  });

  it("leaves a pair under the bound untouched", async () => {
    tagAc(AC_BOUND);
    const { acId, ref } = await seedAc("under the bound");
    await seedRun(ref, "a::t", 3);

    const rows = await listTestMatrixForAc(memexId, acId);
    expect(rows.find((r) => r.testIdentifier === "a::t")!.emissions).toHaveLength(3);
  });
});

describe("spec-520 ac-41: the digest counts everything, and reads nothing it does not need", () => {
  it("reports the TRUE total, not the matrix bound", async () => {
    tagAc(AC_BOUND);
    const { acId, ref } = await seedAc("audit depth");
    const total = MATRIX_EMISSIONS_PER_TEST + 11;
    await seedRun(ref, "a::t", total);

    const rows = await listTestEventDigestForAc(memexId, acId);
    // `count` is documented as the audit depth. A bound applied here would redefine a
    // displayed number as "the last N" — quieter than the defect being fixed, and worse.
    expect(rows.find((r) => r.testIdentifier === "a::t")!.count).toBe(total);
  });

  it("still reads the verdict off the newest non-hidden emission", async () => {
    tagAc(AC_BOUND);
    const { acId, ref } = await seedAc("verdict survives");
    await seedRun(ref, "a::t", MATRIX_EMISSIONS_PER_TEST + 5, "pass");
    // The newest one is red. If the digest ever loses sight of it, the AC stops being
    // pinned red while a test is failing — the worst direction for this to break in.
    await seedTestEvent({
      subjectRef: ref, status: "fail", testIdentifier: "a::t", createdAt: new Date(),
    });

    const row = (await listTestEventDigestForAc(memexId, acId)).find((r) => r.testIdentifier === "a::t")!;
    expect(row.latestStatus).toBe("fail");
    expect(row.pinning).toBe(true);
    expect(row.hidden).toBe(false);
  });

  it("reports a fully hidden pair as retired, with no verdict", async () => {
    tagAc(AC_BOUND);
    const { acId, ref } = await seedAc("fully hidden");
    await seedRun(ref, "h::t", 3, "pass", { hidden: true });

    const row = (await listTestEventDigestForAc(memexId, acId)).find((r) => r.testIdentifier === "h::t")!;
    expect(row.hidden).toBe(true);
    expect(row.latestStatus).toBeNull();
    expect(row.latestRunAt).toBeNull();
    // Hidden rows still count toward the audit depth — that is what "hidden + visible"
    // means, and it is how a retired pair stays visibly retired rather than vanishing.
    expect(row.count).toBe(3);
  });
});
