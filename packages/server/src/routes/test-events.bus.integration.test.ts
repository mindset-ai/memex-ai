// spec-156 ac-16: accepted test-event ingestion emits a bus event so AC-health
// surfaces (SpecList chips, Spec page counts) refetch via SSE when a CI run
// posts results — no longer reliant on AcPanel's 3s poll alone.
//
// This is an INTEGRATION test against real Postgres (no db mock) so the route's
// memexId resolution (parse `<namespace>/<memex>` from the ac_uid → join
// namespaces ↔ memexes) actually runs end-to-end. A real memex is created and
// the ac_uid is built against its slugs, so the emitted event carries the real
// memexId the per-Memex SSE stream filters on. The unit-level test-events.test.ts
// keeps mocking the DB; this file proves the live emit path.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { memexes, testEvents, users } from "../db/schema.js";
import { bus, type ChangeEvent } from "../services/bus.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { mintEmissionKey } from "../services/emission-keys.js";
import { testEventsRouter } from "./test-events.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-156/acs";

const app = new Hono();
app.route("/api/test-events", testEventsRouter);

let memexId: string;
let namespaceSlug: string;
let subjectRef: string;
let emissionKey: string;
let minterUserId: string;

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("spec156-te");
  memexId = made.memexId;
  namespaceSlug = made.slug;
  // The memex slug is "main" (see makeTestMemexWithDevAdmin). buildAcRef in
  // services/acs.ts is the forward direction of this same grammar.
  subjectRef = `${namespaceSlug}/main/specs/spec-1/acs/ac-1`;

  // spec-129: the route requires a per-Memex emission key on every POST. Mint a
  // real one for the test memex (same idiom as __e2e__/emission-auth.api.test.ts).
  const [minter] = await db
    .insert(users)
    .values({
      email: `spec156-te-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  minterUserId = minter.id;
  const minted = await mintEmissionKey(memexId, "spec156-te", minterUserId);
  emissionKey = minted.raw;
});

afterAll(async () => {
  await db.delete(memexes).where(eq(memexes.id, memexId)).catch(() => {});
  await db.delete(users).where(eq(users.id, minterUserId)).catch(() => {});
});

describe("POST /api/test-events — bus emit on ingestion (spec-156 ac-16)", () => {
  it("emits test_event.created on the resolved memex when a run posts a result", async () => {
    tagAc(`${AC}/ac-16`);
    tagAc(`${AC}/ac-2`); // scope ac-2: audit-finding remediation (this finding's proof)

    const received: ChangeEvent[] = [];
    const unsubscribe = bus.subscribe({ memexId }, (e) => received.push(e));

    try {
      const res = await app.request("/api/test-events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${emissionKey}`,
        },
        body: JSON.stringify({
          ac_uid: subjectRef,
          status: "pass",
          test_identifier: "spec156.test.ts::emits",
        }),
      });
      expect(res.status).toBe(201);

      // The ingest emitted exactly one event, scoped to the AC's Memex, so the
      // per-Memex SSE stream (SpecList chips, Spec page counts) wakes and refetches.
      // "test_event" is not yet a first-class ChangeEntity member (bus.ts is
      // owned by another wave); compare as a string to match the inline literal
      // the route emits.
      const created = received.filter(
        (e) => e.action === "created" && (e.entity as string) === "test_event",
      );
      expect(created).toHaveLength(1);
      expect(created[0].memexId).toBe(memexId);

      // The row actually landed — the emit rode a real mutate() whose fn() wrote it.
      const rows = await db
        .select()
        .from(testEvents)
        .where(eq(testEvents.subjectRef, subjectRef));
      expect(rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      unsubscribe();
    }
  });
});

// spec-528 — the unit tests assert the object handed to `.values()`, which proves
// the fallback logic but NOT that the values reach the columns. That gap is the
// exact shape of the defect this Spec exists for: the emitter collected these
// values and the server accepted them, and the columns stayed empty for months
// while every test anyone might have written would have passed. So read them
// back off a real row.
const AC528 = "mindset-prod/memex-building-itself/specs/spec-528/acs";

describe("POST /api/test-events — run_id / commit_sha reach the COLUMNS (spec-528 ac-6)", () => {
  it("stores a metadata-sourced run id and commit in the run_id / commit_sha columns", async () => {
    tagAc(`${AC528}/ac-6`);
    // [per std-37] cl-1: unique per call so a parallel worker cannot collide.
    const testIdentifier = `spec528-columns-${crypto.randomUUID()}`;

    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${emissionKey}`,
      },
      body: JSON.stringify({
        ac_uid: subjectRef,
        status: "pass",
        test_identifier: testIdentifier,
        // The shape every un-upgraded client already sends: no top-level
        // run_id / commit_sha, both values riding in metadata.
        metadata: { run_id: "31589392781", commit: "112ad9ab", branch: "main" },
      }),
    });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(testEvents)
      .where(eq(testEvents.testIdentifier, testIdentifier));

    // The columns — not the payload, not the response.
    expect(row.runId).toBe("31589392781");
    expect(row.commitSha).toBe("112ad9ab");
    // And the metadata copy survived alongside them (ac-3).
    expect(row.metadata).toMatchObject({
      run_id: "31589392781",
      commit: "112ad9ab",
      branch: "main",
    });
  });
});
