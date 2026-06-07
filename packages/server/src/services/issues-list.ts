// Memex-level Issues list (spec-158 t-3).
//
// Returns every OPEN issue across the Memex joined to its parent Spec's
// metadata (doc id, handle, title, status), with enough on each row for the
// React UI's Issues page to group client-side under the parent Spec (ac-1 /
// ac-7) and run the owner / phase / type filters (ac-2 / ac-3 / ac-10).
//
// Shape mirrors drift-inbox.ts (the other memex-level read-only list service):
// one query, parent-doc context attached, no mutation surface. It does NOT ride
// the per-Spec listIssuesForSpec path (issues.ts) — that one is anchored to a
// single Spec; this is the cross-Spec roll-up.
//
// Filters (all compose):
//   scope  — 'mine' (default) returns only issues whose parent Spec carries an
//            assignment for the requesting user (the spec-118 doc_assignees
//            relation — the same assignment mechanism assign_spec / the board's
//            "assigned to me" filter use, ac-12). 'all' returns every open issue
//            in the Memex regardless of assignment.
//   phases — any subset of draft/specify/build/verify/done; narrows to issues whose
//            parent Spec's status is in the requested set (ac-13). An empty/absent
//            set applies no phase narrowing (all phases).
//   types  — any subset of bug/todo; narrows on the issue's own type column
//            (ac-10).
//
// Only OPEN issues surface — converted / resolved / wont_fix are off the open
// list (ac-2: "open issues"). Tenancy is the issues.memex_id filter plus the
// documents.memex_id join (defence-in-depth, the same posture as
// listSpecsAssignedToUser). The route in front is org-membership gated and 404s
// non-members (std-4 / std-7), so this service trusts its memexId.
//
// The canonical `issue-N` handle is derived client-side from `seq` the way every
// other handle is (the per-Spec UNIQUE(doc_id, seq) allocator mints it); we ship
// `seq` and let the UI render `issue-${seq}`, matching how listIssuesForSpec /
// the search hits carry the raw seq rather than a pre-baked handle string.

import { and, eq, inArray, desc, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { issues, documents, docAssignees } from "../db/schema.js";
import { ISSUE_TYPES, type IssueType } from "./issues.js";

// The Spec workflow phases the phase filter accepts (ac-13). These are the
// documents.status values the Spec rename settled on (doc-10): draft / specify /
// build / verify / done. The UI's phase checkboxes map 1:1 onto this set.
export type SpecPhase = "draft" | "specify" | "build" | "verify" | "done";
export const SPEC_PHASES = ["draft", "specify", "build", "verify", "done"] as const;
export function isSpecPhase(value: string): value is SpecPhase {
  return (SPEC_PHASES as readonly string[]).includes(value);
}

export type IssueScope = "mine" | "all";

export interface ListMemexIssuesOptions {
  /**
   * 'mine' (default) restricts to issues on Specs assigned to `userId`; 'all'
   * returns every open issue in the Memex. When 'mine' is requested without a
   * `userId` (anonymous — should not happen behind the member gate) the result
   * is empty: no assignment can match a null user.
   */
  scope?: IssueScope;
  /** The requesting user, for scope='mine'. Ignored when scope='all'. */
  userId?: string | null;
  /** Subset of draft/specify/build/verify/done. Empty/absent → no phase narrowing. */
  phases?: SpecPhase[];
  /** Subset of bug/todo. Empty/absent → no type narrowing. */
  types?: IssueType[];
}

// One flat row: the issue's own fields plus its parent Spec's metadata, enough
// for the UI to group by Spec without a second lookup.
export interface MemexIssueRow {
  id: string;
  seq: number;
  type: IssueType;
  title: string;
  status: string;
  createdAt: Date;
  spec: {
    docId: string;
    handle: string;
    title: string;
    status: string;
  };
}

// Open issues across the Memex, ordered so the most-recently-active parent Spec
// surfaces first. "Most-recent issue activity" = the newest issue updatedAt on
// each Spec; we approximate the spec ordering by ordering rows on the issue's
// own updatedAt desc, then group client-side — the freshest issue (and so the
// freshest Spec) sorts to the top (ac-7 grouping is client-side). Within a Spec
// the rows stay in updatedAt-desc order too, which the UI re-groups under the
// Spec heading.
export async function listMemexIssues(
  memexId: string,
  opts: ListMemexIssuesOptions = {},
): Promise<MemexIssueRow[]> {
  const scope: IssueScope = opts.scope ?? "mine";

  // Only OPEN issues are on the list (ac-2). Tenancy on BOTH the issue and the
  // doc (the issues.memex_id denormalised column + the documents.memex_id source
  // of truth — defence-in-depth, mirrors listSpecsAssignedToUser).
  const conditions = [
    eq(issues.memexId, memexId),
    eq(issues.status, "open"),
    eq(documents.memexId, memexId),
    // Don't surface issues whose parent Spec is archived — an archived Spec is
    // off the board, so its open issues are off the open list too.
    isNull(documents.archivedAt),
  ];

  // scope='mine' (ac-12): restrict to Specs the requester is assigned to. With
  // no userId there is nothing to match — return empty rather than leaking the
  // whole Memex. We resolve the assigned doc ids up front (the same
  // doc_assignees relation the board's "assigned to me" filter reads) and add an
  // inArray narrow; an empty assignment set short-circuits to [].
  if (scope === "mine") {
    const userId = opts.userId ?? null;
    if (!userId) return [];
    const assignedRows = await db
      .select({ docId: docAssignees.docId })
      .from(docAssignees)
      .where(and(eq(docAssignees.memexId, memexId), eq(docAssignees.userId, userId)));
    const assignedDocIds = assignedRows.map((r) => r.docId);
    if (assignedDocIds.length === 0) return [];
    conditions.push(inArray(issues.docId, assignedDocIds));
  }

  // Phase filter (ac-13): narrow on the parent Spec's status. An empty/absent set
  // applies no narrowing (all phases). We filter to recognised phases so a stray
  // value can't widen or break the inArray.
  const phases = (opts.phases ?? []).filter(isSpecPhase);
  if (phases.length > 0) {
    conditions.push(inArray(documents.status, phases));
  }

  // Type filter (ac-10): narrow on the issue's own type column.
  const types = (opts.types ?? []).filter((t): t is IssueType =>
    (ISSUE_TYPES as readonly string[]).includes(t),
  );
  if (types.length > 0) {
    conditions.push(inArray(issues.type, types));
  }

  const rows = await db
    .select({
      id: issues.id,
      seq: issues.seq,
      type: issues.type,
      title: issues.title,
      status: issues.status,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
      specDocId: documents.id,
      specHandle: documents.handle,
      specTitle: documents.title,
      specStatus: documents.status,
    })
    .from(issues)
    .innerJoin(documents, eq(documents.id, issues.docId))
    .where(and(...conditions))
    // Most-recent issue activity first (ac-7): newest updatedAt to the top, so the
    // freshest Spec sorts up when the UI groups. id tiebreaker keeps the order
    // stable when several issues share a millisecond updatedAt.
    .orderBy(desc(issues.updatedAt), desc(issues.id));

  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    type: r.type as IssueType,
    title: r.title,
    status: r.status,
    createdAt: r.createdAt,
    spec: {
      docId: r.specDocId,
      handle: r.specHandle,
      title: r.specTitle,
      status: r.specStatus,
    },
  }));
}
