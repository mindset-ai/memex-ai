import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docMembers } from "../db/schema.js";
import { createDocDraft, getDoc } from "./documents.js";
import { resolveRole, listEditors, promoteToEditor, demoteToReviewer } from "./doc-members.js";
import { upsertUserByEmail } from "./users.js";
import { makeTestMemex } from "./test-helpers.js";
import { bus, type ChangeEvent } from "./bus.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-118/acs/ac-${n}`;

const createdDocIds: string[] = [];
afterAll(async () => {
  for (const id of createdDocIds) {
    // ON DELETE CASCADE clears the doc_members rows with the Spec.
    await db.delete(documents).where(eq(documents.id, id));
  }
});

let memexId: string;
let human: { id: string };
let other: { id: string };
beforeAll(async () => {
  memexId = await makeTestMemex();
  human = await upsertUserByEmail("spec118-creator@example.com");
  other = await upsertUserByEmail("spec118-other@example.com");
});

async function memberCount(docId: string): Promise<number> {
  const rows = await db.select().from(docMembers).where(eq(docMembers.docId, docId));
  return rows.length;
}

describe("spec-118 creator-as-first-editor seeding", () => {
  it("createDocDraft seeds exactly one editor row for createdByUserId (ac-13)", async () => {
    tagAc(AC(13));
    const doc = await createDocDraft(memexId, "Seeded Spec", "purpose", "spec", undefined, undefined, human.id);
    createdDocIds.push(doc.id);

    const editors = await listEditors(memexId, doc.id);
    expect(editors).toHaveLength(1);
    expect(editors[0]!.userId).toBe(human.id);
    expect(editors[0]!.role).toBe("editor");
    expect(await resolveRole(memexId, doc.id, human.id)).toBe("editor");
  });

  it("createDocDraft with no createdByUserId seeds NO editor row (ac-13)", async () => {
    tagAc(AC(13));
    const doc = await createDocDraft(memexId, "Anon Spec", "purpose", "spec");
    createdDocIds.push(doc.id);
    expect(await memberCount(doc.id), "a Spec with no human caller starts with zero editors").toBe(0);
  });

  it("a Spec created via the createDoc path records the human caller (token owner), not an agent (ac-14)", async () => {
    tagAc(AC(14));
    // The MCP create path passes the authenticated token's userId as createdByUserId.
    // There is no separate agent principal — the row records that human.
    const doc = await createDocDraft(memexId, "MCP Spec", "purpose", "spec", undefined, undefined, human.id);
    createdDocIds.push(doc.id);
    const row = await db.query.docMembers.findFirst({
      where: and(eq(docMembers.docId, doc.id), eq(docMembers.role, "editor")),
    });
    expect(row?.userId).toBe(human.id);
  });
});

describe("spec-118 implicit reviewer default + role-blind reads", () => {
  it("a member with no row resolves to 'reviewer', and reading a Spec inserts no row (ac-17)", async () => {
    tagAc(AC(17));
    const doc = await createDocDraft(memexId, "Reviewer Default Spec", "purpose", "spec", undefined, undefined, human.id);
    createdDocIds.push(doc.id);

    // `other` has no row → reviewer.
    expect(await resolveRole(memexId, doc.id, other.id)).toBe("reviewer");

    // Reading the Spec must not write a doc_members row (only the creator's editor row exists).
    const before = await memberCount(doc.id);
    await getDoc(memexId, doc.id);
    await getDoc(memexId, doc.handle);
    const after = await memberCount(doc.id);
    expect(after, "reading a Spec must not insert a doc_members row").toBe(before);
    expect(after).toBe(1); // just the creator's editor row
  });

  it("the read payload is identical regardless of role — reviewers see every field an editor sees (ac-9)", async () => {
    tagAc(AC(9));
    const doc = await createDocDraft(
      memexId,
      "Full Payload Spec",
      "the overview body",
      "spec",
      [{ title: "A decision", context: "ctx" }],
      { bodySections: [{ title: "Design", content: "design body" }], acceptanceCriteria: "do the thing" },
      human.id,
    );
    createdDocIds.push(doc.id);

    // getDoc takes NO role/user argument — the read path cannot branch on role, so an
    // editor (human) and a reviewer (other) receive the same bytes by construction.
    // Assert the full payload is present and that role resolution differs while the
    // payload does not.
    expect(await resolveRole(memexId, doc.id, human.id)).toBe("editor");
    expect(await resolveRole(memexId, doc.id, other.id)).toBe("reviewer");

    const payload = await getDoc(memexId, doc.id);
    // Full content surfaces: overview + body section + acceptance section all present.
    expect(payload.sections.length).toBeGreaterThanOrEqual(3);
    const sectionTypes = payload.sections.map((s) => s.sectionType);
    expect(sectionTypes).toContain("overview");
    expect(sectionTypes).toContain("body-1");
    expect(sectionTypes).toContain("acceptance");
  });
});

// Collect bus events for a memex across a body, then unsubscribe.
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

describe("spec-118 promote / demote (frictionless, reversible, no last-editor lock)", () => {
  it("self-promote inserts an editor row and self-demote removes it, each one call, no confirmation (ac-15)", async () => {
    tagAc(AC(15));
    const doc = await createDocDraft(memexId, "Self Promote Spec", "purpose", "spec");
    createdDocIds.push(doc.id);

    // `other` starts as an implicit reviewer (no row).
    expect(await resolveRole(memexId, doc.id, other.id)).toBe("reviewer");

    // One call promotes — no confirmation gate in the service.
    const promoted = await promoteToEditor(memexId, doc.id, other.id);
    expect(promoted.role).toBe("editor");
    expect(await resolveRole(memexId, doc.id, other.id)).toBe("editor");

    // Idempotent: promoting again is a no-op that still returns the editor row.
    const again = await promoteToEditor(memexId, doc.id, other.id);
    expect(again.role).toBe("editor");
    expect((await listEditors(memexId, doc.id)).filter((m) => m.userId === other.id)).toHaveLength(1);

    // One call demotes back to the implicit reviewer default.
    await demoteToReviewer(memexId, doc.id, other.id);
    expect(await resolveRole(memexId, doc.id, other.id)).toBe("reviewer");
  });

  it("promote emits doc_member created and demote emits doc_member deleted on the bus", async () => {
    tagAc(AC(15));
    const doc = await createDocDraft(memexId, "Bus Spec", "purpose", "spec");
    createdDocIds.push(doc.id);

    const events = await captureEvents(memexId, async () => {
      await promoteToEditor(memexId, doc.id, other.id);
      await demoteToReviewer(memexId, doc.id, other.id);
    });
    const mine = events.filter((e) => e.docId === doc.id && e.entity === "doc_member");
    expect(mine.map((e) => e.action)).toEqual(["created", "deleted"]);
  });

  it("a teammate can promote another member, and demoting the LAST editor succeeds (zero editors allowed) (ac-16)", async () => {
    tagAc(AC(16));
    // Creator (human) is the sole editor.
    const doc = await createDocDraft(memexId, "Last Editor Spec", "purpose", "spec", undefined, undefined, human.id);
    createdDocIds.push(doc.id);
    expect(await resolveRole(memexId, doc.id, human.id)).toBe("editor");

    // A teammate (other) promotes a third member — any org member may act on another.
    const third = await upsertUserByEmail("spec118-third@example.com");
    await promoteToEditor(memexId, doc.id, third.id);
    expect(await resolveRole(memexId, doc.id, third.id)).toBe("editor");

    // Demote BOTH editors — removing the final editor must succeed (no last-editor lock).
    await demoteToReviewer(memexId, doc.id, human.id);
    await demoteToReviewer(memexId, doc.id, third.id);
    expect(await listEditors(memexId, doc.id)).toHaveLength(0);
    expect(await resolveRole(memexId, doc.id, human.id)).toBe("reviewer");
  });
});

const AC_199 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-199/acs/ac-${n}`;

describe("spec-199 Finding #1 — email stripped from non-member/anonymous path (ac-1)", () => {
  it("listEditors with includeEmail=false returns null email for every editor", async () => {
    tagAc(AC_199(1));
    const doc = await createDocDraft(memexId, "Email Strip Test", "purpose", "spec", undefined, undefined, human.id);
    createdDocIds.push(doc.id);

    const editors = await listEditors(memexId, doc.id, false);
    expect(editors.length).toBeGreaterThan(0);
    for (const e of editors) {
      expect(e.email, "email must be null on the anonymous/non-member path").toBeNull();
    }
  });

  it("listEditors with includeEmail=true (default) returns email for authenticated org members", async () => {
    tagAc(AC_199(1));
    const doc = await createDocDraft(memexId, "Email Present Test", "purpose", "spec", undefined, undefined, human.id);
    createdDocIds.push(doc.id);

    const editors = await listEditors(memexId, doc.id, true);
    expect(editors.length).toBeGreaterThan(0);
    for (const e of editors) {
      expect(e.email, "email must be present for authenticated org members").not.toBeNull();
    }
  });
});
