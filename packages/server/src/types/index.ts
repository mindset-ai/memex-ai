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
  // Per doc-12 t-1 / t-13: lifecycle flags surfaced so the React UI can filter and dim
  // paused Specs client-side. Both nullable (NULL = active). archivedAt is included
  // for completeness; listDocs already filters archived rows out by default, so the
  // value is ~always null in current responses, but exposing it keeps the wire shape
  // honest if callers later opt into includeArchived.
  pausedAt: Date | null;
  archivedAt: Date | null;
  // spec-178 t-1 (ac-9): demo flag — true on the five frozen spec-64 copies seeded into
  // a personal Memex for the Handhold onboarding walkthrough. Always projected by
  // listDocs; drives the DEMO badge client-side and the Pulse/analytics exclusion
  // server-side. Optional on the type for other DocSummary constructors / legacy payloads.
  isDemo?: boolean;
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
