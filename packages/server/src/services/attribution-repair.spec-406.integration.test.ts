// spec-406 t-8 (dec-7) — closing the std-32 attribution gap on the state-transition
// write paths the Stats-tab audit reads from.
//
//   ac-24  convertIssueToTask threads a RequestCtx and stamps actor + channel on
//          BOTH the task and the AC it mints.
//   ac-25  the transition helpers approveDecision / rejectDecision / reopenDecision
//          (decisions.ts) and setAcAcceptance / clearAcAcceptance (acs.ts) thread a
//          RequestCtx, stamping actor + channel on the updated row.
//   ac-26  [removed spec-474] seedHandholdDemo's server-ctx attribution — the handhold
//          demo seeder was deleted when the demo-vs-starter experiment concluded; the
//          starter Spec seed is system-attributed by design (no seed-attribution case).
//   ac-27  REGRESSION: every repaired path lands a non-null channel on its row — a
//          revert to mutate({}) (silent 'server', NULL source-row channel) fails this.
//
// TAGGED with tagAc → reports to the PROD memex. A human runs it with
// MEMEX_EMIT_KEY set; auto mode skips tagged suites.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
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
  tasks,
  decisions,
  testEvents,
  testEventLatest,
  activityLog,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { createAc } from "./acs.js";
import { setAcAcceptance, clearAcAcceptance } from "./acs.js";
import { createDecision, approveDecision, rejectDecision, reopenDecision } from "./decisions.js";
import { createIssue, convertIssueToTask } from "./issues.js";
import type { RequestCtx } from "./mutate.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-406/acs";

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `s406-${sub}@memex.ai`, name: "Dakota" } as typeof users.$inferInsert)
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

beforeAll(async () => {
  actor = await setupActor("attr");
  const doc = await createDocDraft(actor.memexId, "Attribution repair", "T", "spec");
  docId = doc.id;
  // convertIssueToTask is a build-phase down-bridge; put the Spec in build so the
  // minted task isn't rejected by the spec-327 planning-phase guard.
  await db.update(documents).set({ status: "build" }).where(eq(documents.id, docId));
  created.docs.push(docId);
});

afterAll(async () => {
  if (created.memexes.length) {
    // test_events / test_event_latest carry no docId cascade (the handhold seed
    // writes synthetic emissions) — clear them by memex first, then the memexes
    // themselves (acs / tasks / decisions / issues / documents cascade off memex).
    await db.delete(testEvents).where(inArray(testEvents.memexId, created.memexes)).catch(() => {});
    await db.delete(testEventLatest).where(inArray(testEventLatest.memexId, created.memexes)).catch(() => {});
    await db.delete(activityLog).where(inArray(activityLog.memexId, created.memexes)).catch(() => {});
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("spec-406 t-8: attribution threaded through the repaired transition paths", () => {
  // ── ac-24 ─────────────────────────────────────────────────────────────────
  it("ac-24: convertIssueToTask stamps actor + channel on the task AND the minted AC", async () => {
    tagAc(`${AC}/ac-24`);
    const ctx: RequestCtx = { actorUserId: actor.user.id, channel: "rest_ui" };
    const issue = await createIssue({
      memexId: actor.memexId,
      docId,
      title: "Convert me",
      body: "behaviour to deliver",
      type: "bug",
    });
    const result = await convertIssueToTask(actor.memexId, issue.id, ctx);

    const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, result.task.id));
    expect(taskRow.actorUserId).toBe(actor.user.id);
    expect(taskRow.actorName).toBe("Dakota");
    expect(taskRow.channel).toBe("rest_ui");

    const [acRow] = await db.select().from(acs).where(eq(acs.id, result.acId));
    expect(acRow.actorUserId).toBe(actor.user.id);
    expect(acRow.actorName).toBe("Dakota");
    expect(acRow.channel).toBe("rest_ui");
  });

  // ── ac-25 ─────────────────────────────────────────────────────────────────
  it("ac-25: approveDecision stamps actor + channel on the candidate→open update", async () => {
    tagAc(`${AC}/ac-25`);
    const dec = await createDecision(actor.memexId, docId, "approve me", "ctx", "agent");
    await db.update(decisions).set({ status: "candidate" }).where(eq(decisions.id, dec.id));
    const updated = await approveDecision(actor.memexId, dec.id, {
      actorUserId: actor.user.id,
      channel: "mcp",
    });
    const [row] = await db.select().from(decisions).where(eq(decisions.id, updated.id));
    expect(row.status).toBe("open");
    expect(row.actorUserId).toBe(actor.user.id);
    expect(row.actorName).toBe("Dakota");
    expect(row.channel).toBe("mcp");
  });

  it("ac-25: rejectDecision stamps actor + channel on the candidate→rejected update", async () => {
    tagAc(`${AC}/ac-25`);
    const dec = await createDecision(actor.memexId, docId, "reject me", "ctx", "agent");
    await db.update(decisions).set({ status: "candidate" }).where(eq(decisions.id, dec.id));
    const updated = await rejectDecision(actor.memexId, dec.id, "not load-bearing", {
      actorUserId: actor.user.id,
      channel: "in_app_agent",
    });
    const [row] = await db.select().from(decisions).where(eq(decisions.id, updated.id));
    expect(row.status).toBe("rejected");
    expect(row.actorUserId).toBe(actor.user.id);
    expect(row.actorName).toBe("Dakota");
    expect(row.channel).toBe("in_app_agent");
  });

  it("ac-25: reopenDecision stamps actor + channel on the resolved→open update", async () => {
    tagAc(`${AC}/ac-25`);
    const dec = await createDecision(actor.memexId, docId, "reopen me", "ctx", "human");
    await db.update(decisions).set({ status: "resolved" }).where(eq(decisions.id, dec.id));
    const updated = await reopenDecision(actor.memexId, dec.id, {
      actorUserId: actor.user.id,
      channel: "rest_ui",
    });
    const [row] = await db.select().from(decisions).where(eq(decisions.id, updated.id));
    expect(row.status).toBe("open");
    expect(row.actorUserId).toBe(actor.user.id);
    expect(row.actorName).toBe("Dakota");
    expect(row.channel).toBe("rest_ui");
  });

  it("ac-25: setAcAcceptance and clearAcAcceptance stamp actor + channel on the AC", async () => {
    tagAc(`${AC}/ac-25`);
    const ac = await createAc(
      { memexId: actor.memexId, briefId: docId, kind: "implementation", statement: "accept me" },
      { actorUserId: actor.user.id, channel: "rest_ui" },
    );
    await setAcAcceptance(actor.memexId, ac.id, "Dakota", {
      actorUserId: actor.user.id,
      channel: "mcp",
    });
    const [setRow] = await db.select().from(acs).where(eq(acs.id, ac.id));
    expect(setRow.acceptedBy).toBe("Dakota");
    expect(setRow.actorUserId).toBe(actor.user.id);
    expect(setRow.actorName).toBe("Dakota");
    expect(setRow.channel).toBe("mcp");

    await clearAcAcceptance(actor.memexId, ac.id, {
      actorUserId: actor.user.id,
      channel: "in_app_agent",
    });
    const [clearRow] = await db.select().from(acs).where(eq(acs.id, ac.id));
    expect(clearRow.acceptedAt).toBeNull();
    expect(clearRow.actorUserId).toBe(actor.user.id);
    expect(clearRow.actorName).toBe("Dakota");
    expect(clearRow.channel).toBe("in_app_agent");
  });

  // ── ac-26 ─────────────────────────────────────────────────────────────────
  // spec-474: the ac-26 case (seedHandholdDemo threads a server ctx onto its rows) was
  // removed when the handhold demo seeder was deleted (the demo-vs-starter experiment
  // concluded with the starter Spec as the winner). The starter Spec seed is
  // system-attributed by design (starter-spec.ts strips any actor), so there is no
  // seed-attribution case to assert here any more.

  // ── ac-27 (regression) ──────────────────────────────────────────────────────
  it("ac-27: NO repaired-path row reaches the activity sink with a null channel", async () => {
    tagAc(`${AC}/ac-27`);
    // Re-run every repaired write under this Spec's memex, then assert that none of
    // the touched source rows nor their activity_log entries carry a null channel.
    // A revert to mutate({}) would null the source-row channel (silent 'server'),
    // which this guard catches.
    const ctx: RequestCtx = { actorUserId: actor.user.id, channel: "rest_ui" };

    const issue = await createIssue({
      memexId: actor.memexId,
      docId,
      title: "Guard convert",
      body: "b",
      type: "todo",
    });
    const conv = await convertIssueToTask(actor.memexId, issue.id, ctx);

    const dec = await createDecision(actor.memexId, docId, "guard reopen", "c", "human");
    await db.update(decisions).set({ status: "resolved" }).where(eq(decisions.id, dec.id));
    const reopened = await reopenDecision(actor.memexId, dec.id, ctx);

    const ac = await createAc(
      { memexId: actor.memexId, briefId: docId, kind: "implementation", statement: "guard accept" },
      ctx,
    );
    await setAcAcceptance(actor.memexId, ac.id, "Dakota", ctx);

    // Source rows: none may carry a null channel.
    const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, conv.task.id));
    const [convAcRow] = await db.select().from(acs).where(eq(acs.id, conv.acId));
    const [decRow] = await db.select().from(decisions).where(eq(decisions.id, reopened.id));
    const [acRow] = await db.select().from(acs).where(eq(acs.id, ac.id));
    for (const row of [taskRow, convAcRow, decRow, acRow]) {
      expect(row.channel).not.toBeNull();
    }

    // The activity sink itself: every activity_log row for this memex carries a
    // channel (the column is NOT NULL, but a missing ctx would silently stamp
    // 'server' — std-32 calls that a defect; here every repaired write is given a
    // real channel, so none should be the silent fallback for these entities).
    const logRows = await db
      .select({ channel: activityLog.channel, entity: activityLog.entity })
      .from(activityLog)
      .where(eq(activityLog.memexId, actor.memexId));
    for (const row of logRows) {
      expect(row.channel).toBeTruthy();
    }
  });
});
