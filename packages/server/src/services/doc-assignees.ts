// Service layer for ticket-style assignment (spec-118).
//
// Assignment answers "who is responsible for moving this Spec NOW". It is an
// INDEPENDENT axis from role (dec-3): you can assign any active org member —
// including a reviewer — and assigning NEVER writes a doc_members row. "Owner"
// (spec-84) is subsumed by "assignee": the live responsibility pointer the board
// shows, more prominent than the creator.
//
// spec-189 dec-6 carve-out: the TRAFFIC-DRIVEN path (services/spec-traffic.ts —
// auto-assignment from mutating agent tool calls) deliberately couples the two
// axes: it calls assign() AND promoteToEditor() together. The manual tools
// (assign_spec / unassign_spec) keep the role-independence described above.
//
// A Spec supports one-or-more assignees (UNIQUE(doc_id,user_id) makes assign an
// idempotent upsert and unassign a delete). assign/unassign flow through mutate()
// with entity:"doc_assignee" and emit on the unified bus (std-8, ac-20) — so
// spec-16 reactivity updates open boards live and spec-82 can render "assigned to
// you" later, with no notification UI shipped here (dec-8).

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { docAssignees, documents, users } from "../db/schema.js";
import type { DocAssignee } from "../db/schema.js";
import { NotFoundError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { actorName, resolveActorColumns } from "./actor.js";

export type { DocAssignee };

// Returns the Spec's handle (404 on a cross-tenant miss, std-7) so callers can
// name it in the Pulse narrative instead of leaking the raw doc UUID (spec-122).
async function assertSpecInMemex(memexId: string, docId: string): Promise<string> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
    columns: { handle: true },
  });
  if (!doc) {
    throw new NotFoundError(`Spec ${docId} not found in memex ${memexId}`);
  }
  return doc.handle;
}

// The assignee's display snapshot for the Pulse narrative. spec-122.
async function assigneeDisplayName(userId: string): Promise<string> {
  const u = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { name: true, email: true },
  });
  return u ? actorName(u) : "a member";
}

export interface DocAssigneeView {
  userId: string;
  name: string | null;
  email: string | null;
  assignedAt: Date;
}

// The current assignees of a Spec, joined to users for display. Ordered by
// assigned_at so the board renders the longest-standing assignee first.
// includeEmail must be false for anonymous/non-member callers (Finding #1, spec-199).
export async function listAssignees(
  memexId: string,
  docId: string,
  includeEmail = true,
): Promise<DocAssigneeView[]> {
  const rows = await db
    .select({
      userId: docAssignees.userId,
      name: users.name,
      email: users.email,
      assignedAt: docAssignees.assignedAt,
    })
    .from(docAssignees)
    .innerJoin(users, eq(users.id, docAssignees.userId))
    .where(and(eq(docAssignees.memexId, memexId), eq(docAssignees.docId, docId)))
    .orderBy(docAssignees.assignedAt);
  return rows.map((r) => ({ ...r, email: includeEmail ? r.email : null }));
}

// Batch roll-up of assignees for many Specs at once — backs the board list
// payload (listDocs `include: ['assignees']`, ac-18). One query, grouped per doc,
// so rendering the whole board's assignee chips never N+1s. Returns a Map keyed by
// docId; Specs with no assignees are simply absent (the card renders "Unassigned").
export async function listAssigneesForDocs(
  memexId: string,
  docIds: string[],
): Promise<Map<string, DocAssigneeView[]>> {
  const byDoc = new Map<string, DocAssigneeView[]>();
  if (docIds.length === 0) return byDoc;
  const rows = await db
    .select({
      docId: docAssignees.docId,
      userId: docAssignees.userId,
      name: users.name,
      email: users.email,
      assignedAt: docAssignees.assignedAt,
    })
    .from(docAssignees)
    .innerJoin(users, eq(users.id, docAssignees.userId))
    .where(and(eq(docAssignees.memexId, memexId), inArray(docAssignees.docId, docIds)))
    .orderBy(docAssignees.assignedAt);
  for (const r of rows) {
    const list = byDoc.get(r.docId) ?? [];
    list.push({ userId: r.userId, name: r.name, email: r.email, assignedAt: r.assignedAt });
    byDoc.set(r.docId, list);
  }
  return byDoc;
}

// The Spec ids in a memex assigned to a given user — backs the board's
// "assigned to me" / "assigned to <person>" filter (ac-19).
export async function listDocIdsAssignedToUser(memexId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ docId: docAssignees.docId })
    .from(docAssignees)
    .where(and(eq(docAssignees.memexId, memexId), eq(docAssignees.userId, userId)));
  return rows.map((r) => r.docId);
}

// spec-64 t-2 (ac-19): the Specs assigned to a user, joined to `documents` so the
// caller can render a navigable hit (handle/title/status/docType) without a
// second lookup. Backs the search route's `@<name>` "assigned" lane — the same
// doc_assignees relation as the board filter (listDocIdsAssignedToUser above),
// but returning the doc row fields the search envelope needs. Visibility posture
// matches the search content tier: archived AND paused excluded (so an
// assigned-but-archived Spec doesn't leak into the omnibox). NO status filter —
// drafts are assignable and must surface. Scoped to memexId on BOTH the
// assignment and the doc (defence-in-depth: doc_assignees.memex_id is
// denormalised, documents.memex_id is the source of truth).
export interface AssignedSpecRow {
  docId: string;
  handle: string;
  title: string;
  status: string;
  docType: string;
}

export async function listSpecsAssignedToUser(
  memexId: string,
  userId: string,
): Promise<AssignedSpecRow[]> {
  const rows = await db
    .select({
      docId: documents.id,
      handle: documents.handle,
      title: documents.title,
      status: documents.status,
      docType: documents.docType,
    })
    .from(docAssignees)
    .innerJoin(documents, eq(documents.id, docAssignees.docId))
    .where(
      and(
        eq(docAssignees.memexId, memexId),
        eq(docAssignees.userId, userId),
        eq(documents.memexId, memexId),
        isNull(documents.archivedAt),
        isNull(documents.pausedAt),
      ),
    )
    .orderBy(sql`${documents.handle}`);
  return rows;
}

// Assign a user to a Spec (ac-12). Idempotent INSERT — assigning an already-assigned
// user is a no-op that still returns the row. Crucially writes NO doc_members row:
// assignment is independent of role (dec-3). `assignedBy` records who assigned, for
// attribution; ON DELETE SET NULL keeps the assignment if that actor is later removed.
export async function assign(
  memexId: string,
  docId: string,
  userId: string,
  assignedBy: string | null,
  // spec-122 dec-5: WHO performed it + HOW, so the assign event is attributed to
  // the acting human (not "System") with their resolved name. Defaults empty.
  ctx: RequestCtx = {},
): Promise<Mutated<DocAssignee>> {
  const handle = await assertSpecInMemex(memexId, docId);
  const who = await assigneeDisplayName(userId);
  const actor = await resolveActorColumns(ctx);

  // Already assigned? The write is a no-op, so emit NOTHING (std-32: an event
  // must reflect a REAL change). spec-189's traffic-driven assignment calls this
  // on every agent tool call, so emitting on an idempotent re-assign spammed the
  // feed with "assigned X to Y" on every conversation turn.
  const existing = await db.query.docAssignees.findFirst({
    where: and(
      eq(docAssignees.memexId, memexId),
      eq(docAssignees.docId, docId),
      eq(docAssignees.userId, userId),
    ),
  });

  return mutate(
    { ...ctx, actorUserId: actor.actorUserId ?? undefined, actorName: actor.actorName ?? undefined },
    {
      memexId,
      docId,
      entity: "doc_assignee",
      action: "created",
      // spec-122: name the spec + assignee instead of leaking the doc UUID.
      narrative: `assigned ${handle} to ${who}`,
    },
    async () => {
      await db
        .insert(docAssignees)
        .values({ memexId, docId, userId, assignedBy })
        .onConflictDoNothing();
      const row = await db.query.docAssignees.findFirst({
        where: and(
          eq(docAssignees.memexId, memexId),
          eq(docAssignees.docId, docId),
          eq(docAssignees.userId, userId),
        ),
      });
      return row!;
    },
    // No real change ⇒ no emission. A genuine first-time assign still announces.
    { silent: !!existing },
  );
}

export interface UnassignResult {
  docId: string;
  userId: string;
}

// Unassign a user from a Spec (ac-12). DELETE; idempotent (unassigning a
// non-assignee is a no-op). Emits a 'doc_assignee' deleted event (ac-20).
export async function unassign(
  memexId: string,
  docId: string,
  userId: string,
  ctx: RequestCtx = {},
): Promise<Mutated<UnassignResult>> {
  const handle = await assertSpecInMemex(memexId, docId);
  const who = await assigneeDisplayName(userId);
  const actor = await resolveActorColumns(ctx);
  return mutate(
    { ...ctx, actorUserId: actor.actorUserId ?? undefined, actorName: actor.actorName ?? undefined },
    {
      memexId,
      docId,
      entity: "doc_assignee",
      action: "deleted",
      narrative: `unassigned ${who} from ${handle}`,
    },
    async () => {
      await db
        .delete(docAssignees)
        .where(
          and(
            eq(docAssignees.memexId, memexId),
            eq(docAssignees.docId, docId),
            eq(docAssignees.userId, userId),
          ),
        );
      return { docId, userId };
    },
  );
}
