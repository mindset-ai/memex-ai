// spec-427 t-9 (ac-6) — send→success conversion measured against the real DB by joining
// comms_log (the send, under its stable key) with the funnel signals:
//   Email 1 success = a mcp.tool_called within 24h of send (the cohort gate guarantees no
//     prior tool call, so "a tool call in-window" == "first tool call within 24h").
//   Email 2 success = mcp.connected AND a spec created, BOTH within 48h of send.
// "spec created" is sourced from the `documents` table (createdByUserId/docType/createdAt)
// — the same source `hasSpec` uses — since there is no spec-created funnel event; see the
// drift flag on the Spec. Scoped to seeded users via `userIds` for deterministic counts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { users, usageEvents, commsLog, documents, memexes, namespaces } from "../../db/schema.js";
import { recordComm } from "../comms-log.js";
import { measureActivationConversion } from "./activation-metrics.js";

const AC6 = "mindset-prod/memex-building-itself/specs/spec-427/acs/ac-6";
const SENT = new Date("2026-06-10T00:00:00Z");
const hoursAfter = (h: number) => new Date(SENT.getTime() + h * 60 * 60 * 1000);

const createdUsers: string[] = [];
const createdDocs: string[] = [];
let nsId: string | null = null;
let mxId: string | null = null;

async function seedUser(email: string): Promise<string> {
  const [u] = await db.insert(users).values({ email, emailVerifiedAt: SENT }).returning({ id: users.id });
  createdUsers.push(u!.id);
  return u!.id;
}
/** Record an activation send under its stable key at SENT. */
async function seedSend(userId: string, cohortKey: string): Promise<void> {
  await recordComm({ userId, channel: "email", type: cohortKey, subject: "x", sentAt: SENT });
}
async function seedEvent(userId: string, name: string, at: Date): Promise<void> {
  await db.insert(usageEvents).values({ actorUserId: userId, name, source: "backend", env: "test", occurredAt: at });
}
async function seedSpec(userId: string, at: Date): Promise<void> {
  const handle = `spec-${createdDocs.length + 1}`; // per-memex unique
  const [d] = await db
    .insert(documents)
    .values({ memexId: mxId!, handle, docType: "spec", title: "seed spec", createdByUserId: userId, isDemo: false, createdAt: at })
    .returning({ id: documents.id });
  createdDocs.push(d!.id);
}

beforeEach(async () => {
  // A Memex to home seeded spec docs (documents.memexId is NOT NULL).
  const [ns] = await db.insert(namespaces).values({ slug: `t9-ns-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind: "user" }).returning({ id: namespaces.id });
  nsId = ns!.id;
  const [mx] = await db.insert(memexes).values({ namespaceId: nsId, slug: "personal", name: "T9" }).returning({ id: memexes.id });
  mxId = mx!.id;
});
afterEach(async () => {
  if (createdDocs.length) { await db.delete(documents).where(inArray(documents.id, createdDocs)).catch(() => {}); createdDocs.length = 0; }
  if (createdUsers.length) {
    await db.delete(commsLog).where(inArray(commsLog.userId, createdUsers)).catch(() => {});
    await db.delete(usageEvents).where(inArray(usageEvents.actorUserId, createdUsers)).catch(() => {});
    await db.delete(users).where(inArray(users.id, createdUsers)).catch(() => {});
    createdUsers.length = 0;
  }
  if (mxId) { await db.delete(memexes).where(inArray(memexes.id, [mxId])).catch(() => {}); mxId = null; }
  if (nsId) { await db.delete(namespaces).where(inArray(namespaces.id, [nsId])).catch(() => {}); nsId = null; }
});

function forCohort(rows: Awaited<ReturnType<typeof measureActivationConversion>>, cohort: string) {
  return rows.find((r) => r.cohort === cohort)!;
}

describe("measureActivationConversion (ac-6)", () => {
  it("Email 1: a tool call within 24h counts as converted; out-of-window / absent does not", async () => {
    tagAc(AC6);
    const converts = await seedUser("t9-e1-hit@example.test");
    await seedSend(converts, "activation.connected_inactive");
    await seedEvent(converts, "mcp.tool_called", hoursAfter(3)); // in-window

    const late = await seedUser("t9-e1-late@example.test");
    await seedSend(late, "activation.connected_inactive");
    await seedEvent(late, "mcp.tool_called", hoursAfter(30)); // > 24h → not counted

    const never = await seedUser("t9-e1-never@example.test");
    await seedSend(never, "activation.connected_inactive"); // no tool call at all

    const rows = await measureActivationConversion(undefined, { userIds: createdUsers.slice() });
    const e1 = forCohort(rows, "connected_inactive");
    expect(e1.sent).toBe(3);
    expect(e1.converted).toBe(1);
    expect(e1.rate).toBeCloseTo(1 / 3);
  });

  it("Email 2: converts ONLY when BOTH mcp.connected AND a spec are created within 48h", async () => {
    tagAc(AC6);
    // both in-window → converted
    const both = await seedUser("t9-e2-both@example.test");
    await seedSend(both, "activation.signed_in_dormant");
    await seedEvent(both, "mcp.connected", hoursAfter(5));
    await seedSpec(both, hoursAfter(10));

    // connected but no spec → NOT converted (proves the AND)
    const connOnly = await seedUser("t9-e2-conn-only@example.test");
    await seedSend(connOnly, "activation.signed_in_dormant");
    await seedEvent(connOnly, "mcp.connected", hoursAfter(5));

    // spec but never connected → NOT converted (proves the AND)
    const specOnly = await seedUser("t9-e2-spec-only@example.test");
    await seedSend(specOnly, "activation.signed_in_dormant");
    await seedSpec(specOnly, hoursAfter(10));

    // both signals but the spec is out-of-window → NOT converted
    const late = await seedUser("t9-e2-late@example.test");
    await seedSend(late, "activation.signed_in_dormant");
    await seedEvent(late, "mcp.connected", hoursAfter(5));
    await seedSpec(late, hoursAfter(60)); // > 48h

    const rows = await measureActivationConversion(undefined, { userIds: createdUsers.slice() });
    const e2 = forCohort(rows, "signed_in_dormant");
    expect(e2.sent).toBe(4);
    expect(e2.converted).toBe(1); // only `both`
  });

  it("rate is 0 (not NaN) when nothing was sent for a cohort", async () => {
    tagAc(AC6);
    const rows = await measureActivationConversion(undefined, { userIds: ["00000000-0000-0000-0000-000000000000"] });
    expect(forCohort(rows, "connected_inactive")).toMatchObject({ sent: 0, converted: 0, rate: 0 });
    expect(forCohort(rows, "signed_in_dormant")).toMatchObject({ sent: 0, converted: 0, rate: 0 });
  });
});
