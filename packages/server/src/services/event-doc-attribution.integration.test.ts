// spec-306 — document attribution on back-end outcome events, end to end.
// REAL Postgres + REAL bus + the back-end usage sink + the activity-log sink.
//
// Exercises each of the five whitelisted outcomes through its real service and
// asserts the resulting usage_events.props (and the activity_log payload) carry
// { doc_id, doc_type } — the opaque UUID + enum, no handle/slug.
//
//  - ac-6  : a forwarded/persisted event row carries doc_id + doc_type.
//  - ac-7  : no handle / namespace / slug / qualified ref in the props.
//  - ac-9  : the 4 doc-child events attribute their PARENT Spec (event.docId).
//  - ac-10 : document.created attributes the new document itself.
//  - ac-12 : the same payload lands on the activity_log row for these events.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { usageEvents, activityLog } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import { createTask } from "./tasks.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { getOrCreateConversation, appendMessage } from "./conversations.js";
import { startUsageBackendSink, _stopUsageBackendSink } from "./usage-backend-sink.js";
import { startActivityLogSink, _stopActivityLogSink } from "./activity-log.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-306/acs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let memexId: string;
let userId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("docattr");
  const u = await upsertUserByEmail(`docattr-${Date.now()}@example.com`);
  userId = u.id;
  startUsageBackendSink();
  startActivityLogSink();
});

afterAll(async () => {
  _stopUsageBackendSink();
  _stopActivityLogSink();
  await db.delete(usageEvents).where(eq(usageEvents.memexId, memexId));
});

// usage_events rows are written ASYNCHRONOUSLY by the bus sink — poll until the
// row whose props.doc_id matches the doc we acted on has landed.
async function waitForRow(
  name: string,
  docId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.memexId, memexId), eq(usageEvents.name, name)));
    const hit = rows.find(
      (r) => r.props && (r.props as Record<string, unknown>).doc_id === docId,
    );
    if (hit) return hit.props as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

// Every attribution prop must be an opaque id/enum — never a handle or slug (ac-7).
function expectNoLeak(props: Record<string, unknown>): void {
  expect(props.doc_id).toMatch(UUID_RE);
  for (const v of Object.values(props)) {
    const s = String(v);
    expect(s).not.toMatch(/^[a-z]+-\d+$/i); // no handle like spec-42
    expect(s).not.toContain("/"); // no namespace / Memex slug / qualified ref
  }
}

describe("doc-child outcome events attribute their parent Spec (spec-306 ac-9/ac-6)", () => {
  it("task.created carries the parent Spec's doc_id + doc_type", async () => {
    tagAc(`${AC}/ac-9`);
    tagAc(`${AC}/ac-6`);
    tagAc(`${AC}/ac-7`);
    // scope ACs this end-to-end check also evidences:
    tagAc(`${AC}/ac-1`); // task.created carries a property identifying its Spec
    tagAc(`${AC}/ac-4`); // attribution applied to a doc-child event (consistency)
    tagAc(`${AC}/ac-5`); // the property lands in usage_events.props → Mixpanel-queryable
    const doc = await createDocDraft(memexId, "Task parent", "p", "spec", undefined, undefined, userId, { actorUserId: userId, channel: "rest_ui" });
    await createTask(memexId, doc.id, "T", "do it", undefined, undefined, { actorUserId: userId, channel: "rest_ui" });
    const props = await waitForRow("task.created", doc.id);
    expect(props, "task.created usage row with doc_id should land").toBeDefined();
    expect(props!.doc_id).toBe(doc.id);
    expect(props!.doc_type).toBe("spec");
    expectNoLeak(props!);
  });

  it("decision.resolved carries the parent Spec's doc_id + doc_type", async () => {
    tagAc(`${AC}/ac-9`);
    tagAc(`${AC}/ac-6`);
    const doc = await createDocDraft(memexId, "Decision parent", "p", "spec", undefined, undefined, userId, { actorUserId: userId, channel: "rest_ui" });
    const dec = await createDecision(memexId, doc.id, "A choice", "ctx", "human", { actorUserId: userId, channel: "rest_ui" });
    await resolveDecision(memexId, dec.id, "Chose the thing", undefined, { actorUserId: userId, channel: "rest_ui" });
    const props = await waitForRow("decision.resolved", doc.id);
    expect(props, "decision.resolved usage row with doc_id should land").toBeDefined();
    expect(props!.doc_id).toBe(doc.id);
    expect(props!.doc_type).toBe("spec");
    expectNoLeak(props!);
  });

  it("document.status_changed carries doc_id + doc_type alongside {from,to}", async () => {
    tagAc(`${AC}/ac-9`);
    tagAc(`${AC}/ac-6`);
    const doc = await createDocDraft(memexId, "Phase doc", "p", "spec", undefined, undefined, userId, { actorUserId: userId, channel: "rest_ui" });
    await updateDocStatus(memexId, doc.id, "specify", { ctx: { actorUserId: userId, channel: "rest_ui" } });
    const props = await waitForRow("document.status_changed", doc.id);
    expect(props, "document.status_changed usage row with doc_id should land").toBeDefined();
    expect(props!.doc_id).toBe(doc.id);
    expect(props!.doc_type).toBe("spec");
    expect(props!.to).toBe("specify"); // the existing {from,to} payload is preserved
    expectNoLeak(props!);
  });

  it("conversation_message.created carries the parent Spec's doc_id + doc_type", async () => {
    tagAc(`${AC}/ac-9`);
    tagAc(`${AC}/ac-6`);
    const doc = await createDocDraft(memexId, "Chat doc", "p", "spec", undefined, undefined, userId, { actorUserId: userId, channel: "rest_ui" });
    const convo = await getOrCreateConversation(memexId, doc.id, userId);
    await appendMessage(convo.id, "user", "hello");
    const props = await waitForRow("conversation_message.created", doc.id);
    expect(props, "conversation_message.created usage row with doc_id should land").toBeDefined();
    expect(props!.doc_id).toBe(doc.id);
    expect(props!.doc_type).toBe("spec");
    expectNoLeak(props!);
  });
});

describe("document.created attributes the new document itself (spec-306 ac-10)", () => {
  it("carries doc_id = the new document's own id and its doc_type", async () => {
    tagAc(`${AC}/ac-10`);
    tagAc(`${AC}/ac-6`);
    // scope ACs this also evidences:
    tagAc(`${AC}/ac-3`); // additive — the event still fires, only gains props (no new event name)
    tagAc(`${AC}/ac-4`); // attribution applied to document.created too (consistency across all in-scope events)
    const doc = await createDocDraft(memexId, "Self doc", "p", "standard", undefined, undefined, userId, { actorUserId: userId, channel: "rest_ui" });
    const props = await waitForRow("document.created", doc.id);
    expect(props, "document.created usage row with its own doc_id should land").toBeDefined();
    expect(props!.doc_id).toBe(doc.id);
    expect(props!.doc_type).toBe("standard");
    expectNoLeak(props!);
  });
});

describe("the same attribution lands on the activity_log row (spec-306 ac-12)", () => {
  it("task.created activity_log payload carries doc_id + doc_type, ID+enum only", async () => {
    tagAc(`${AC}/ac-12`);
    const doc = await createDocDraft(memexId, "Activity doc", "p", "spec", undefined, undefined, userId, { actorUserId: userId, channel: "rest_ui" });
    await createTask(memexId, doc.id, "T2", "do it", undefined, undefined, { actorUserId: userId, channel: "rest_ui" });

    let payload: Record<string, unknown> | undefined;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.memexId, memexId),
            eq(activityLog.entity, "task"),
            eq(activityLog.action, "created"),
          ),
        );
      payload = rows
        .map((r) => r.payload as Record<string, unknown> | null)
        .find((p) => p && p.doc_id === doc.id) as Record<string, unknown> | undefined;
      if (payload) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(payload, "activity_log row should carry the doc_id payload").toBeDefined();
    expect(payload!.doc_id).toBe(doc.id);
    expect(payload!.doc_type).toBe("spec");
    expectNoLeak(payload!);
  });
});
