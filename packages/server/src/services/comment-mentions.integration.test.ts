import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docComments, commentMentions } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addComment, resolveComment } from "./comments.js";
import { upsertUserByEmail } from "./users.js";
import { makeTestMemex } from "./test-helpers.js";
import { bus, type ChangeEvent } from "./bus.js";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  addMentions,
  assignComment,
  unassignComment,
  listCommentsMentioningUser,
  listOpenAssignmentsForUser,
  listMentionsForComments,
} from "./comment-mentions.js";

// Email sender is fire-and-forget; stub it so no real send is attempted and we can
// assert HOW MANY notifications go out (dec-3: one mention email, one assignment email).
const send = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./email/sender.js", () => ({ getEmailSender: () => ({ send }) }));

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-320/acs/ac-${n}`;

const createdDocIds: string[] = [];
afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});

let memexId: string;
let alice: { id: string };
let bob: { id: string };
let carol: { id: string };
let actor: { id: string };

beforeAll(async () => {
  memexId = await makeTestMemex();
  alice = await upsertUserByEmail("spec320-mention-a@example.com");
  bob = await upsertUserByEmail("spec320-mention-b@example.com");
  carol = await upsertUserByEmail("spec320-mention-c@example.com");
  actor = await upsertUserByEmail("spec320-actor@example.com");
});

async function makeComment(): Promise<{ id: string; docId: string; seq: number }> {
  const doc = await createDocDraft(memexId, "Mention Spec", "purpose", "spec");
  createdDocIds.push(doc.id);
  const sectionId = doc.sections[0]!.id;
  const comment = await addComment(memexId, sectionId, "Author", "A comment to call people out on");
  return { id: comment.id, docId: comment.docId, seq: comment.seq };
}

async function captureEvents(body: () => Promise<void>): Promise<ChangeEvent[]> {
  const events: ChangeEvent[] = [];
  const unsub = bus.subscribe({ memexId }, (e) => events.push(e));
  try {
    await body();
  } finally {
    unsub();
  }
  return events;
}

const ctx = () => ({ actorUserId: actor.id, channel: "rest_ui" as const });

describe("spec-320 comment_mentions table shape (ac-6, ac-7)", () => {
  it("comment_mentions has the unique + user_id index; doc_comments has the assignee columns + partial index", async () => {
    tagAc(AC(6));
    tagAc(AC(7));

    const cols = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'comment_mentions'
    `)) as unknown as { column_name: string }[];
    const colNames = cols.map((c) => c.column_name).sort();
    expect(colNames).toEqual(["at", "comment_id", "id", "memex_id", "mentioned_by", "user_id"]);

    const idx = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'comment_mentions'
    `)) as unknown as { indexname: string }[];
    const idxNames = idx.map((i) => i.indexname);
    expect(idxNames).toContain("comment_mentions_comment_id_user_id_unique");
    expect(idxNames).toContain("comment_mentions_user_id_idx");

    const dcCols = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'doc_comments'
        AND column_name IN ('assignee_user_id', 'assigned_by', 'assigned_at')
    `)) as unknown as { column_name: string }[];
    expect(dcCols.map((c) => c.column_name).sort()).toEqual([
      "assigned_at",
      "assigned_by",
      "assignee_user_id",
    ]);

    const partial = (await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'doc_comments' AND indexname = 'doc_comments_open_assignee_idx'
    `)) as unknown as { indexname: string }[];
    expect(partial).toHaveLength(1);
  });
});

describe("spec-320 @-mention capture (ac-1)", () => {
  it("mentions one or more users, dedups, emits comment_mention, and emails each new mention", async () => {
    tagAc(AC(1));
    tagAc(AC(9)); // one mention email per newly-mentioned user (dec-3)
    const c = await makeComment();
    send.mockClear();

    const events = await captureEvents(async () => {
      await addMentions(memexId, c.id, [alice.id, bob.id], ctx());
    });

    const mentions = await listMentionsForComments(memexId, [c.id]);
    expect(mentions.get(c.id)?.map((m) => m.userId).sort()).toEqual([alice.id, bob.id].sort());

    // One comment_mention event per newly-mentioned user.
    expect(events.filter((e) => e.entity === "comment_mention" && e.action === "created")).toHaveLength(2);
    // One mention email per newly-mentioned user.
    expect(send).toHaveBeenCalledTimes(2);

    // Idempotent: re-mentioning alice + adding carol only adds carol (one new row, one email).
    send.mockClear();
    await addMentions(memexId, c.id, [alice.id, carol.id], ctx());
    const after = await listMentionsForComments(memexId, [c.id]);
    expect(after.get(c.id)).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("spec-320 assignment = mention + ownership (ac-2, ac-8)", () => {
  it("assigning sets the columns AND guarantees a mention row (assignee ⊆ mentions); sends one assignment email", async () => {
    tagAc(AC(2));
    tagAc(AC(8));
    tagAc(AC(9)); // assignment sends ONE assignment email, never also a mention email (dec-3)
    const c = await makeComment();
    send.mockClear();

    await assignComment(memexId, c.id, bob.id, ctx());

    const row = await db.query.docComments.findFirst({ where: eq(docComments.id, c.id) });
    expect(row?.assigneeUserId).toBe(bob.id);
    expect(row?.assignedBy).toBe(actor.id);
    expect(row?.assignedAt).toBeTruthy();

    // assignee ⊆ mentions: bob is now a mention row even though we never called addMentions.
    const mentions = await db
      .select()
      .from(commentMentions)
      .where(eq(commentMentions.commentId, c.id));
    expect(mentions.map((m) => m.userId)).toContain(bob.id);

    // Exactly one assignment email (not a mention email too).
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("unassign clears the columns but leaves the mention intact", async () => {
    tagAc(AC(2));
    const c = await makeComment();
    await assignComment(memexId, c.id, bob.id, ctx());
    await unassignComment(memexId, c.id, ctx());

    const row = await db.query.docComments.findFirst({ where: eq(docComments.id, c.id) });
    expect(row?.assigneeUserId).toBeNull();
    expect(row?.assignedBy).toBeNull();
    expect(row?.assignedAt).toBeNull();

    const mentions = await db
      .select()
      .from(commentMentions)
      .where(eq(commentMentions.commentId, c.id));
    expect(mentions.map((m) => m.userId)).toContain(bob.id);
  });
});

describe("spec-320 three concepts are distinct (ac-3)", () => {
  it("a comment can be audience='all', mention one person, and be assigned to another, at once", async () => {
    tagAc(AC(3));
    const c = await makeComment();
    await addMentions(memexId, c.id, [alice.id], ctx());
    await assignComment(memexId, c.id, bob.id, ctx());

    const row = await db.query.docComments.findFirst({ where: eq(docComments.id, c.id) });
    expect(row?.audience).toBe("all"); // visibility untouched
    expect(row?.assigneeUserId).toBe(bob.id); // ownership

    const mentioned = (await listMentionsForComments(memexId, [c.id])).get(c.id) ?? [];
    const mentionedIds = mentioned.map((m) => m.userId);
    expect(mentionedIds).toContain(alice.id); // attention
    expect(mentionedIds).toContain(bob.id); // assignee is also a mention (dec-2)
  });
});

describe("spec-320 where-you're-needed reads (ac-4)", () => {
  it("mentions-me and open-assignments-to-me are derivable; resolving closes the assignment", async () => {
    tagAc(AC(4));
    const c = await makeComment();
    await addMentions(memexId, c.id, [carol.id], ctx());
    await assignComment(memexId, c.id, carol.id, ctx());

    const mentioned = await listCommentsMentioningUser(memexId, carol.id);
    expect(mentioned.map((m) => m.id)).toContain(c.id);

    const open = await listOpenAssignmentsForUser(memexId, carol.id);
    expect(open.map((m) => m.id)).toContain(c.id);

    // The assignee resolving the comment closes the assignment (no separate status).
    await resolveComment(memexId, c.id, "done", ctx());
    const stillOpen = await listOpenAssignmentsForUser(memexId, carol.id);
    expect(stillOpen.map((m) => m.id)).not.toContain(c.id);
  });
});
