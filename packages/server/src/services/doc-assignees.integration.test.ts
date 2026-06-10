import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docMembers } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { assign, unassign, listAssignees, listDocIdsAssignedToUser } from "./doc-assignees.js";
import { resolveRole } from "./doc-members.js";
import { upsertUserByEmail } from "./users.js";
import { makeTestMemex } from "./test-helpers.js";
import { bus, type ChangeEvent } from "./bus.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-118/acs/ac-${n}`;

const createdDocIds: string[] = [];
afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});

let memexId: string;
let alice: { id: string };
let bob: { id: string };
let actor: { id: string };
beforeAll(async () => {
  memexId = await makeTestMemex();
  alice = await upsertUserByEmail("spec118-assignee-a@example.com");
  bob = await upsertUserByEmail("spec118-assignee-b@example.com");
  actor = await upsertUserByEmail("spec118-assigner@example.com");
});

async function captureEvents(memexId: string, body: () => Promise<void>): Promise<ChangeEvent[]> {
  const events: ChangeEvent[] = [];
  const unsub = bus.subscribe({ memexId }, (e) => events.push(e));
  try {
    await body();
  } finally {
    unsub();
  }
  return events;
}

describe("spec-118 assignment is independent of role (ac-12)", () => {
  it("a Spec supports multiple assignees; assign is idempotent and unassign removes one", async () => {
    tagAc(AC(12));
    const doc = await createDocDraft(memexId, "Assign Spec", "purpose", "spec");
    createdDocIds.push(doc.id);

    await assign(memexId, doc.id, alice.id, actor.id);
    await assign(memexId, doc.id, bob.id, actor.id);
    expect(await listAssignees(memexId, doc.id)).toHaveLength(2);

    // Idempotent: re-assigning alice does not duplicate.
    await assign(memexId, doc.id, alice.id, actor.id);
    expect(await listAssignees(memexId, doc.id)).toHaveLength(2);

    await unassign(memexId, doc.id, alice.id);
    const remaining = await listAssignees(memexId, doc.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.userId).toBe(bob.id);
  });

  it("assigning a reviewer does NOT create a doc_members editor row — role is unchanged (ac-12)", async () => {
    tagAc(AC(12));
    const doc = await createDocDraft(memexId, "Assign Reviewer Spec", "purpose", "spec");
    createdDocIds.push(doc.id);

    // alice is an implicit reviewer (no row).
    expect(await resolveRole(memexId, doc.id, alice.id)).toBe("reviewer");
    await assign(memexId, doc.id, alice.id, actor.id);

    // Still a reviewer; no doc_members row was created by the assignment.
    expect(await resolveRole(memexId, doc.id, alice.id)).toBe("reviewer");
    const memberRows = await db
      .select()
      .from(docMembers)
      .where(and(eq(docMembers.docId, doc.id), eq(docMembers.userId, alice.id)));
    expect(memberRows, "assignment must not write a doc_members row").toHaveLength(0);
  });

  it("listDocIdsAssignedToUser backs the 'assigned to me' filter", async () => {
    tagAc(AC(12));
    const doc = await createDocDraft(memexId, "Assigned-To-Me Spec", "purpose", "spec");
    createdDocIds.push(doc.id);
    await assign(memexId, doc.id, alice.id, actor.id);
    const ids = await listDocIdsAssignedToUser(memexId, alice.id);
    expect(ids).toContain(doc.id);
  });
});

describe("spec-118 assignment emits on the unified bus (ac-20)", () => {
  it("assign and unassign each go through mutate() and emit a doc_assignee event", async () => {
    tagAc(AC(20));
    const doc = await createDocDraft(memexId, "Assign Bus Spec", "purpose", "spec");
    createdDocIds.push(doc.id);

    const events = await captureEvents(memexId, async () => {
      await assign(memexId, doc.id, bob.id, actor.id);
      await unassign(memexId, doc.id, bob.id);
    });
    const mine = events.filter((e) => e.docId === doc.id && e.entity === "doc_assignee");
    expect(mine.map((e) => e.action)).toEqual(["created", "deleted"]);
  });
});

const AC_199 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-199/acs/ac-${n}`;

describe("spec-199 Finding #1 — email stripped from non-member/anonymous path (ac-1)", () => {
  it("listAssignees with includeEmail=false returns null email for every assignee", async () => {
    tagAc(AC_199(1));
    const doc = await createDocDraft(memexId, "Assignee Email Strip Test", "purpose", "spec");
    createdDocIds.push(doc.id);
    await assign(memexId, doc.id, alice.id, actor.id);

    const assignees = await listAssignees(memexId, doc.id, false);
    expect(assignees.length).toBeGreaterThan(0);
    for (const a of assignees) {
      expect(a.email, "email must be null on the anonymous/non-member path").toBeNull();
    }
  });

  it("listAssignees with includeEmail=true (default) returns email for authenticated org members", async () => {
    tagAc(AC_199(1));
    const doc = await createDocDraft(memexId, "Assignee Email Present Test", "purpose", "spec");
    createdDocIds.push(doc.id);
    await assign(memexId, doc.id, alice.id, actor.id);

    const assignees = await listAssignees(memexId, doc.id, true);
    expect(assignees.length).toBeGreaterThan(0);
    for (const a of assignees) {
      expect(a.email, "email must be present for authenticated org members").not.toBeNull();
    }
  });
});
