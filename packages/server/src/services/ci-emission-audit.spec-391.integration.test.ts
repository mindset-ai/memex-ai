// Integration + unit tests for the CI-emission audit (spec-391 t-4, ac-10).
//
// dec-4: a verified AC whose latest emission came from a laptop, not CI, is weak
// verification. CI-originated = the latest non-hidden emission has a non-null
// top-level run_id OR a run_id/run_url metadata key. The audit is read-only — it
// flags, it never blocks (the deploy block is dec-1/dec-3's untested/failing
// gate, not provenance).

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray, desc } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, acs, testEvents, testEventLatest, memexes, namespaces } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import {
  createAc,
  auditCiEmissionForBrief,
  emissionIsCiOriginated,
  listAcsForBriefWithVerification,
} from "./acs.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";

const SPEC391 = "mindset-prod/memex-building-itself/specs/spec-391";

const createdDocIds: string[] = [];
const createdAcUids: string[] = [];

afterAll(async () => {
  if (createdAcUids.length) {
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdAcUids)).catch(() => {});
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, createdAcUids)).catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;

beforeAll(async () => {
  memexId = await makeTestMemex("ciaud");
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

async function seedSpec(): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, "ci audit test", "purpose", "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle! };
}

function refOf(briefHandle: string, seq: number): string {
  return `${namespaceSlug}/${memexSlug}/specs/${briefHandle}/acs/ac-${seq}`;
}

/** Seed a passing emission (verifies the AC) then stamp CI provenance on the row. */
async function passAc(
  briefHandle: string,
  seq: number,
  provenance?: { runId?: string; metadata?: Record<string, string> },
): Promise<void> {
  const ref = refOf(briefHandle, seq);
  createdAcUids.push(ref);
  await seedTestEvent({ subjectRef: ref, status: "pass", createdAt: new Date(), testIdentifier: "t::ci" });
  if (provenance) {
    const [latest] = await db
      .select({ id: testEvents.id })
      .from(testEvents)
      .where(eq(testEvents.subjectRef, ref))
      .orderBy(desc(testEvents.createdAt))
      .limit(1);
    await db
      .update(testEvents)
      .set({ runId: provenance.runId ?? null, metadata: provenance.metadata ?? null })
      .where(eq(testEvents.id, latest.id));
  }
}

describe("emissionIsCiOriginated (spec-391 ac-10, pure)", () => {
  it("classifies a top-level run_id as CI-originated", () => {
    tagAc(`${SPEC391}/acs/ac-10`);
    expect(emissionIsCiOriginated({ runId: "1234567890", metadata: null })).toBe(true);
  });
  it("classifies a run_id/run_url metadata key as CI-originated", () => {
    tagAc(`${SPEC391}/acs/ac-10`);
    expect(emissionIsCiOriginated({ runId: null, metadata: { run_id: "987" } })).toBe(true);
    expect(emissionIsCiOriginated({ runId: null, metadata: { run_url: "https://gh/run/1" } })).toBe(true);
  });
  it("classifies a bare/laptop emission as local-only", () => {
    tagAc(`${SPEC391}/acs/ac-10`);
    expect(emissionIsCiOriginated({ runId: null, metadata: null })).toBe(false);
    expect(emissionIsCiOriginated({ runId: "  ", metadata: { commit: "abc", branch: "main" } })).toBe(false);
  });
});

describe("auditCiEmissionForBrief (spec-391 ac-10, integration)", () => {
  it("flags a verified AC whose latest emission has no CI provenance", async () => {
    // ac-10 (impl) + ac-4 (scope): the "stale = local-only" audit half of the
    // make-invisible-verification-visible outcome.
    tagAc(`${SPEC391}/acs/ac-10`);
    tagAc(`${SPEC391}/acs/ac-4`);
    const spec = await seedSpec();
    const ac = await createAc({ memexId, briefId: spec.id, kind: "implementation", statement: "local-only verified" });
    await passAc(spec.handle, ac.seq); // no provenance → laptop
    // Sanity: it really is verified.
    const rows = await listAcsForBriefWithVerification(memexId, spec.id);
    expect(rows.find((r) => r.ac.id === ac.id)!.verificationState).toBe("verified");

    const flagged = await auditCiEmissionForBrief(memexId, spec.id);
    expect(flagged.map((f) => f.handle)).toContain(`ac-${ac.seq}`);
  });

  it("does NOT flag a verified AC whose latest emission carries a run_id", async () => {
    tagAc(`${SPEC391}/acs/ac-10`);
    const spec = await seedSpec();
    const ac = await createAc({ memexId, briefId: spec.id, kind: "implementation", statement: "CI verified" });
    await passAc(spec.handle, ac.seq, { runId: "run-42" });
    const flagged = await auditCiEmissionForBrief(memexId, spec.id);
    expect(flagged.map((f) => f.handle)).not.toContain(`ac-${ac.seq}`);
  });

  it("ignores untested ACs (only verified ACs are audited)", async () => {
    tagAc(`${SPEC391}/acs/ac-10`);
    const spec = await seedSpec();
    await createAc({ memexId, briefId: spec.id, kind: "implementation", statement: "never emitted" });
    const flagged = await auditCiEmissionForBrief(memexId, spec.id);
    expect(flagged).toEqual([]);
  });
});
