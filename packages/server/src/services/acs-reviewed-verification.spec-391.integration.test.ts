// Integration tests for the reviewed-verification AC class (spec-391 t-1).
//
// dec-2: the hard verify→done AC gate's escape hatch — a named, dated, REASONED
// human sign-off for config/prose/Dashboard ACs that cannot carry an automated
// test. Modelled as an EXTENSION of spec-188's manual acceptance: it sets
// accepted_by + accepted_at (so the AC derives to the `accepted` state and
// satisfies the gate) AND a reviewed_reason explaining why the AC can't be
// tested. Evidence still wins — a failing test suppresses it.
//
// DB-backed for the same reason as acs-acceptance.integration.test.ts: the
// production path runs the columns + the test_event_latest join, and a pure
// unit test on deriveVerificationState could pass while the wiring is broken.
//
// Covers ac-7 (the 0108 migration / reviewed_reason column) and ac-8 (the
// sign-off service: sets all three columns, threads RequestCtx for std-32, and
// derives to `accepted`, with evidence-wins suppression intact).

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
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
  setAcReviewedVerification,
  clearAcAcceptance,
  listAcsForBriefWithVerification,
} from "./acs.js";
import { ValidationError } from "../types/errors.js";
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
  memexId = await makeTestMemex("rvf");
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

async function seedBrief(): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, "reviewed-verification test", "purpose", "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle! };
}

function refOf(briefHandle: string, seq: number): string {
  return `${namespaceSlug}/${memexSlug}/specs/${briefHandle}/acs/ac-${seq}`;
}

async function stateOf(briefId: string, acId: string) {
  const rows = await listAcsForBriefWithVerification(memexId, briefId);
  const found = rows.find((r) => r.ac.id === acId);
  expect(found).toBeDefined();
  return found!;
}

describe("reviewed-verification AC class — migration + column (spec-391 ac-7)", () => {
  it("acs carries a reviewed_reason text column (the 0108 migration applied)", async () => {
    // ac-7: the migration added a nullable reviewed_reason column to acs.
    // Introspect information_schema so the test asserts the SHAPE the migration
    // produced, not just that an ORM write happens to work.
    tagAc(`${SPEC391}/acs/ac-7`);
    const rows = (await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'acs' AND column_name = 'reviewed_reason'
    `)) as unknown as Array<{ column_name: string; data_type: string; is_nullable: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("YES");
  });

  it("a fresh AC has a null reviewed_reason (no backfill / additive)", async () => {
    tagAc(`${SPEC391}/acs/ac-7`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "fresh AC has no reason",
    });
    const [row] = await db.select().from(acs).where(eq(acs.id, ac.id));
    expect(row.reviewedReason).toBeNull();
  });
});

describe("reviewed-verification sign-off service (spec-391 ac-8)", () => {
  it("sets accepted_by + accepted_at + reviewed_reason together and derives to 'accepted'", async () => {
    // ac-8 (impl) + ac-2 (scope): the reviewed-verification class — a named,
    // dated, reasoned sign-off that satisfies the gate.
    tagAc(`${SPEC391}/acs/ac-8`);
    tagAc(`${SPEC391}/acs/ac-2`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "Stripe live-mode keys are configured in the dashboard",
    });

    const before = Date.now();
    await setAcReviewedVerification(
      memexId,
      ac.id,
      "Barrie Hadfield",
      "config-only AC: Stripe dashboard settings cannot be exercised by an automated test",
    );

    const [row] = await db.select().from(acs).where(eq(acs.id, ac.id));
    expect(row.acceptedBy).toBe("Barrie Hadfield");
    expect(row.acceptedAt).not.toBeNull();
    expect(row.acceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.reviewedReason).toContain("Stripe dashboard settings");

    const found = await stateOf(spec.id, ac.id);
    expect(found.verificationState).toBe("accepted");
  });

  it("requires both an actor and a reason", async () => {
    tagAc(`${SPEC391}/acs/ac-8`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "needs actor + reason",
    });
    await expect(
      setAcReviewedVerification(memexId, ac.id, "   ", "a reason"),
    ).rejects.toThrow(ValidationError);
    await expect(
      setAcReviewedVerification(memexId, ac.id, "Barrie", "   "),
    ).rejects.toThrow(ValidationError);
  });

  it("evidence wins: a failing test suppresses the sign-off (columns survive)", async () => {
    // ac-8: the reviewed-verification overlay inherits spec-188's evidence-wins
    // precedence — a failing test drops the AC to `failing` without deleting the
    // sign-off, then it returns to `accepted` once the evidence clears.
    tagAc(`${SPEC391}/acs/ac-8`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "evidence still wins over a reviewed sign-off",
    });
    const ref = refOf(spec.handle, ac.seq);
    createdAcUids.push(ref);

    await setAcReviewedVerification(memexId, ac.id, "Barrie", "policy AC");
    expect((await stateOf(spec.id, ac.id)).verificationState).toBe("accepted");

    await seedTestEvent({ subjectRef: ref, status: "fail", createdAt: new Date(), testIdentifier: "t::x" });
    const failing = await stateOf(spec.id, ac.id);
    expect(failing.verificationState).toBe("failing");
    expect(failing.ac.acceptedBy).toBe("Barrie");
    expect(failing.ac.reviewedReason).toBe("policy AC");

    await seedTestEvent({ subjectRef: ref, status: "pass", createdAt: new Date(), testIdentifier: "t::x" });
    expect((await stateOf(spec.id, ac.id)).verificationState).toBe("accepted");
  });

  it("clearing the acceptance also clears the reviewed_reason", async () => {
    tagAc(`${SPEC391}/acs/ac-8`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "un-sign clears the reason",
    });
    await setAcReviewedVerification(memexId, ac.id, "Barrie", "a reason worth clearing");
    await clearAcAcceptance(memexId, ac.id);
    const [row] = await db.select().from(acs).where(eq(acs.id, ac.id));
    expect(row.acceptedBy).toBeNull();
    expect(row.acceptedAt).toBeNull();
    expect(row.reviewedReason).toBeNull();
  });
});
