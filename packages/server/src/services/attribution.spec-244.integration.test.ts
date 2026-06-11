// Attribution guard (spec-244 t-4 / dec-6) — REAL Postgres + REAL bus + sink.
//
// dec-6 set out to make "every UI action attributable to the person who did it".
// Grounding in build found spec-122 already threaded RequestCtx through the routed
// user-action paths (task / decision / ac create, doc status), so the routes pass
// restCtx(c) → mutate(ctx) and the actor lands. This test is the GUARD that proves
// the property holds end-to-end and pins it against regression: drive user-
// initiated mutations with a rest_ui ctx and assert the activity_log row carries
// the acting user (actor_user_id) and a non-'system' actor_kind, with the
// unattributed-mutation defect counter staying at zero.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityLog, documents } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { actorCtx } from "./actor.js";
import { createTask } from "./tasks.js";
import { createDecision } from "./decisions.js";
import {
  startActivityLogSink,
  _stopActivityLogSink,
  getUnattributedMutationCount,
  _resetUnattributedMutationCount,
} from "./activity-log.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-244/acs";

let memexId: string;
let userId: string;
let docId: string;
let user: Awaited<ReturnType<typeof upsertUserByEmail>>;

beforeAll(async () => {
  memexId = await makeTestMemex("attrib");
  user = await upsertUserByEmail(`attrib-${Date.now()}@memex.ai`);
  userId = user.id;
  const [doc] = await db
    .insert(documents)
    .values({
      memexId,
      handle: `spec-${Date.now().toString(36)}`,
      title: "Attribution guard spec",
      docType: "spec",
    })
    .returning();
  docId = doc.id;
  startActivityLogSink();
});

afterAll(async () => {
  _stopActivityLogSink();
  await db.delete(activityLog).where(eq(activityLog.memexId, memexId));
});

async function waitForActivity(entity: string, timeoutMs = 1500) {
  const start = Date.now();
  for (;;) {
    const rows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.memexId, memexId), eq(activityLog.entity, entity)));
    if (rows.length > 0 || Date.now() - start > timeoutMs) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("attribution — user-initiated mutations carry the acting user (ac-9 / ac-17)", () => {
  it("a rest_ui task + decision create persist with actor_user_id and actor_kind='human'", async () => {
    tagAc(`${AC}/ac-9`);
    tagAc(`${AC}/ac-17`);
    _resetUnattributedMutationCount();
    const ctx = actorCtx(user, "rest_ui");

    await createTask(memexId, docId, "Guard task", "desc", [], undefined, ctx);
    await createDecision(memexId, docId, "Guard decision", undefined, "human", ctx);

    const taskRow = (await waitForActivity("task"))[0];
    expect(taskRow).toBeDefined();
    expect(taskRow.actorUserId).toBe(userId);
    expect(taskRow.actorKind).toBe("human");

    const decRow = (await waitForActivity("decision"))[0];
    expect(decRow).toBeDefined();
    expect(decRow.actorUserId).toBe(userId);
    expect(decRow.actorKind).toBe("human");

    // No attribution-bearing mutation reached the sink channel-less (ac-21 / dec-6):
    // the user-initiated writes above are all fully attributed.
    expect(getUnattributedMutationCount()).toBe(0);
  });
});
