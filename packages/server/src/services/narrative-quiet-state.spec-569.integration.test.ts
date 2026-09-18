// spec-569 t-3 — the quiet state, and the proof that these guards are not vacuous.
//
// ac-6 / ac-7 assert an ABSENCE: the routine writes that stamp `acs.updatedAt`
// must NOT move the narrative-staleness verdict. That shape cannot be written
// red-first — before t-2 landed, `acs` was queried by neither surface, so
// "nothing flags" passed while proving only that nobody was looking.
//
// Their integrity is therefore established by MUTATION, not by ordering:
// relax `MEANING_CHANGED_STATUSES` in @memex/shared from ['superseded',
// 'rejected'] to include 'active', rebuild, and every test in this file must go
// red. A guard that survives that relaxation cannot express its claim — fix the
// test, not the predicate. See t-3's task notes for the recorded run.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { acs, documents, decisions } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import {
  createAc,
  updateAc,
  setAcAcceptance,
  clearAcAcceptance,
} from "./acs.js";
import { markNarrativeConsolidated } from "./narrative.js";
import { computeReadinessForSpec } from "./phase-assessment.js";
import { makeTestMemex } from "./test-helpers.js";

const AC_6 = "mindset-prod/memex-building-itself/specs/spec-569/acs/ac-6";
const AC_7 = "mindset-prod/memex-building-itself/specs/spec-569/acs/ac-7";

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex();
});

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

/** A consolidated Spec carrying one live criterion, with nothing else moved. */
async function seedConsolidatedSpecWithAc(title: string) {
  const spec = await createDocDraft(memexId, title, "Purpose", "spec");
  createdDocIds.push(spec.id);
  const ac = await createAc({
    memexId,
    briefId: spec.id,
    kind: "implementation",
    statement: "The exporter reconciles to the ledger.",
  });
  await markNarrativeConsolidated(memexId, spec.id);
  // Strictly after the anchor, so a later write is unambiguously "since then".
  await new Promise((r) => setTimeout(r, 5));
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, spec.id),
  });
  return { specId: spec.id, acId: ac.id, anchor: doc!.narrativeLastConsolidatedAt! };
}

/**
 * The staleness verdict as the human surfaces see it: the `stale_narrative`
 * readiness item, computed from real rows through the same shared predicate the
 * Spec-page badge reads.
 */
async function staleNarrativeItem(specId: string) {
  const readiness = await computeReadinessForSpec(memexId, specId, "build");
  return readiness.outstandingItems.find((i) => i.kind === "stale_narrative");
}

/** Vacuity guard: the write must really have moved the row past the anchor. */
async function assertRowMovedPast(acId: string, anchor: Date) {
  const row = await db.query.acs.findFirst({ where: eq(acs.id, acId) });
  expect(row!.updatedAt.getTime()).toBeGreaterThan(anchor.getTime());
  return row!;
}

describe("spec-569 — routine AC writes leave the narrative verdict alone", () => {
  it("recording a manual verification acceptance does not flag the narrative", async () => {
    tagAc(AC_6);
    const { specId, acId, anchor } = await seedConsolidatedSpecWithAc("Accept only");

    await setAcAcceptance(memexId, acId, "a reviewer", { channel: "rest_ui" });

    const row = await assertRowMovedPast(acId, anchor);
    expect(row.status).toBe("active");
    expect(row.acceptedAt).not.toBeNull();

    expect(await staleNarrativeItem(specId)).toBeUndefined();
  });

  it("revoking a manual verification acceptance does not flag the narrative", async () => {
    tagAc(AC_6);
    const { specId, acId, anchor } = await seedConsolidatedSpecWithAc("Unaccept");

    await setAcAcceptance(memexId, acId, "a reviewer", { channel: "rest_ui" });
    await clearAcAcceptance(memexId, acId, { channel: "rest_ui" });

    const row = await assertRowMovedPast(acId, anchor);
    expect(row.status).toBe("active");
    expect(row.acceptedAt).toBeNull();

    expect(await staleNarrativeItem(specId)).toBeUndefined();
  });

  it("rewriting a criterion's statement does not flag the narrative", async () => {
    tagAc(AC_7);
    const { specId, acId, anchor } = await seedConsolidatedSpecWithAc("Reword");

    // dec-1 excludes `update_ac` deliberately: it DOES invalidate prose, but it
    // is indistinguishable at the column level from the acceptance writes above
    // — both end at status 'active' with updatedAt bumped. Separating them
    // needs a new column and a hand migration, which is its own Spec. This test
    // pins the exclusion so a later reader finds it chosen, not forgotten.
    await updateAc(memexId, acId, "The exporter reconciles to the LEDGER TOTAL.", {
      channel: "mcp",
    });

    const row = await assertRowMovedPast(acId, anchor);
    expect(row.status).toBe("active");
    expect(row.statement).toMatch(/LEDGER TOTAL/);

    expect(await staleNarrativeItem(specId)).toBeUndefined();
  });
});
