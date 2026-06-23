// spec-342: test emission events must NOT auto-advance a Spec's phase.
//
// Before spec-342, POST /api/test-events called observeTestEventTraffic, which
// advanced the AC's Spec build→verify (and reopened a `done` Spec to verify),
// channel='server', no actor — a surprise move the Spec owner never heard about.
// This Spec removed that path entirely: a test event now updates the AC verdict
// + audit trail only; phase is a deliberate human / handoff placement.
//
// These tests drive the REAL route handler against a real Postgres, with only
// the emission-key auth mocked (the auth/memex-match itself is covered by
// emission-auth.api.test.ts). Real specs are created with real handles under a
// real memex, so a reintroduced observeTestEventTraffic WOULD find the doc by
// (memexId, handle) and flip it — making this a genuine regression guard, not a
// tautology.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// Holder is set in beforeAll once the real memex exists; the mocked auth reads
// it at request time so verifyEmissionKey/resolveMemexId agree on the same
// memexId (auth passes: targetMemexId === emissionKey.memexId).
const h = vi.hoisted(() => ({ memexId: "" }));

vi.mock("../services/emission-keys.js", () => ({
  verifyEmissionKey: vi.fn(async () => ({
    id: "test-key",
    memexId: h.memexId,
    scopedSpecHandle: null,
  })),
  resolveMemexId: vi.fn(async () => h.memexId),
  bumpLastUsed: vi.fn(),
}));

import { db } from "../db/connection.js";
import {
  documents,
  testEvents,
  testEventLatest,
  namespaces,
} from "../db/schema.js";
import { createDocDraft, updateDocStatus } from "../services/documents.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { testEventsRouter } from "./test-events.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-342/acs/ac-${n}`;

const app = new Hono();
app.route("/api/test-events", testEventsRouter);

let slug: string;
let ownerId: string;
const createdDocIds: string[] = [];
const createdAcUids: string[] = [];

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("s342");
  h.memexId = made.memexId;
  slug = made.slug;
  ownerId = (await upsertUserByEmail("dev@memex.ai")).id;
});

afterAll(async () => {
  if (createdAcUids.length) {
    await db.delete(testEvents).where(inArray(testEvents.acUid, createdAcUids)).catch(() => {});
    await db.delete(testEventLatest).where(inArray(testEventLatest.acUid, createdAcUids)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
  if (slug) {
    await db.delete(namespaces).where(eq(namespaces.slug, slug)).catch(() => {});
  }
});

/** Create a real spec under the test memex, in the given phase. */
async function makeSpec(title: string, status: string): Promise<{ id: string; acUid: string }> {
  const doc = await createDocDraft(h.memexId, title, "purpose", "spec", undefined, undefined, ownerId);
  createdDocIds.push(doc.id);
  if (status !== "draft") {
    await updateDocStatus(h.memexId, doc.id, status);
  }
  const acUid = `${slug}/main/specs/${doc.handle}/acs/ac-1`;
  createdAcUids.push(acUid);
  return { id: doc.id, acUid };
}

async function specStatus(id: string): Promise<string> {
  const row = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  return row!.status;
}

async function emit(acUid: string, opts: { hidden?: boolean } = {}) {
  return app.request("/api/test-events", {
    method: "POST",
    headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
    body: JSON.stringify({
      ac_uid: acUid,
      status: "pass",
      test_identifier: "spec-342.test.ts::no-advance",
      hidden: opts.hidden ?? false,
    }),
  });
}

describe("spec-342: a test event never advances a Spec's phase", () => {
  it("a non-hidden test event leaves the phase untouched from EVERY source phase, including the former done→verify reopen [ac-1][ac-5][ac-7]", async () => {
    tagAc(AC(1));
    tagAc(AC(5));
    tagAc(AC(7));
    for (const phase of ["draft", "specify", "build", "done"]) {
      const spec = await makeSpec(`No-advance from ${phase}`, phase);
      expect(await specStatus(spec.id)).toBe(phase); // sanity: seeded as expected
      const res = await emit(spec.acUid);
      expect(res.status).toBe(201);
      // The whole point: the emission did not move the lifecycle.
      expect(await specStatus(spec.id)).toBe(phase);
    }
  });

  it("a non-hidden pass still updates the AC verdict while the phase stays put [ac-2][ac-6]", async () => {
    tagAc(AC(2));
    tagAc(AC(6));
    const spec = await makeSpec("Verdict still lands", "build");
    const res = await emit(spec.acUid);
    expect(res.status).toBe(201);
    // Phase unchanged…
    expect(await specStatus(spec.id)).toBe("build");
    // …but the verdict summary was materialised by the non-hidden pass.
    const [summary] = await db
      .select({ latestStatus: testEventLatest.latestStatus })
      .from(testEventLatest)
      .where(eq(testEventLatest.acUid, spec.acUid));
    expect(summary?.latestStatus).toBe("pass");
  });

  it("the hidden flag is decoupled from phase: a hidden emission changes neither the phase nor the visible verdict [ac-3][ac-8]", async () => {
    tagAc(AC(3));
    tagAc(AC(8));
    const spec = await makeSpec("Hidden is audit-only", "build");
    const res = await emit(spec.acUid, { hidden: true });
    expect(res.status).toBe(201);
    // No phase effect (the only behaviour the old code gated on `hidden`).
    expect(await specStatus(spec.id)).toBe("build");
    // Audit row exists, flagged hidden; the visible verdict is NOT a hidden pass
    // (the summary upsert skips hidden emissions — verdict/audit only).
    const events = await db
      .select({ hidden: testEvents.hidden })
      .from(testEvents)
      .where(eq(testEvents.acUid, spec.acUid));
    expect(events.some((e) => e.hidden === true)).toBe(true);
    // The hidden emission is excluded from the verdict summary entirely (the
    // upsert skips hidden rows) — so it creates no visible verdict at all.
    const summaryRows = await db
      .select({ latestStatus: testEventLatest.latestStatus })
      .from(testEventLatest)
      .where(eq(testEventLatest.acUid, spec.acUid));
    expect(summaryRows.length).toBe(0);
  });

  it("regression pin: POST /api/test-events is accepted but drives no transition — the contract spec-327/spec-189 relied on is retired [ac-4]", async () => {
    tagAc(AC(4));
    // A build Spec receiving repeated CI passes (the spec-36/spec-39 scenario)
    // stays in build no matter how many land.
    const spec = await makeSpec("Repeated CI passes, no churn", "build");
    for (let i = 0; i < 3; i++) {
      const res = await emit(spec.acUid);
      expect(res.status).toBe(201);
    }
    expect(await specStatus(spec.id)).toBe("build");
  });
});
