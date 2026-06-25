// spec-259 ac-4 / dec-1 — comment resolution carries WHO + WHEN. REAL Postgres +
// REAL bus + sink, patterned on attribution.spec-244.integration.test.ts.
//
// ac-4 asks the resolution model audit "who resolved, when". Build grounding found
// resolveComment hardcoded mutate({}) — so WHO was dropped (activity_log row landed
// actor_user_id = null). t-6 threaded an explicit RequestCtx through resolveComment
// and the routed call sites (restCtx(c) / reqCtx(ctx)) per std-32. This test is the
// guard: resolve a comment with a rest_ui ctx and assert the activity_log row for
// the resolution carries the acting user (WHO) and the comment row carries
// resolved_at (WHEN). The denormalized doc_comments.resolved_by_user_id column is
// deferred (a follow-up Issue) — attribution rides the activity contract.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityLog, documents, decisions, tasks, docComments } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addComment, resolveComment } from "./comments.js";
import { upsertUserByEmail } from "./users.js";
import { actorCtx } from "./actor.js";
import { makeTestMemex } from "./test-helpers.js";
import {
  startActivityLogSink,
  _stopActivityLogSink,
} from "./activity-log.js";

const AC4 = "mindset-prod/memex-building-itself/specs/spec-259/acs/ac-4";

let memexId: string;
let userId: string;
let docId: string;
let user: Awaited<ReturnType<typeof upsertUserByEmail>>;

beforeAll(async () => {
  memexId = await makeTestMemex("comment-resolve-attrib");
  user = await upsertUserByEmail(`resolver-${Date.now()}@memex.ai`);
  userId = user.id;
  const spec = await createDocDraft(memexId, "Resolution attribution spec", "Purpose", "spec");
  docId = spec.id;
  startActivityLogSink();
});

afterAll(async () => {
  _stopActivityLogSink();
  await db.delete(activityLog).where(eq(activityLog.memexId, memexId)).catch(() => {});
  await db.delete(docComments).where(eq(docComments.memexId, memexId)).catch(() => {});
  await db.delete(tasks).where(eq(tasks.docId, docId)).catch(() => {});
  await db.delete(decisions).where(eq(decisions.docId, docId)).catch(() => {});
  await db.delete(documents).where(eq(documents.id, docId)).catch(() => {});
});

async function waitForResolveActivity(timeoutMs = 1500) {
  const start = Date.now();
  for (;;) {
    const rows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.memexId, memexId),
          eq(activityLog.entity, "comment"),
          eq(activityLog.action, "updated"),
        ),
      );
    if (rows.length > 0 || Date.now() - start > timeoutMs) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("comment resolution attribution (spec-259 ac-4)", () => {
  it("resolveComment with a rest_ui ctx records WHO (actor_user_id) and WHEN (resolved_at)", async () => {
    tagAc(AC4);
    // createDocDraft seeds the overview section; anchor an open comment to it.
    const sections = await db.query.docSections.findMany({
      where: (s, { eq: eqs }) => eqs(s.docId, docId),
    });
    expect(sections.length).toBeGreaterThan(0);
    const created = await addComment(memexId, sections[0].id, "barrie hadfield", "please address", {
      type: "question",
    });
    expect(created.resolvedAt).toBeNull();

    // Resolve it as an authenticated REST user.
    const ctx = actorCtx(user, "rest_ui");
    const resolved = await resolveComment(memexId, created.id, "acknowledged", ctx);

    // WHEN: resolved_at stamped.
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedAt).toBeInstanceOf(Date);

    // WHO: the resolution's activity_log row carries the acting user + human kind.
    const rows = await waitForResolveActivity();
    expect(rows.length).toBeGreaterThan(0);
    const resolveRow = rows[rows.length - 1];
    expect(resolveRow.actorUserId).toBe(userId);
    expect(resolveRow.actorKind).toBe("human");
  });
});
