// Integration tests for the HARD spec-advancement gates (spec-391 t-2, t-3).
//
// spec-388 dec-2: the verify→done AC check becomes a TRUE BLOCK on any untested
// or failing active implementation AC, for every spec regardless of domain — a
// deliberate departure from spec-340's non-blocking posture. Enforced at the
// updateDocStatus seam (the single chokepoint every forward-move surface uses),
// never on code-work. dec-5 mirrors it: a build→verify block on any resolved
// decision with no implementation AC.
//
// DB-backed because the gate runs against the real acs columns + the
// test_event_latest join + the decisions/ac_parent_links coverage query — a
// unit test on the helper could pass while the wiring is broken. The gate is
// arranged by setting the spec's status directly (the gate only fires on the
// guarded transition, so arrangement uses a raw status write), then asserting
// the updateDocStatus call.
//
// Covers ac-5 (verify→done refuses on untested/failing; succeeds when clear;
// fires regardless of caller; not on other transitions), ac-6 (shared
// derivation; only implementation ACs gate), ac-9 (stale does not block; sign-off
// is the only escape), ac-11 (build→verify naked-decision block).

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  acs,
  decisions,
  acParentLinks,
  testEvents,
  testEventLatest,
  memexes,
  namespaces,
} from "../db/schema.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import { createAc, setAcReviewedVerification } from "./acs.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { ValidationError } from "../types/errors.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";

const SPEC391 = "mindset-prod/memex-building-itself/specs/spec-391";

const createdDocIds: string[] = [];
const createdAcUids: string[] = [];

afterAll(async () => {
  if (createdAcUids.length) {
    await db.delete(testEvents).where(inArray(testEvents.acUid, createdAcUids)).catch(() => {});
    await db.delete(testEventLatest).where(inArray(testEventLatest.acUid, createdAcUids)).catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;

beforeAll(async () => {
  memexId = await makeTestMemex("gate");
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

async function seedSpec(status: string): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, "advancement gate test", "purpose", "spec");
  createdDocIds.push(doc.id);
  // Arrange the spec at the pre-transition status directly — the gate only
  // fires on the guarded forward move, not on this setup write.
  await db.update(documents).set({ status }).where(eq(documents.id, doc.id));
  return { id: doc.id, handle: doc.handle! };
}

function refOf(briefHandle: string, seq: number): string {
  return `${namespaceSlug}/${memexSlug}/specs/${briefHandle}/acs/ac-${seq}`;
}

async function passAc(briefHandle: string, seq: number, daysAgo = 0): Promise<void> {
  const ref = refOf(briefHandle, seq);
  createdAcUids.push(ref);
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await seedTestEvent({ acUid: ref, status: "pass", createdAt: at, testIdentifier: "t::passes" });
}

describe("verify→done HARD AC gate (spec-391 dec-1/dec-3)", () => {
  it("refuses verify→done when an active implementation AC is untested", async () => {
    // ac-5 (impl) + ac-1 (scope): an untested active implementation AC blocks the
    // advancement — the manager-level hard-block outcome.
    tagAc(`${SPEC391}/acs/ac-5`);
    tagAc(`${SPEC391}/acs/ac-1`);
    const spec = await seedSpec("verify");
    await createAc({ memexId, briefId: spec.id, kind: "implementation", statement: "untested mechanism" });
    await expect(updateDocStatus(memexId, spec.id, "done")).rejects.toThrow(ValidationError);
    // The status did not change.
    const [row] = await db.select().from(documents).where(eq(documents.id, spec.id));
    expect(row.status).toBe("verify");
  });

  it("refuses verify→done when an active implementation AC is failing", async () => {
    tagAc(`${SPEC391}/acs/ac-5`);
    const spec = await seedSpec("verify");
    const ac = await createAc({ memexId, briefId: spec.id, kind: "implementation", statement: "failing mechanism" });
    const ref = refOf(spec.handle, ac.seq);
    createdAcUids.push(ref);
    await seedTestEvent({ acUid: ref, status: "fail", createdAt: new Date(), testIdentifier: "t::fails" });
    await expect(updateDocStatus(memexId, spec.id, "done")).rejects.toThrow(ValidationError);
  });

  it("allows verify→done when every active implementation AC is verified", async () => {
    // ac-5: the same call succeeds once the ACs are green.
    tagAc(`${SPEC391}/acs/ac-5`);
    const spec = await seedSpec("verify");
    const ac = await createAc({ memexId, briefId: spec.id, kind: "implementation", statement: "verified mechanism" });
    await passAc(spec.handle, ac.seq);
    await updateDocStatus(memexId, spec.id, "done");
    const [row] = await db.select().from(documents).where(eq(documents.id, spec.id));
    expect(row.status).toBe("done");
  });

  it("only implementation ACs gate — an untested SCOPE AC does not block done", async () => {
    // ac-6: scope ACs are outcomes, not mechanism proofs; they don't gate.
    tagAc(`${SPEC391}/acs/ac-6`);
    const spec = await seedSpec("verify");
    await createAc({ memexId, briefId: spec.id, kind: "scope", statement: "untested scope outcome" });
    await updateDocStatus(memexId, spec.id, "done");
    const [row] = await db.select().from(documents).where(eq(documents.id, spec.id));
    expect(row.status).toBe("done");
  });

  it("a reviewed-verification sign-off (accepted) satisfies the gate — the only escape", async () => {
    // ac-9: an untestable AC signed off passes; the spec-258 override is not in
    // play here — the sign-off is the sanctioned escape.
    tagAc(`${SPEC391}/acs/ac-9`);
    const spec = await seedSpec("verify");
    const ac = await createAc({ memexId, briefId: spec.id, kind: "implementation", statement: "config-only AC" });
    // Untested → would block.
    await expect(updateDocStatus(memexId, spec.id, "done")).rejects.toThrow(ValidationError);
    // Sign off with a reason → derives to `accepted` → satisfies the gate.
    await setAcReviewedVerification(memexId, ac.id, "Barrie", "Stripe dashboard config, no automated test possible");
    await updateDocStatus(memexId, spec.id, "done");
    const [row] = await db.select().from(documents).where(eq(documents.id, spec.id));
    expect(row.status).toBe("done");
  });

  it("a STALE active implementation AC does NOT block verify→done (dec-3)", async () => {
    // ac-9: stale = proof aged, not wrong. A recency clock is a poor hard gate.
    tagAc(`${SPEC391}/acs/ac-9`);
    const spec = await seedSpec("verify");
    const ac = await createAc({ memexId, briefId: spec.id, kind: "implementation", statement: "stale-but-passing" });
    await passAc(spec.handle, ac.seq, 30); // last pass 30 days ago → stale
    await updateDocStatus(memexId, spec.id, "done");
    const [row] = await db.select().from(documents).where(eq(documents.id, spec.id));
    expect(row.status).toBe("done");
  });

  it("does NOT fire on non-(verify→done) transitions — an untested AC allows build→verify when decisions are covered", async () => {
    // ac-5: the gate is scoped to verify→done only. (A spec with no resolved
    // decisions trivially clears the dec-5 naked-decision gate, so build→verify
    // is allowed even with an untested implementation AC.)
    tagAc(`${SPEC391}/acs/ac-5`);
    const spec = await seedSpec("build");
    await createAc({ memexId, briefId: spec.id, kind: "implementation", statement: "untested but build→verify" });
    await updateDocStatus(memexId, spec.id, "verify");
    const [row] = await db.select().from(documents).where(eq(documents.id, spec.id));
    expect(row.status).toBe("verify");
  });
});

describe("build→verify naked-decision HARD gate (spec-391 dec-5)", () => {
  async function nakedDecisionSpec(): Promise<{ id: string; handle: string }> {
    const spec = await seedSpec("build");
    const dec = await createDecision(memexId, spec.id, "a fork with no AC", "context");
    await resolveDecision(memexId, dec.id, "chose option A");
    return spec;
  }

  it("refuses build→verify when a resolved decision has zero implementation ACs", async () => {
    // ac-11 (impl) + ac-3 (scope): the naked-decision build→verify block outcome.
    tagAc(`${SPEC391}/acs/ac-11`);
    tagAc(`${SPEC391}/acs/ac-3`);
    const spec = await nakedDecisionSpec();
    await expect(updateDocStatus(memexId, spec.id, "verify")).rejects.toThrow(ValidationError);
    const [row] = await db.select().from(documents).where(eq(documents.id, spec.id));
    expect(row.status).toBe("build");
  });

  it("allows build→verify once each resolved decision has ≥1 active implementation AC", async () => {
    // ac-11.
    tagAc(`${SPEC391}/acs/ac-11`);
    const spec = await seedSpec("build");
    const dec = await createDecision(memexId, spec.id, "a fork that gets an AC", "context");
    await resolveDecision(memexId, dec.id, "chose option B");
    // Author an implementation AC parented to the decision.
    const ac = await createAc({ memexId, briefId: spec.id, kind: "implementation", statement: "covers the decision" });
    await db.insert(acParentLinks).values({ acId: ac.id, parentKind: "decision", parentId: dec.id });
    await updateDocStatus(memexId, spec.id, "verify");
    const [row] = await db.select().from(documents).where(eq(documents.id, spec.id));
    expect(row.status).toBe("verify");
  });
});
