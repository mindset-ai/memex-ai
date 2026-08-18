// spec-520 t-2 / ac-10 — the AC-health parity harness, built BEFORE the query changes.
//
// WHAT THIS IS. A characterization test: it pins what `aggregateAcHealthForBriefs`
// returns TODAY so t-4's rewrite cannot silently change it. ac-10's words are "for
// identical Memex state, the payload returned by the rewritten aggregate is EQUAL to the
// payload the pre-change implementation returned — same buckets, same counts, same derived
// verification state per Spec." A harness written after the rewrite proves nothing; the
// pre-change behaviour is gone by then.
//
// WHY IT ASSERTS THE WHOLE OBJECT WITH toEqual, and never cherry-picks fields.
// `AcHealth` is declared THREE times in this repo and the declarations DISAGREE:
//
//   services/acs.ts:985   7 fields — includes `accepted`   <- what the function returns
//   types/index.ts:134    6 fields — no `accepted`          <- the DocSummary field type
//   ui/src/api/types.ts   6 fields — no `accepted`          <- what the UI consumes
//
// So a rewrite that dropped `accepted` would still typecheck against two of the three
// declarations, and a field-by-field assertion written from the wrong one would stay
// green. `toEqual` on the full payload is the only form that catches it. (The divergence
// itself is drift worth fixing, but not here — t-2 pins behaviour, it does not refactor
// types.)
//
// THE BUCKETS, and the precedence a rewrite is most likely to get subtly wrong
// (`deriveVerificationState`): failing > accepted > untested > stale > verified. Failing
// evidence suppresses a manual acceptance; an acceptance presents over stale AND verified.
// Each of those five is seeded below, plus the two "counted but not a state" fields —
// `totalActive` (every active AC) and `covered` (≥1 tagged event, whatever its status).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  acs,
  documents,
  memexes,
  namespaces,
  testEventLatest,
  users,
} from "../db/schema.js";
import { createOrgWithMemexAndOwner } from "./__test__/seed-org.js";
import { createDocDraft } from "./documents.js";
import {
  aggregateAcHealthForBriefs,
  buildAcRef,
  STALE_THRESHOLD_DAYS,
} from "./acs.js";

const AC_PARITY = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-10";

// [per std-37] cl-1: unique per worker AND per call.
const runId = `${process.env.VITEST_POOL_ID ?? "0"}-${crypto.randomUUID().slice(0, 8)}`;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Comfortably past the threshold, so a clock skew of hours cannot flip the bucket. */
const STALE_AGO = new Date(Date.now() - (STALE_THRESHOLD_DAYS + 3) * DAY_MS);
const FRESH_AGO = new Date(Date.now() - 1 * DAY_MS);

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdRefs: string[] = [];

let memexId: string;
let otherMemexId: string;
let richDocId: string;
let emptyDocId: string;
let otherDocId: string;

/** Seed an AC and return its canonical ref. */
async function seedAc(
  targetMemexId: string,
  briefId: string,
  slugs: { namespace: string; memex: string; briefHandle: string },
  seq: number,
  opts: { acceptedAt?: Date | null; status?: string } = {},
): Promise<string> {
  await db.insert(acs).values({
    memexId: targetMemexId,
    briefId,
    seq,
    kind: "implementation",
    statement: `ac ${seq}`,
    status: opts.status ?? "active",
    acceptedAt: opts.acceptedAt ?? null,
  } as typeof acs.$inferInsert);
  const ref = buildAcRef(slugs, seq);
  createdRefs.push(ref);
  return ref;
}

/** Seed a latest-event row. `memexIdOverride` exists for the disagreement case below. */
async function seedLatest(
  ref: string,
  status: "pass" | "fail" | "error",
  runAt: Date,
  ownerMemexId: string,
  testIdentifier = "t",
): Promise<void> {
  await db.insert(testEventLatest).values({
    subjectRef: ref,
    testIdentifier,
    latestStatus: status,
    latestRunAt: runAt,
    runCount: 1,
    memexId: ownerMemexId,
  } as typeof testEventLatest.$inferInsert);
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      email: `spec520-parity-${runId}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(u.id);

  const main = await createOrgWithMemexAndOwner({
    slug: `s520-parity-a-${runId}`,
    ownerUserId: u.id,
  });
  memexId = main.memex.id;
  createdMemexIds.push(memexId);

  const other = await createOrgWithMemexAndOwner({
    slug: `s520-parity-b-${runId}`,
    ownerUserId: u.id,
  });
  otherMemexId = other.memex.id;
  createdMemexIds.push(otherMemexId);

  // ── The rich Spec: one AC per bucket, plus the precedence cases ──────────────
  const rich = await createDocDraft(memexId, `parity rich ${runId}`, "", "spec");
  richDocId = rich.id;
  const richSlugs = {
    namespace: main.namespace.slug,
    memex: main.memex.slug,
    briefHandle: rich.handle,
  };

  // 1 — verified: passing, recent.
  await seedLatest(await seedAc(memexId, richDocId, richSlugs, 1), "pass", FRESH_AGO, memexId);
  // 2 — failing: one failing test.
  await seedLatest(await seedAc(memexId, richDocId, richSlugs, 2), "fail", FRESH_AGO, memexId);
  // 3 — stale: passing, but older than the threshold.
  await seedLatest(await seedAc(memexId, richDocId, richSlugs, 3), "pass", STALE_AGO, memexId);
  // 4 — untested: active, no events at all.
  await seedAc(memexId, richDocId, richSlugs, 4);
  // 5 — accepted: manual acceptance, no contradicting evidence. Deliberately given a
  //     STALE passing test, to pin that acceptance presents OVER stale (spec-188 dec-2).
  await seedLatest(
    await seedAc(memexId, richDocId, richSlugs, 5, { acceptedAt: new Date() }),
    "pass",
    STALE_AGO,
    memexId,
  );
  // 6 — accepted BUT failing: evidence wins, so this must land in `failing`, not
  //     `accepted`. The single assertion most likely to break under a rewrite that
  //     reorders the precedence chain.
  await seedLatest(
    await seedAc(memexId, richDocId, richSlugs, 6, { acceptedAt: new Date() }),
    "error",
    FRESH_AGO,
    memexId,
  );
  // 7 — NOT active: must be invisible to every counter, including totalActive.
  //     Valid statuses are proposed | active | rejected | superseded (acs_status_valid);
  //     `superseded` is the retired-equivalent the aggregator's status filter excludes.
  await seedAc(memexId, richDocId, richSlugs, 7, { status: "superseded" });

  // ── A Spec with no ACs at all: must come back as the empty payload, PRESENT in the
  //    map rather than absent — callers iterate the input list and expect a value.
  const empty = await createDocDraft(memexId, `parity empty ${runId}`, "", "spec");
  emptyDocId = empty.id;

  // ── A second tenant, carrying its own Spec + ACs + events. Today Q2 filters on
  //    subject_ref alone; t-4 adds a memex_id predicate. This is what proves the new
  //    predicate does not change the answer for the tenant under test.
  const otherDoc = await createDocDraft(otherMemexId, `parity other ${runId}`, "", "spec");
  otherDocId = otherDoc.id;
  const otherSlugs = {
    namespace: other.namespace.slug,
    memex: other.memex.slug,
    briefHandle: otherDoc.handle,
  };
  await seedLatest(
    await seedAc(otherMemexId, otherDocId, otherSlugs, 1),
    "pass",
    FRESH_AGO,
    otherMemexId,
  );
});

afterAll(async () => {
  if (createdRefs.length) {
    await db
      .delete(testEventLatest)
      .where(inArray(testEventLatest.subjectRef, createdRefs))
      .catch(() => {});
  }
  for (const id of [richDocId, emptyDocId, otherDocId].filter(Boolean)) {
    await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
  if (createdMemexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
    await db
      .delete(namespaces)
      .where(inArray(namespaces.slug, [`s520-parity-a-${runId}`, `s520-parity-b-${runId}`]))
      .catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

describe("spec-520 ac-10: the AC-health payload, pinned bucket by bucket", () => {
  it("returns the exact payload for a Spec exercising every bucket", async () => {
    tagAc(AC_PARITY);
    const health = await aggregateAcHealthForBriefs(memexId, [richDocId]);

    // toEqual on the WHOLE object, deliberately. A rewrite that drops `accepted` — a
    // field two of this repo's three AcHealth declarations do not even have — fails here
    // and nowhere else.
    expect(health.get(richDocId)).toEqual({
      totalActive: 6, // seq 1..6; the retired seq 7 is invisible
      covered: 5, // 1,2,3,5,6 have events; 4 has none
      verified: 1, // seq 1
      failing: 2, // seq 2, and seq 6 where evidence beats the acceptance
      stale: 1, // seq 3
      untested: 1, // seq 4
      accepted: 1, // seq 5 — presents over its own stale passing test
    });
  });

  it("a Spec with no active ACs is PRESENT in the map with the empty payload", async () => {
    tagAc(AC_PARITY);
    const health = await aggregateAcHealthForBriefs(memexId, [emptyDocId]);
    // Absence and zero mean different things to the caller: the board omits the pill for
    // a Spec with no commitments, and it can only do that if the key exists.
    expect(health.has(emptyDocId)).toBe(true);
    expect(health.get(emptyDocId)).toEqual({
      totalActive: 0,
      covered: 0,
      verified: 0,
      failing: 0,
      stale: 0,
      untested: 0,
      accepted: 0,
    });
  });

  it("an empty Spec-id list returns an empty map without querying", async () => {
    tagAc(AC_PARITY);
    expect((await aggregateAcHealthForBriefs(memexId, [])).size).toBe(0);
  });
});

describe("spec-520 ac-10: tenancy — the parity risk t-4 actually introduces", () => {
  it("another tenant's Specs and events do not affect this tenant's payload", async () => {
    tagAc(AC_PARITY);
    // Today Q2 reads test_event_latest filtered by subject_ref ALONE — no memex_id.
    // t-4 adds `memex_id = ?`. Since subject_ref embeds the namespace and memex slugs it
    // is globally unique in practice, so both forms should agree. This pins that they do.
    const health = await aggregateAcHealthForBriefs(memexId, [richDocId, otherDocId]);

    // The foreign Spec is seeded EMPTY rather than omitted: the aggregate seeds every
    // requested id up-front, and Q1's `acs.memexId = memexId` predicate is what keeps the
    // foreign AC out. A rewrite that moved tenancy enforcement into Q2 only would leak it.
    expect(health.get(otherDocId)).toEqual({
      totalActive: 0,
      covered: 0,
      verified: 0,
      failing: 0,
      stale: 0,
      untested: 0,
      accepted: 0,
    });
    // …and asking as the OTHER tenant must not surface this one's Spec either.
    const reverse = await aggregateAcHealthForBriefs(otherMemexId, [richDocId, otherDocId]);
    expect(reverse.get(richDocId)?.totalActive).toBe(0);
    expect(reverse.get(otherDocId)?.totalActive).toBe(1);
  });
});
