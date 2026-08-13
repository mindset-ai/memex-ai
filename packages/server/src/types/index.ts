export type { Doc, DocSection, DocComment, Decision, Task } from "../db/schema.js";
export { NotFoundError, ValidationError } from "./errors.js";
export type { TaskWithBlockers } from "../services/tasks.js";
export type { Blockers } from "../services/dependencies.js";

// Minimal projection of a parent doc — surfaced on `DocSummary` when `parentDocId`
// is set so the Specs list card can render "Promoted from <title> (<docType>)"
// without a second fetch even when the parent isn't a Spec (t-20 W-F).
export interface DocSummaryParent {
  id: string;
  handle: string;
  title: string;
  docType: string;
}

// Minimal projection of the user who created the doc (migration 0036). LEFT JOIN
// in listDocs, so this is null for legacy rows or when the creator has been
// removed (FK is ON DELETE SET NULL). React UI renders "Unknown" in that case.
export interface DocSummaryCreator {
  name: string | null;
  email: string | null;
}

// Minimal projection of a Spec's assignee (spec-118). Joined to users in
// listAssigneesForDocs. The board renders these avatar(s) more prominently than
// the creator (ac-18); absence of the array means "Unassigned".
export interface DocSummaryAssignee {
  userId: string;
  name: string | null;
  email: string | null;
}

/**
 * spec-529: the task roll-up the reference CARD shows as its task split (the
 * pill face carries only the handle and a phase chip). Derived by
 * `taskProgressByDoc` from the same rows the Spec's own task list reads, so the
 * two can never disagree for one Spec.
 */
export interface TaskProgress {
  total: number;
  complete: number;
  inProgress: number;
  notStarted: number;
}

/**
 * spec-529: WHEN a Spec last changed and WHAT changed, read from the activity log
 * because `documents` carries no general updated-at column.
 */
export interface LastActivity {
  at: Date;
  narrative: string;
}

export interface DocSummary {
  id: string;
  memexId: string;
  handle: string;
  title: string;
  docType: string;
  status: string;
  // Spec lineage (dec-11): null for roots / non-Spec docs, set when this doc was
  // produced via promoteToSpec or otherwise descended from another doc.
  parentDocId: string | null;
  // Per t-20 W-F: minimal parent projection populated whenever parentDocId is set,
  // regardless of the parent's docType. This unblocks "Promoted from <title>
  // (<docType>)" rendering on cards without forcing the UI to fetch the parent.
  parent?: DocSummaryParent | null;
  // Creator projection — see DocSummaryCreator. Null when no creator is set.
  creator?: DocSummaryCreator | null;
  createdAt: Date;
  statusChangedAt: Date;
  sectionCount: number;
  // Per doc-12 t-1: archivedAt is nullable (NULL = active). listDocs already filters
  // archived rows out by default, so the value is ~always null in current responses,
  // but exposing it keeps the wire shape honest if callers later opt into includeArchived.
  archivedAt: Date | null;
  // spec-521 (ac-4, ac-5): WHY it was archived and WHO archived it, projected so the
  // archive view can show the reason as a first-class column — "absorbed into
  // spec-510" versus a blank row is the difference between an archive and a black
  // hole. `archivedByName` is the denormalised std-32 snapshot, not a read-time join.
  archiveReason?: string | null;
  archivedByName?: string | null;
  // spec-521 dec-5 (ac-13): the successor pointer, projected so `list_docs` can mark
  // a superseded row inline and the Spec page can render its banner. A superseded
  // Spec STAYS in every listing — the pointer does the work of telling you it was
  // replaced, not a filter that hides it.
  supersededByDocId?: string | null;
  supersededAt?: Date | null;
  supersessionNote?: string | null;
  // spec-178 t-1 (ac-9): demo flag — true on the five frozen spec-64 copies seeded into
  // a personal Memex for the Handhold onboarding walkthrough. Always projected by
  // listDocs; drives the DEMO badge client-side and the Pulse/analytics exclusion
  // server-side. Optional on the type for other DocSummary constructors / legacy payloads.
  isDemo?: boolean;
  // spec-409 (ac-1): the standalone code-grounded flag + provenance, projected on
  // every DocSummary so the board card can render the compact "Code-grounded"
  // marker. groundedStale is derived read-time (dec-4) in listDocs for grounded
  // specs only; absent/false means "not stale". Optional for non-listDocs
  // DocSummary constructors / legacy payloads.
  groundedInCode?: boolean;
  groundedAt?: Date | null;
  groundedByName?: string | null;
  groundedStale?: boolean;
  // Set when ?include=driftCount is requested (t-19 W2). Open `commentType='drift'` count
  // joined via doc_sections.doc_id = this.id. Undefined when not requested so callers
  // that don't pass `include` aren't paying for the join.
  driftCount?: number;
  // Set when ?include=acHealth is requested (b-66 t-2). Per-Spec AC health roll-up
  // produced by `aggregateAcHealthForBriefs` — six counts derived through the same
  // `deriveVerificationState` / `STALE_THRESHOLD_DAYS` / `buildAcRef` helpers the AC
  // tab uses, so card state and tab state cannot disagree for the same Spec (b-66
  // Scope AC-3). Specs with zero active ACs get the field OMITTED (absence-of-signal,
  // b-66 Scope AC-4) so the UI's "no commitments" branch trips naturally.
  acHealth?: AcHealth;
  /**
   * spec-529 (ac-10): per-Spec task progress, populated only when listDocs is
   * called with `includeTaskProgress`. Absent when the Spec has no tasks —
   * absence is the signal (the pill renders no fraction rather than `0/0`),
   * matching how `acHealth` treats a Spec with no commitments.
   */
  taskProgress?: TaskProgress;
  /**
   * spec-529 (ac-2): the Spec's most recent logged activity, populated only under
   * `includeLastActivity`. Absent when nothing has been logged against it.
   */
  lastActivity?: LastActivity;
  // Set when ?include=assignees is requested (spec-118 ac-18). The Spec's current
  // assignee(s); OMITTED when the Spec has no assignees so the card's "Unassigned"
  // branch trips. Independent of role — an assignee is not necessarily an editor.
  assignees?: DocSummaryAssignee[];
}

export interface AcHealth {
  totalActive: number;
  covered: number;
  verified: number;
  failing: number;
  stale: number;
  untested: number;
}
