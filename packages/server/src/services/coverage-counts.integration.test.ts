// spec-566 t-5 — the number behind the badge, end to end.
//
//   ac-13  the live percentage excludes superseded criteria from numerator and
//          denominator; the Spec at 10 verified of 11 with one superseded reads
//          100% with a superseded count of 1.
//
// The pure formatter is asserted in agent/ac-coverage-counts.spec-566.test.ts and
// the nine render seats in packages/ui. This file closes the gap between them:
// the COUNT those seats render comes from `aggregateAcHealthForBriefs` and
// `specLifecycleSummary`, and a formatter that is right about rows it is handed
// proves nothing about rows it is never handed.
//
// The superseded row is produced by the REAL verb — propose then accept (t-2) —
// not by writing `status = 'superseded'` into the table. A test that stamps the
// status by hand would still pass if accepting a supersession left the row
// active, which is the one thing that would make every count on every surface
// wrong in the same direction.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces, testEventLatest, testEvents } from "../db/schema.js";
import { aggregateAcHealthForBriefs, createAc } from "./acs.js";
import { acceptAcSupersession, proposeAcSupersession } from "./ac-supersession.js";
import { createDecision } from "./decisions.js";
import { createDocDraft } from "./documents.js";
import { specLifecycleSummary } from "./analytics.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

/**
 * The Spec's own worked example: 11 criteria, each with a passing test, then one
 * of them retired through the supersession verb. Leaves 10 live and verified.
 */
async function seedTenOfEleven(): Promise<{ briefId: string }> {
  const doc = await createDocDraft(memexId, "coverage counts fixture", "purpose", "spec");
  createdDocIds.push(doc.id);

  const acIds: string[] = [];
  for (let i = 1; i <= 11; i++) {
    const ac = await createAc({
      memexId,
      briefId: doc.id,
      kind: "implementation",
      statement: `Criterion ${i} holds.`,
    });
    acIds.push(ac.id);
    const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;
    createdRefs.push(ref);
    // Every criterion carries a PASSING test, so `covered` and `verified` are
    // both 10 out of 10 afterwards. ac-13's "100%" has two readings in this
    // codebase (has-a-test vs verdict-is-verified) and the claim has to hold
    // under both, or half the surfaces would report it for the wrong reason.
    await seedTestEvent({
      subjectRef: ref,
      status: "pass",
      testIdentifier: `packages/server/src/fixture.test.ts::criterion ${i}`,
    });
  }

  const decision = await createDecision(
    memexId,
    doc.id,
    "The eleventh criterion was written against a model we abandoned",
  );
  const proposed = await proposeAcSupersession(
    { memexId, acId: acIds[10]!, decisionId: decision.id },
    { channel: "mcp" },
  );
  await acceptAcSupersession(memexId, proposed.comment.id, { channel: "rest_ui" });

  return { briefId: doc.id };
}

beforeAll(async () => {
  memexId = await makeTestMemex("cnt566");
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

describe("spec-566 ac-13 — the card aggregate counts 10 live and 1 retired", () => {
  it("reports totalActive 10, verified 10 and superseded 1 — never a total of 11", async () => {
    tagAc(acRef(13));
    // ── SCOPE AC ──
    //
    // ac-2: "A Spec's coverage can go DOWN. Superseding a criterion visibly
    // reduces the live set rather than hiding it, so '10 of 10, one superseded'
    // is expressible and a Spec is no longer structurally incapable of showing
    // less than 100%." This case IS that worked example, read back from the
    // aggregate every card percentage divides by: the live set shrank from 11 to
    // 10, and the criterion that left is counted rather than hidden.
    //
    // The "can go DOWN" half is also proven over TIME in
    // alignment-history-honesty.spec-566, where today's total drops from 2 to 1
    // while the past holds — tagged there too rather than claimed here.
    tagAc(acRef(2));

    const { briefId } = await seedTenOfEleven();

    const health = (await aggregateAcHealthForBriefs(memexId, [briefId])).get(briefId);

    expect(health).toBeDefined();
    // The denominator every card percentage divides by.
    expect(health!.totalActive).toBe(10);
    expect(health!.verified).toBe(10);
    expect(health!.covered).toBe(10);
    // The count beside it — the whole point of dec-2.
    expect(health!.superseded).toBe(1);
    // The retired criterion is in NEITHER half of the maths. Stated explicitly
    // because "excluded from the denominator" and "silently dropped" produce the
    // same totalActive and differ only here.
    expect(health!.totalActive + health!.superseded).toBe(11);
    expect(health!.untested).toBe(0);
    expect(health!.failing).toBe(0);
  });

  it("reports the same 10-and-1 on the lifecycle summary the Stats strip reads", async () => {
    tagAc(acRef(13));

    const { briefId } = await seedTenOfEleven();

    const summary = await specLifecycleSummary(memexId, briefId);

    expect(summary).not.toBeNull();
    expect(summary!.acs.total).toBe(10);
    expect(summary!.acs.verified).toBe(10);
    expect(summary!.acs.superseded).toBe(1);
    // 10/10 → 100%. The arithmetic the strip performs, done here so the claim is
    // about the number and not about a percentage string.
    expect(Math.round((summary!.acs.verified / summary!.acs.total) * 100)).toBe(100);
  });

  it("still reports the retirement when EVERY criterion was superseded", async () => {
    tagAc(acRef(13));

    const doc = await createDocDraft(memexId, "all retired fixture", "purpose", "spec");
    createdDocIds.push(doc.id);
    const ac = await createAc({
      memexId,
      briefId: doc.id,
      kind: "implementation",
      statement: "The only criterion this Spec ever committed to.",
    });
    const decision = await createDecision(memexId, doc.id, "We changed our minds entirely");
    const proposed = await proposeAcSupersession(
      { memexId, acId: ac.id, decisionId: decision.id },
      { channel: "mcp" },
    );
    await acceptAcSupersession(memexId, proposed.comment.id, { channel: "rest_ui" });

    const health = (await aggregateAcHealthForBriefs(memexId, [doc.id])).get(doc.id);

    // The aggregate returns early when it finds no ACTIVE ACs. If the superseded
    // tally ran after that early return, this Spec would report zero everything
    // and read exactly like a Spec that never wrote a criterion — the badge this
    // whole Spec exists to make falsifiable.
    expect(health!.totalActive).toBe(0);
    expect(health!.superseded).toBe(1);
  });
});
