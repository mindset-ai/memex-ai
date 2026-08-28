// spec-520 t-5 / ac-29 — the batch route's memex resolve is memoised PER EVENT'S OWN
// parsed (namespace, memex) pair, never hoisted out of the loop.
//
// ⚠ THIS IS THE SHARPEST HAZARD IN THE SPEC (s-2 Trap 1), and the natural optimisation is
// the dangerous one.
//
// processOneEvent performs a PER-EVENT authorization check: it parses the namespace and
// memex slug out of THAT EVENT'S OWN subject_ref, resolves them, and rejects unless the
// result matches the bearer key's Memex (spec-129 ac-10). The batch endpoint accepts
// arbitrary per-event subject_refs — nothing requires one batch to name one Memex, and the
// CALLER controls every ref in the array.
//
//   SAFE:   memoise keyed on each event's own parsed (namespace, memex).
//   UNSAFE: resolve once and reuse for every event. That silently turns the check into
//           `emissionKey.memexId === emissionKey.memexId` — trivially true — and lets a
//           valid key for Memex A write events into Memex B.
//
// AND THERE IS NO DATABASE BACKSTOP. test_events, test_event_latest and ac_first_verified
// carry no RLS on this path today (spec-398 ac-10 asserted their absence; spec-399 is
// unbuilt). An application-layer mistake here IS the tenant-isolation failure.
//
// So this test is written to FAIL if the resolve is hoisted: it posts one batch whose events
// name two different Memexes and asserts the foreign one is rejected while its neighbours
// land. A test that posted a single-tenant batch would pass against the hoisted version and
// prove nothing.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { memexEmissionKeys, memexes, namespaces, testEvents, users } from "../db/schema.js";
import { mintEmissionKey, mintEphemeralEmissionKey } from "../services/emission-keys.js";
import { upsertUserByEmail } from "../services/users.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { app } from "../app.js";

const AC_BATCH_SCOPE = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-29";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let userA: string;
let userB: string;
let memexA: string;
let memexB: string;
let refA: (n: number) => string;
let refB: (n: number) => string;
let keyA: string;
const createdRefs: string[] = [];

async function makeTenant(tag: string): Promise<{
  userId: string;
  memexId: string;
  ref: (n: number) => string;
}> {
  const user = await upsertUserByEmail(`spec520-t5-${tag}-${runId}@example.com`);
  const created = await ensureUserNamespace(user.id);
  const [ns] = await db
    .select({ slug: namespaces.slug })
    .from(namespaces)
    .where(eq(namespaces.id, created.memex.namespaceId))
    .limit(1);
  const prefix = `${ns!.slug}/${created.memex.slug}/specs/spec-1/acs`;
  return {
    userId: user.id,
    memexId: created.memex.id,
    ref: (n: number) => {
      const r = `${prefix}/ac-${n}`;
      createdRefs.push(r);
      return r;
    },
  };
}

beforeAll(async () => {
  const a = await makeTenant("a");
  const b = await makeTenant("b");
  userA = a.userId;
  memexA = a.memexId;
  refA = a.ref;
  userB = b.userId;
  memexB = b.memexId;
  refB = b.ref;
  keyA = (await mintEmissionKey(memexA, `t5-${runId}`, userA)).raw;
});

afterAll(async () => {
  if (createdRefs.length) {
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdRefs)).catch(() => {});
  }
  await db.delete(memexEmissionKeys).where(eq(memexEmissionKeys.memexId, memexA)).catch(() => {});
  for (const m of [memexA, memexB]) {
    await db.delete(memexes).where(eq(memexes.id, m)).catch(() => {});
  }
  await db.delete(users).where(inArray(users.id, [userA, userB])).catch(() => {});
});

async function postBatch(key: string, events: unknown[]) {
  const res = await app.request("/api/test-events/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ events }),
  });
  return { status: res.status, body: (await res.json()) as {
    accepted: number;
    rejected: number;
    results: Array<{ index: number; ok: boolean; error?: string }>;
  } };
}

const ev = (ref: string, id: string) => ({
  subject_ref: ref,
  status: "pass",
  test_identifier: id,
  duration_ms: 1,
});

describe("spec-520 ac-29: one batch, two Memexes — the foreign event is rejected", () => {
  it("rejects ONLY the foreign-Memex event and lands every neighbour in the same batch", async () => {
    tagAc(AC_BATCH_SCOPE);

    // Key authorises Memex A. Event at index 1 names Memex B — a ref the CALLER chose.
    // If the resolve were hoisted, index 1's ref would never be resolved at all and the
    // check would compare A's id with itself: the foreign event would LAND.
    const { status, body } = await postBatch(keyA, [
      ev(refA(1), "t::a1"),
      ev(refB(9), "t::foreign"),
      ev(refA(2), "t::a2"),
    ]);

    expect(status).toBe(200);
    expect(body.results[0]!.ok).toBe(true);
    expect(body.results[1]!.ok).toBe(false);
    expect(body.results[2]!.ok).toBe(true);
    expect(body.accepted).toBe(2);
    expect(body.rejected).toBe(1);
  });

  it("writes NO row for the foreign ref — the rejection is a refusal, not a relabel", async () => {
    tagAc(AC_BATCH_SCOPE);

    const foreign = refB(9);
    await postBatch(keyA, [ev(refA(3), "t::a3"), ev(foreign, "t::foreign2")]);

    // The failure mode this guards is subtler than "it was accepted": a hoisted resolve
    // would write the foreign event into Memex A under A's memex_id — a row that exists,
    // is tenant-stamped wrong, and looks entirely normal.
    const rows = await db
      .select({ id: testEvents.id, memexId: testEvents.memexId })
      .from(testEvents)
      .where(eq(testEvents.subjectRef, foreign));
    expect(rows).toEqual([]);
  });

  it("a batch naming only its own Memex still collapses to ONE resolve", async () => {
    tagAc(AC_BATCH_SCOPE);

    // The win the memo is for: a normal single-suite batch resolves once, not once per
    // event. Asserted through behaviour — all events land — plus the count assertion in
    // the unit test that can observe the resolver directly.
    const { status, body } = await postBatch(keyA, [
      ev(refA(4), "t::x1"),
      ev(refA(4), "t::x2"),
      ev(refA(5), "t::x3"),
    ]);
    expect(status).toBe(200);
    expect(body.accepted).toBe(3);
    expect(body.rejected).toBe(0);
  });
});

describe("spec-520 ac-29: the scoped-agent-key gate also holds PER EVENT in a batch", () => {
  it("a scoped key emitting for another Spec's AC is rejected, while its own Spec's event lands", async () => {
    tagAc(AC_BATCH_SCOPE);

    // spec-234 ac-11: an ephemeral / agent key carries a scoped_spec_handle and may emit
    // ONLY for ACs of that one Spec — so an in-progress agent run cannot flip the
    // verification bar of any other Spec on the shared board.
    //
    // This is the SECOND per-event gate, and it is the one most likely to be lost to the
    // same optimisation: unlike the Memex check it compares against a handle parsed from
    // the ref, so hoisting anything out of the loop makes it compare one event's Spec
    // against itself. Both events below belong to the SAME Memex, so the first gate passes
    // for both — only the scope gate separates them.
    const scoped = await mintEphemeralEmissionKey(memexA, "spec-1", userA);

    // refA() already builds spec-1 refs, so `own` needs no rewriting — an earlier draft
    // replaced "/specs/spec-1/" with itself here, a no-op that READ as if the two refs were
    // being derived symmetrically. CodeQL flagged it. In a test whose entire point is that
    // the two refs differ, a line that looks like it transforms one and does not is worse
    // than useless.
    const own = refA(20);
    const other = refA(21).replace("/specs/spec-1/", "/specs/spec-2/");
    createdRefs.push(other);

    const { status, body } = await postBatch(scoped.raw, [
      ev(own, "t::in-scope"),
      ev(other, "t::out-of-scope"),
    ]);

    expect(status).toBe(200);
    expect(body.results[0]!.ok).toBe(true);
    expect(body.results[1]!.ok).toBe(false);
    expect(body.rejected).toBe(1);
  });
});
