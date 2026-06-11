// spec-122 t-6 (dec-1) — the activity VIEW. One read-only SQL view that UNION ALLs
// every activity source into ONE uniform shape, so a single query returns every
// kind of activity without a second materialised ledger.
//
//   ac-6   one query over the view returns rows of every kind (source creates,
//          the verification flip, the sourceless status_changed).
//   ac-8   a source row and its view line never disagree on WHEN/WHO.
//   ac-22  the test_events arm reads the TOP-LEVEL actor column — a legacy
//          metadata->>'actor' key is IGNORED.
//   ac-7   activity_log + services/activity-log-sweep.ts are RETAINED.
//   ac-3   activity_view is a derived VIEW, not a second materialised table.
//
// TAGGED with tagAc → reports to the PROD memex. MEMEX_EMIT_KEY in the worktree
// root .env registers tagged tests on prod automatically.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray } from "drizzle-orm";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  acs,
  testEvents,
  activityLog,
} from "../db/schema.js";
import { sql } from "drizzle-orm";
import { createAc } from "./acs.js";
import { createTask } from "./tasks.js";
import { createDocDraft } from "./documents.js";
import { listActivityView } from "./activity-view.js";
import type { RequestCtx } from "./mutate.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-122/acs";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
  testEvents: [] as string[],
  activityLogs: [] as string[],
};

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `s122t6-${sub}@memex.ai`, name: "Christine" } as typeof users.$inferInsert)
    .returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, memexId: a.id, nsSlug: ns.slug };
}

let actor: Awaited<ReturnType<typeof setupActor>>;
let docId: string;
let specHandle: string;

beforeAll(async () => {
  actor = await setupActor("aview");
  const doc = await createDocDraft(actor.memexId, "Activity View", "AV", "spec");
  docId = doc.id;
  created.docs.push(docId);
  const [docRow] = await db.select().from(documents).where(eq(documents.id, docId));
  specHandle = docRow.handle; // e.g. 'spec-1'
});

afterAll(async () => {
  if (created.activityLogs.length)
    await db.delete(activityLog).where(inArray(activityLog.id, created.activityLogs)).catch(() => {});
  if (created.testEvents.length)
    await db.delete(testEvents).where(inArray(testEvents.id, created.testEvents)).catch(() => {});
  if (created.docs.length) {
    await db.delete(acs).where(inArray(acs.briefId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length) await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("activity view: one uniform read across every arm [spec-122 t-6]", () => {
  // ── ac-6 ──────────────────────────────────────────────────────────────────
  it("ac-6: one query over the view returns rows of every kind", async () => {
    tagAc(`${AC}/ac-6`);
    const ctx: RequestCtx = { actorUserId: actor.user.id, channel: "mcp" };

    // A source AC create + a source task create.
    await createAc({ memexId: actor.memexId, briefId: docId, kind: "scope", statement: "view AC" }, ctx);
    await createTask(actor.memexId, docId, "view task", "desc", undefined, undefined, ctx);

    // A test_events verification flip with a real ac_uid pointing at this spec.
    const acUid = `${actor.nsSlug}/main/specs/${specHandle}/acs/ac-1`;
    const [te] = await db
      .insert(testEvents)
      .values({ acUid, status: "pass", actor: "ci-bot" } as typeof testEvents.$inferInsert)
      .returning();
    created.testEvents.push(te.id);

    // A sourceless activity_log status_changed phase move.
    const [al] = await db
      .insert(activityLog)
      .values({
        memexId: actor.memexId,
        briefId: docId,
        actorUserId: actor.user.id,
        actorName: "Christine",
        actorKind: "human",
        channel: "rest_ui",
        entity: "document",
        action: "status_changed",
        narrative: "draft → specify",
      } as typeof activityLog.$inferInsert)
      .returning();
    created.activityLogs.push(al.id);

    const rows = await listActivityView(actor.memexId, { specRef: docId });
    const kinds = new Set(rows.map((r) => r.kind));
    expect(kinds.has("ac")).toBe(true);
    expect(kinds.has("task")).toBe(true);
    expect(kinds.has("test_event")).toBe(true);
    expect(kinds.has("activity_log")).toBe(true);
  });

  // ── ac-8 ──────────────────────────────────────────────────────────────────
  it("ac-8: the view's at/actor_user_id/actor_name equal the source acs row (no drift)", async () => {
    tagAc(`${AC}/ac-8`);
    const ctx: RequestCtx = { actorUserId: actor.user.id, channel: "mcp" };
    const ac = await createAc(
      { memexId: actor.memexId, briefId: docId, kind: "implementation", statement: "no-drift AC" },
      ctx,
    );
    const [src] = await db.select().from(acs).where(eq(acs.id, ac.id));

    const rows = await listActivityView(actor.memexId, { specRef: docId });
    const line = rows.find((r) => r.kind === "ac" && r.entityId === ac.id);
    expect(line).toBeDefined();
    expect(line!.actorUserId).toBe(src.actorUserId);
    expect(line!.actorName).toBe(src.actorName);
    // The view's `at` is COALESCE(updated_at, created_at) — equal to the source.
    const expectedAt = src.updatedAt ?? src.createdAt;
    expect(new Date(line!.at).getTime()).toBe(new Date(expectedAt).getTime());
  });

  // ── ac-22 ─────────────────────────────────────────────────────────────────
  it("ac-22: the test_events arm reads the TOP-LEVEL actor, ignoring metadata.actor", async () => {
    tagAc(`${AC}/ac-22`);
    const acUid = `${actor.nsSlug}/main/specs/${specHandle}/acs/ac-22`;
    const [te] = await db
      .insert(testEvents)
      .values({
        acUid,
        status: "pass",
        actor: "ci-bot",
        metadata: { actor: "WRONG" },
      } as typeof testEvents.$inferInsert)
      .returning();
    created.testEvents.push(te.id);

    const rows = await listActivityView(actor.memexId, { specRef: docId });
    const line = rows.find((r) => r.kind === "test_event" && r.entityId === te.id);
    expect(line).toBeDefined();
    expect(line!.actorRaw).toBe("ci-bot"); // top-level column, NOT the metadata key
    expect(line!.actorRaw).not.toBe("WRONG");
  });

  // ── ac-7 ──────────────────────────────────────────────────────────────────
  it("ac-7: activity_log table AND services/activity-log-sweep.ts are retained", async () => {
    tagAc(`${AC}/ac-7`);
    const tableRows = (await db.execute(sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'activity_log'
    `)) as unknown as unknown[];
    expect(tableRows.length).toBe(1);

    const here = dirname(fileURLToPath(import.meta.url));
    expect(existsSync(resolve(here, "activity-log-sweep.ts"))).toBe(true);
  });

  // ── ac-3 (structural) ──────────────────────────────────────────────────────
  it("ac-3: activity_view is a VIEW, not a table — derived, no second ledger", async () => {
    tagAc(`${AC}/ac-3`);
    const viewRows = (await db.execute(sql`
      SELECT 1 FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = 'activity_view'
    `)) as unknown as unknown[];
    expect(viewRows.length).toBe(1);

    // And it is NOT a base table.
    const baseRows = (await db.execute(sql`
      SELECT table_type FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'activity_view'
    `)) as unknown as Array<{ table_type: string }>;
    if (baseRows.length) expect(baseRows[0].table_type).toBe("VIEW");
  });
});
