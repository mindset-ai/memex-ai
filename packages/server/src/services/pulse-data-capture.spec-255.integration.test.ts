// spec-255 — data-capture fixes surfaced while reviewing Pulse on int:
//   1. promoteToEditor must NOT emit on an idempotent re-promote (std-32: an
//      activity event reflects a REAL change). spec-189 traffic-promotion fires
//      it on every agent turn, so a no-op re-promote spammed "promoted X to
//      editor" into the feed.
//   2. An in_app_agent tool call must mark the actor PRESENT, so Pulse's
//      "active now" reflects in-app agents (the telemetry floor only sees the
//      MCP surface, so conversing with the in-app agent showed 0 active).

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { promoteToEditor } from "./doc-members.js";
import { listPresent } from "./presence.js";
import { observeSpecTraffic } from "./spec-traffic.js";
import { upsertUserByEmail } from "./users.js";
import { makeTestMemex } from "./test-helpers.js";
import { bus, type ChangeEvent } from "./bus.js";

const createdDocIds: string[] = [];
afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});

let memexId: string;
let human: { id: string };
let other: { id: string };
beforeAll(async () => {
  memexId = await makeTestMemex();
  human = await upsertUserByEmail("spec255-creator@example.com");
  other = await upsertUserByEmail("spec255-other@example.com");
});

async function captureEvents(mx: string, body: () => Promise<void>): Promise<ChangeEvent[]> {
  const events: ChangeEvent[] = [];
  const unsub = bus.subscribe({ memexId: mx }, (e) => events.push(e));
  try {
    await body();
  } finally {
    unsub();
  }
  return events;
}

describe("spec-255 — no-op promote does not emit", () => {
  it("re-promoting an existing editor emits NO doc_member event; a new editor emits exactly one", async () => {
    // createDocDraft seeds the creator (human) as the first editor.
    const doc = await createDocDraft(memexId, "Promote no-op", "purpose", "spec", undefined, undefined, human.id);
    createdDocIds.push(doc.id);

    const events = await captureEvents(memexId, async () => {
      // human is ALREADY an editor → no-op → silent (no event).
      await promoteToEditor(memexId, doc.id, human.id, { channel: "in_app_agent", actorUserId: human.id });
      // other is NOT an editor → real promotion → exactly one event.
      await promoteToEditor(memexId, doc.id, other.id, { channel: "in_app_agent", actorUserId: human.id });
    });

    const memberEvents = events.filter((e) => e.entity === "doc_member");
    expect(memberEvents).toHaveLength(1);
    expect(memberEvents[0]!.docId).toBe(doc.id);
  });
});

describe("spec-255 — in_app_agent traffic marks presence", () => {
  it("an in_app_agent tool call registers an in_app_agent presence row (active-now sees in-app agents)", async () => {
    const doc = await createDocDraft(memexId, "Presence in-app", "purpose", "spec", undefined, undefined, human.id);
    createdDocIds.push(doc.id);

    await observeSpecTraffic({
      toolName: "create_task",
      channel: "in_app_agent",
      memexId,
      docId: doc.id,
      userId: human.id,
    });

    const present = await listPresent(memexId, doc.id);
    const inApp = present.find((p) => p.channel === "in_app_agent" && p.actorUserId === human.id);
    expect(inApp).toBeTruthy();
    expect(inApp!.actorKind).toBe("in_app_agent");
  });
});
