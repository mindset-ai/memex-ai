// spec-15 t-2 (dec-2 / ac-7) — memex-ai HALF of the shared drift guard.
//
// The metric is DEFINED here (measureActivationConversion, spec-427 t-9) and
// REPRODUCED in memex-backstage's comms-conversion service. To stop the two from
// silently diverging, both repos seed the SAME shared fixture
// (comms-conversion.fixture.ts, mirrored byte-for-byte) and assert their own
// implementation returns FIXTURE_EXPECTED. This is the source-side assertion; the
// Backstage repo carries the reproduction-side one. If this function drifts from
// the pinned scenario, this test breaks — which is the point (dec-2).
//
// The scenario lives in the all-in-window regime, so measureActivationConversion's
// all-time result equals what Backstage's windowed service returns for a wide window.
// Seeding mirrors activation-metrics.integration.test.ts (drizzle, userIds-scoped).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { users, usageEvents, commsLog, documents, memexes, namespaces } from "../../db/schema.js";
import { recordComm } from "../comms-log.js";
import { measureActivationConversion } from "./activation-metrics.js";
import {
  FIXTURE_EXPECTED,
  FIXTURE_SENDS,
  PINNED_ACTIVATION_COMMS_KEY,
} from "./comms-conversion.fixture.js";

const AC7 = "mindset-prod/memex-backstage/specs/spec-15/acs/ac-7";

const REFERENCE_NOW = new Date("2026-06-20T12:00:00Z");
const daysBefore = (d: number) => new Date(REFERENCE_NOW.getTime() - d * 86_400_000);
const hoursAfter = (base: Date, h: number) => new Date(base.getTime() + h * 3_600_000);

const createdUsers: string[] = [];
const createdDocs: string[] = [];
let nsId: string | null = null;
let mxId: string | null = null;

beforeEach(async () => {
  // documents.memexId is NOT NULL — home the seeded spec docs in a throwaway Memex.
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: `s15-ns-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind: "user" })
    .returning({ id: namespaces.id });
  nsId = ns!.id;
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: nsId, slug: "personal", name: "S15" })
    .returning({ id: memexes.id });
  mxId = mx!.id;
});

afterEach(async () => {
  if (createdDocs.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocs)).catch(() => {});
    createdDocs.length = 0;
  }
  if (createdUsers.length) {
    await db.delete(commsLog).where(inArray(commsLog.userId, createdUsers)).catch(() => {});
    await db.delete(usageEvents).where(inArray(usageEvents.actorUserId, createdUsers)).catch(() => {});
    await db.delete(users).where(inArray(users.id, createdUsers)).catch(() => {});
    createdUsers.length = 0;
  }
  if (mxId) {
    await db.delete(memexes).where(inArray(memexes.id, [mxId])).catch(() => {});
    mxId = null;
  }
  if (nsId) {
    await db.delete(namespaces).where(inArray(namespaces.id, [nsId])).catch(() => {});
    nsId = null;
  }
});

describe("measureActivationConversion parity with the shared fixture (ac-7)", () => {
  it("reproduces the shared fixture's expected {sent, converted, rate}", async () => {
    tagAc(AC7);
    const ids: string[] = [];
    for (const s of FIXTURE_SENDS) {
      const email = `s15-${Math.random().toString(36).slice(2, 10)}@example.test`;
      const [u] = await db
        .insert(users)
        .values({ email, emailVerifiedAt: REFERENCE_NOW })
        .returning({ id: users.id });
      const userId = u!.id;
      createdUsers.push(userId);
      ids.push(userId);
      const sentAt = daysBefore(s.sentDaysAgo);
      await recordComm({
        userId,
        channel: "email",
        type: PINNED_ACTIVATION_COMMS_KEY[s.cohort],
        subject: "x",
        sentAt,
      });
      for (const ev of s.events) {
        await db.insert(usageEvents).values({
          actorUserId: userId,
          name: ev.name,
          source: "backend",
          env: "test",
          occurredAt: hoursAfter(sentAt, ev.hoursAfterSend),
        });
      }
      for (const sp of s.specs) {
        const [d] = await db
          .insert(documents)
          .values({
            memexId: mxId!,
            handle: `s15-spec-${createdDocs.length + 1}`,
            docType: "spec",
            title: "seed",
            createdByUserId: userId,
            isDemo: sp.isDemo,
            createdAt: hoursAfter(sentAt, sp.hoursAfterSend),
          })
          .returning({ id: documents.id });
        createdDocs.push(d!.id);
      }
    }

    const rows = await measureActivationConversion(undefined, { userIds: ids });
    for (const cohort of ["connected_inactive", "signed_in_dormant"] as const) {
      const row = rows.find((r) => r.cohort === cohort)!;
      const exp = FIXTURE_EXPECTED[cohort];
      expect(row.sent).toBe(exp.sent);
      expect(row.converted).toBe(exp.converted);
      expect(row.rate).toBeCloseTo(exp.rate);
    }
  });
});
