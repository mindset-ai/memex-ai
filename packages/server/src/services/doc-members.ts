// Service layer for per-Spec roles (spec-118).
//
// A Spec's role layer sits ABOVE the org-level access gate (std-4 unchanged):
// org membership decides whether you can touch the Memex at all; the role here
// decides your CAPABILITY + UI posture on a single Spec. It never narrows read
// access — a reviewer reads every field an editor does (dec-2, ac-9).
//
// Storage shape (dec-6): `doc_members` carries ONLY elevated rows. v1 writes only
// 'editor' rows; a member with NO row resolves to the implicit 'reviewer' default.
// So reading a Spec never writes a row (ac-17), promote = idempotent INSERT, and
// demote = DELETE (member falls back to reviewer). There is no last-editor lock:
// a Spec may have zero editors (dec-5, ac-16) — the state is self-healing because
// any org member can one-click self-promote again.
//
// Assignment (doc_assignees) is a SEPARATE, independent relation — see
// services/doc-assignees.ts. A row here is never implied by a MANUAL assignment
// (dec-3). spec-189 dec-6 carve-out: TRAFFIC-DRIVEN auto-assignment
// (services/spec-traffic.ts) does imply one — a user actively mutating a Spec
// through an agent is promoted to editor alongside the assignment.

import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { docMembers, documents, users } from "../db/schema.js";
import type { DocMember } from "../db/schema.js";
import { NotFoundError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { actorName } from "./actor.js";

export type { DocMember };

// The two postures. v1 only ever persists 'editor'; 'reviewer' is the implicit
// default returned for any member without a row. Mirrors the doc_members_role_valid
// CHECK in schema.ts.
export type DocRole = "editor" | "reviewer";
export const DOC_ROLES = ["editor", "reviewer"] as const;
export function isDocRole(value: string): value is DocRole {
  return (DOC_ROLES as readonly string[]).includes(value);
}

// Verifies the Spec exists in the memex; 404 (not 403) on a cross-tenant miss
// (std-7). Mirrors assertSpecInMemex in issues.ts. Returns the Spec's handle so
// callers can name it in the Pulse narrative (spec-122) instead of leaking the
// raw doc UUID.
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

// The affected member's display snapshot for the Pulse narrative — name, else
// email, else a neutral fallback (the user must exist for a role write, but stay
// defensive so attribution never throws on the feed path). spec-122.
async function memberDisplayName(userId: string): Promise<string> {
  const u = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { name: true, email: true },
  });
  return u ? actorName(u) : "a member";
}

// The read path: 'editor' iff an editor row exists for (docId,userId), else the
// implicit 'reviewer' default. Pure read — never writes a row (ac-17). A null/absent
// userId (unauthenticated) is a reviewer.
export async function resolveRole(
  memexId: string,
  docId: string,
  userId: string | null | undefined,
): Promise<DocRole> {
  if (!userId) return "reviewer";
  const row = await db.query.docMembers.findFirst({
    where: and(
      eq(docMembers.memexId, memexId),
      eq(docMembers.docId, docId),
      eq(docMembers.userId, userId),
    ),
  });
  if (row && isDocRole(row.role)) return row.role;
  return "reviewer";
}

export interface DocMemberView {
  userId: string;
  name: string | null;
  email: string | null;
  role: DocRole;
}

// The explicit (elevated) members of a Spec — the editors. Reviewers are implicit
// and never listed here (they have no row). Joined to users for display.
// includeEmail must be false for anonymous/non-member callers (Finding #1, spec-199).
export async function listEditors(
  memexId: string,
  docId: string,
  includeEmail = true,
): Promise<DocMemberView[]> {
  const rows = await db
    .select({
      userId: docMembers.userId,
      name: users.name,
      email: users.email,
      role: docMembers.role,
    })
    .from(docMembers)
    .innerJoin(users, eq(users.id, docMembers.userId))
    .where(and(eq(docMembers.memexId, memexId), eq(docMembers.docId, docId)));
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    email: includeEmail ? r.email : null,
    role: isDocRole(r.role) ? r.role : "editor",
  }));
}

// Seed the Spec's first editor at creation (dec-4, ac-13/ac-14). Called from
// createDocDraft with the authenticated caller's id — which, on the MCP path, is
// always the HUMAN token owner (there is no separate agent principal), so an
// agent-created Spec records the human, never the agent. When userId is null
// (service token / no bound human) we seed NOTHING — the Spec has zero editors
// until someone self-promotes (no synthetic principal).
//
// Accepts a db OR tx client so it can run inside createDocDraft's write. Does NOT
// emit its own bus event — it's an internal detail of the 'document created' event
// the caller already emits. Idempotent via the UNIQUE(doc_id,user_id) upsert guard.
export async function seedCreatorAsEditor(
  memexId: string,
  docId: string,
  userId: string | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbx: any = db,
): Promise<void> {
  if (!userId) return;
  await dbx
    .insert(docMembers)
    .values({ memexId, docId, userId, role: "editor" })
    .onConflictDoNothing();
}

// Promote a member to editor (dec-5). Idempotent INSERT — re-promoting an existing
// editor is a no-op that still returns the row. Any active org member may call this
// for themselves OR another member; the only access requirement (org membership) is
// enforced upstream at the route/MCP gate, so there is no finer check here.
export async function promoteToEditor(
  memexId: string,
  docId: string,
  userId: string,
): Promise<Mutated<DocMember>> {
  const handle = await assertSpecInMemex(memexId, docId);
  const who = await memberDisplayName(userId);
  return mutate(
    {},
    {
      memexId,
      docId,
      entity: "doc_member",
      action: "created",
      // spec-122: name the person + spec instead of leaking the doc UUID.
      narrative: `promoted ${who} to editor on ${handle}`,
    },
    async () => {
      await db
        .insert(docMembers)
        .values({ memexId, docId, userId, role: "editor" })
        .onConflictDoNothing();
      // Re-read so the return reflects the row whether we inserted or it pre-existed.
      const row = await db.query.docMembers.findFirst({
        where: and(
          eq(docMembers.memexId, memexId),
          eq(docMembers.docId, docId),
          eq(docMembers.userId, userId),
        ),
      });
      return row!;
    },
  );
}

// Demote a member to reviewer (dec-5) — DELETE the editor row; the member falls
// back to the implicit reviewer default. NO last-editor lock: demoting the only
// editor succeeds and leaves the Spec with zero editors (ac-16), which is allowed
// and self-healing. Idempotent: demoting a non-editor is a no-op.
export interface DemoteResult {
  docId: string;
  userId: string;
}
export async function demoteToReviewer(
  memexId: string,
  docId: string,
  userId: string,
): Promise<Mutated<DemoteResult>> {
  const handle = await assertSpecInMemex(memexId, docId);
  const who = await memberDisplayName(userId);
  return mutate(
    {},
    {
      memexId,
      docId,
      entity: "doc_member",
      action: "deleted",
      narrative: `demoted ${who} to reviewer on ${handle}`,
    },
    async () => {
      await db
        .delete(docMembers)
        .where(
          and(
            eq(docMembers.memexId, memexId),
            eq(docMembers.docId, docId),
            eq(docMembers.userId, userId),
          ),
        );
      return { docId, userId };
    },
  );
}
