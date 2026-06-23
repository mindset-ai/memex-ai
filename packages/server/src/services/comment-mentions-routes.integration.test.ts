import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docComments, commentMentions, orgMemberships, users } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addComment } from "./comments.js";
import { upsertUserByEmail } from "./users.js";
import { searchMentionableMembers } from "./users.js";
import { getOrgIdForMemex } from "./memexes.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

// Keep notification emails inert + silent during seeding.
const send = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./email/sender.js", () => ({ getEmailSender: () => ({ send }) }));

// Imported AFTER the mock so the test-surface route's service uses the stub.
const { testOnlyRouter } = await import("../routes/__test__.js");

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-320/acs/ac-${n}`;

const createdDocIds: string[] = [];
afterAll(async () => {
  for (const id of createdDocIds) await db.delete(documents).where(eq(documents.id, id));
});

let memexId: string;
let orgId: string;

async function addMember(email: string, name: string, status: "active" | "disabled" = "active") {
  const u = await upsertUserByEmail(email);
  await db.update(users).set({ name }).where(eq(users.id, u.id));
  await db
    .insert(orgMemberships)
    .values({ userId: u.id, orgId, role: "member", status })
    .onConflictDoNothing();
  return u;
}

beforeAll(async () => {
  memexId = await makeTestMemex("spec320routes");
  orgId = (await getOrgIdForMemex(memexId))!;
  await addMember("spec320-harriet@example.com", "Harriet");
  await addMember("spec320-harry@example.com", "Harry");
  await addMember("spec320-sarah@example.com", "Sarah"); // contains 'h' mid-name
  await addMember("spec320-diego@example.com", "Diego"); // no 'h'
  await addMember("spec320-harmon@example.com", "Harmon", "disabled"); // 'h' but disabled
});

async function makeComment(): Promise<string> {
  const doc = await createDocDraft(memexId, "Routes Spec", "purpose", "spec");
  createdDocIds.push(doc.id);
  const c = await addComment(memexId, doc.sections[0]!.id, "Author", "comment");
  return c.id;
}

describe("spec-320 member-search powers the @-typeahead (ac-5, ac-10)", () => {
  it("matches active members by SUBSTRING on name or email; excludes disabled; bare query returns the roster", async () => {
    tagAc(AC(5));
    tagAc(AC(10));

    const h = await searchMentionableMembers(orgId, "h");
    const hNames = h.map((m) => m.name);
    // Substring, not prefix: 'h' matches Harriet, Harry AND Sarah (mid-name 'h').
    expect(hNames).toEqual(expect.arrayContaining(["Harriet", "Harry", "Sarah"]));
    // Active-only: the disabled "Harmon" is excluded despite the 'h'.
    expect(hNames).not.toContain("Harmon");
    // Non-matching active member excluded.
    expect(hNames).not.toContain("Diego");

    // Prefix subset still works.
    const harr = await searchMentionableMembers(orgId, "harr");
    expect(harr.map((m) => m.name).sort()).toEqual(["Harriet", "Harry"]);

    // Bare query → the active roster (composer opens on `@`), still excluding disabled.
    const roster = await searchMentionableMembers(orgId, "");
    const rosterNames = roster.map((m) => m.name);
    expect(rosterNames).toEqual(expect.arrayContaining(["Harriet", "Harry", "Sarah", "Diego"]));
    expect(rosterNames).not.toContain("Harmon");
  });
});

describe("spec-320 env-gated test surface seeds mentions + assignee (ac-11)", () => {
  it("POST /seed-comment-mention writes a mention row; POST /set-comment-assignee sets the assignee", async () => {
    tagAc(AC(11));
    const commentId = await makeComment();

    const mentionRes = await testOnlyRouter.request("/seed-comment-mention", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        memexId,
        commentId,
        userEmail: "spec320-harriet@example.com",
        mentionedByEmail: "spec320-harry@example.com",
      }),
    });
    expect(mentionRes.status).toBe(200);

    const harriet = await upsertUserByEmail("spec320-harriet@example.com");
    const mentionRows = await db
      .select()
      .from(commentMentions)
      .where(eq(commentMentions.commentId, commentId));
    expect(mentionRows.map((m) => m.userId)).toContain(harriet.id);

    const assignRes = await testOnlyRouter.request("/set-comment-assignee", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        memexId,
        commentId,
        assigneeEmail: "spec320-sarah@example.com",
        assignedByEmail: "spec320-harry@example.com",
      }),
    });
    expect(assignRes.status).toBe(200);

    const sarah = await upsertUserByEmail("spec320-sarah@example.com");
    const row = await db.query.docComments.findFirst({ where: eq(docComments.id, commentId) });
    expect(row?.assigneeUserId).toBe(sarah.id);
    // assignee ⊆ mentions: sarah is also a mention row now.
    const after = await db.select().from(commentMentions).where(eq(commentMentions.commentId, commentId));
    expect(after.map((m) => m.userId)).toContain(sarah.id);
  });
});
