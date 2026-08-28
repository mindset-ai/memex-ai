// spec-520 dec-8 option A / ac-38 — the CI-origin audit reads provenance from the summary,
// and knows the difference between "not CI" and "we don't know".
//
// WHAT THE AUDIT IS FOR. auditCiEmissionForBrief answers "which of your GREEN criteria were
// last verified by something other than CI". Its output reaches phase-assessment's
// localOnlyHandles and from there the assess_spec MCP tool, which every agent is instructed
// to call before every forward phase move. It renders as: "'Verified' here rests on a
// local-only run the deploy signal can't trust."
//
// TWO OPPOSITE WAYS TO GET THIS WRONG, and this file pins both:
//
//   FALSE NEGATIVE — reading the RAW log. The row is the latest emission of an ALREADY
//   verified AC, so it can be arbitrarily old. Once t-12 shortens retention it ages out,
//   `if (!latest) continue` fires, and the audit says "all clear" for an AC it can no longer
//   see. Worse than no audit, at a phase decision.
//
//   FALSE POSITIVE — reading the summary naively. Rows predating migration 0137 have NULL
//   provenance, and emissionIsCiOriginated({null, null}) returns FALSE, so every pre-existing
//   AC would be reported as laptop-verified.
//
// The discriminator is that the writer stores `{}` and not null when an emission carries no
// metadata. NULL therefore means only "predates 0137" → UNKNOWN → skip.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db, runWithMemexId } from "../db/connection.js";
import { acs, documents, memexes, namespaces, testEventLatest } from "../db/schema.js";
import { auditCiEmissionForBrief } from "./acs.js";
import { createDocDraft } from "./documents.js";
import { seedTestEvent } from "./test-helpers.js";
import { makeTestMemex } from "./test-helpers.js";

const AC_PROVENANCE = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-38";

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

/** A Spec with one active AC, verified by one passing emission. Returns its docId + ref. */
async function specWithVerifiedAc(
  label: string,
  seq: number,
): Promise<{ docId: string; ref: string }> {
  return runWithMemexId(memexId, async () => {
    const doc = await createDocDraft(memexId, `dec8 ${label}`, "", "spec");
    createdDocIds.push(doc.id);
    await db.insert(acs).values({
      memexId,
      briefId: doc.id,
      seq,
      kind: "implementation",
      statement: "the criterion under audit",
      status: "active",
    } as typeof acs.$inferInsert);
    const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${seq}`;
    createdRefs.push(ref);
    return { docId: doc.id, ref };
  });
}

beforeAll(async () => {
  memexId = await makeTestMemex("d8");
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
  if (createdRefs.length) {
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, createdRefs)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

describe("spec-520 ac-38: CI provenance comes from the summary", () => {
  it("flags a verified AC whose latest emission carries NO CI marker", async () => {
    tagAc(AC_PROVENANCE);
    const { docId, ref } = await specWithVerifiedAc("local", 1);
    await seedTestEvent({ subjectRef: ref, status: "pass", testIdentifier: "s::t" });

    // A laptop run: the writer stored `{}`, so provenance WAS observed and is genuinely
    // absent — which is the one case that should be reported.
    const flagged = await runWithMemexId(memexId, async () =>
      auditCiEmissionForBrief(memexId, docId),
    );
    expect(flagged.map((r) => r.handle)).toContain("ac-1");
  });

  it("does NOT flag one whose latest emission carries a run id", async () => {
    tagAc(AC_PROVENANCE);
    const { docId, ref } = await specWithVerifiedAc("ci", 1);
    await seedTestEvent({ subjectRef: ref, status: "pass", testIdentifier: "s::t" });

    await db
      .update(testEventLatest)
      .set({ latestRunId: "31589392781" })
      .where(eq(testEventLatest.subjectRef, ref));

    const flagged = await runWithMemexId(memexId, async () =>
      auditCiEmissionForBrief(memexId, docId),
    );
    expect(flagged.map((r) => r.handle)).not.toContain("ac-1");
  });

  it("does NOT flag one whose run id rides in metadata instead", async () => {
    tagAc(AC_PROVENANCE);
    const { docId, ref } = await specWithVerifiedAc("ci-md", 1);
    await seedTestEvent({ subjectRef: ref, status: "pass", testIdentifier: "s::t" });

    // emissionIsCiOriginated accepts run_id OR run_url inside the bag — the shape a
    // hand-rolled emitter produces. Re-deriving from the raw inputs is why dec-8 stored them
    // rather than a computed boolean.
    await db
      .update(testEventLatest)
      .set({ latestMetadata: { run_url: "https://ci.example/run/7" } })
      .where(eq(testEventLatest.subjectRef, ref));

    const flagged = await runWithMemexId(memexId, async () =>
      auditCiEmissionForBrief(memexId, docId),
    );
    expect(flagged.map((r) => r.handle)).not.toContain("ac-1");
  });

  it("treats a row with NO RECORDED PROVENANCE as unknown and does NOT flag it", async () => {
    tagAc(AC_PROVENANCE);
    const { docId, ref } = await specWithVerifiedAc("pre-0137", 1);
    await seedTestEvent({ subjectRef: ref, status: "pass", testIdentifier: "s::t" });

    // Reproduce a row written BEFORE 0137: provenance never recorded, both columns NULL.
    // Judged naively this reads as "not CI" and the AC is reported laptop-verified — the
    // false positive that mirrors the false negative the raw-log read produced.
    await db
      .update(testEventLatest)
      .set({ latestRunId: null, latestMetadata: null })
      .where(eq(testEventLatest.subjectRef, ref));

    const flagged = await runWithMemexId(memexId, async () =>
      auditCiEmissionForBrief(memexId, docId),
    );
    expect(flagged.map((r) => r.handle)).not.toContain("ac-1");
  });

  it("answers without the raw log — the row t-12's retention window will delete", async () => {
    tagAc(AC_PROVENANCE);
    const { docId, ref } = await specWithVerifiedAc("no-raw", 1);
    await seedTestEvent({ subjectRef: ref, status: "pass", testIdentifier: "s::t" });

    // THE point of dec-8. Delete every raw row and the audit must still answer, because it
    // is reading the summary. Before this change it returned nothing here — silently.
    await db.execute(sql`DELETE FROM test_events WHERE subject_ref = ${ref}`);

    const flagged = await runWithMemexId(memexId, async () =>
      auditCiEmissionForBrief(memexId, docId),
    );
    expect(flagged.map((r) => r.handle)).toContain("ac-1");
  });
});
