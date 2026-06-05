import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, docComments, decisions, tasks } from "../db/schema.js";
import { bus, type ChangeEvent } from "./bus.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import { addSection, updateSection } from "./sections.js";
import { addComment, resolveComment } from "./comments.js";
import { createDecision, resolveDecision, reopenDecision } from "./decisions.js";
import { createTask, updateTaskStatus } from "./tasks.js";
import { makeTestMemex } from "./test-helpers.js";

/**
 * Integration tests verifying that service mutations emit change events on
 * the unified bus. Hits a real Postgres database and observes the in-process
 * bus subscribers — t-13 of doc-16 deleted the legacy `docEvents` EventEmitter
 * shim; this file is the runtime check that every doc-tree service path still
 * reaches subscribers via `bus.subscribe()`.
 */

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(docComments).where(
      eq(docComments.sectionId, (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db.select({ id: docSections.id }).from(docSections).where(eq(docSections.docId, id)) as any
      ))
    ).catch(() => {});
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(docSections).where(eq(docSections.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

/** Collect bus events emitted for `memexId` during the callback. */
async function collectEvents(memexId: string, fn: () => Promise<void>): Promise<ChangeEvent[]> {
  const events: ChangeEvent[] = [];
  const unsubscribe = bus.subscribe({ memexId }, (e) => events.push(e));
  try {
    await fn();
  } finally {
    unsubscribe();
  }
  return events;
}

let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("document service events (via bus)", () => {
  it("emits document:created on createDocDraft", async () => {
    const events = await collectEvents(memexId, async () => {
      const doc = await createDocDraft(memexId, "Event Test Doc", "Purpose");
      createdDocIds.push(doc.id);
    });

    expect(events).toHaveLength(1);
    expect(events[0].entity).toBe("document");
    expect(events[0].action).toBe("created");
  });

  it("emits document:updated on updateDocStatus", async () => {
    const doc = await createDocDraft(memexId, "Status Event Test", "Purpose");
    createdDocIds.push(doc.id);

    const events = await collectEvents(memexId, async () => {
      await updateDocStatus(memexId, doc.id, "review");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: memexId,
      docId: doc.id,
      entity: "document",
      action: "updated",
      narrative: expect.any(String),
    });
  });
});

describe("section service events (via bus)", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Section Event Test", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("emits section:created on addSection", async () => {
    const events = await collectEvents(memexId, async () => {
      await addSection(memexId, docId, "scope", "Scope content");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: memexId,
      docId,
      entity: "section",
      action: "created",
      narrative: expect.any(String),
    });
  });

  it("emits section:updated on updateSection", async () => {
    const section = await addSection(memexId, docId, "detail", "Original");

    const events = await collectEvents(memexId, async () => {
      await updateSection(memexId, section.id, "Updated content");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: memexId,
      docId,
      entity: "section",
      action: "updated",
      narrative: expect.any(String),
    });
  });
});

describe("comment service events (via bus)", () => {
  let docId: string;
  let sectionId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Comment Event Test", "Purpose");
    docId = doc.id;
    sectionId = doc.sections[0].id;
    createdDocIds.push(doc.id);
  });

  it("emits comment:created on addComment", async () => {
    const events = await collectEvents(memexId, async () => {
      await addComment(memexId, sectionId, "Tester", "Nice work");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: memexId,
      docId,
      entity: "comment",
      action: "created",
      narrative: expect.any(String),
    });
  });

  it("emits comment:updated on resolveComment", async () => {
    const comment = await addComment(memexId, sectionId, "Tester", "Needs fix");

    const events = await collectEvents(memexId, async () => {
      await resolveComment(memexId, comment.id, "Fixed");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: memexId,
      docId,
      entity: "comment",
      action: "updated",
      narrative: expect.any(String),
    });
  });
});

describe("decision service events (via bus)", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Decision Event Test", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("emits decision:created on createDecision", async () => {
    const events = await collectEvents(memexId, async () => {
      await createDecision(memexId, docId, "Use REST or gRPC?");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: memexId,
      docId,
      entity: "decision",
      action: "created",
      narrative: expect.any(String),
    });
  });

  it("emits decision:updated on resolveDecision", async () => {
    const dec = await createDecision(memexId, docId, "Which DB?");

    const events = await collectEvents(memexId, async () => {
      await resolveDecision(memexId, dec.id, "PostgreSQL");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: memexId,
      docId,
      entity: "decision",
      action: "updated",
      narrative: expect.any(String),
    });
  });

  it("emits decision:updated on reopenDecision", async () => {
    const dec = await createDecision(memexId, docId, "Reopen test");
    await resolveDecision(memexId, dec.id, "Initial choice");

    const events = await collectEvents(memexId, async () => {
      await reopenDecision(memexId, dec.id);
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: memexId,
      docId,
      entity: "decision",
      action: "updated",
      narrative: expect.any(String),
    });
  });
});

describe("task service events (via bus)", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Task Event Test", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("emits task:created on createTask", async () => {
    const events = await collectEvents(memexId, async () => {
      await createTask(memexId, docId, "Build feature", "Description");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: memexId,
      docId,
      entity: "task",
      action: "created",
      narrative: expect.any(String),
    });
  });

  it("emits task:updated on updateTaskStatus", async () => {
    const task = await createTask(memexId, docId, "Status test", "Description");

    const events = await collectEvents(memexId, async () => {
      await updateTaskStatus(memexId, task.id, "in_progress");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      memexId: memexId,
      docId,
      entity: "task",
      action: "updated",
      narrative: expect.any(String),
    });
  });
});
