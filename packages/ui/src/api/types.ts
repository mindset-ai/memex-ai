// Per dec-3 of doc-10 the Spec rename (`review`→`specify`, `implementation`→`build`,
// plus new `verify`) applies to docType='spec' rows only. The legacy `review` and
// `implementation` values stay in the union because Standards / Documents / Execution
// plans still carry them. `'approved'` continues to be the Execution-plan terminal
// state. Use `SPEC_STATUSES` when constraining to the Spec kanban + dropdown.
// (spec-181: the second phase value is now `specify`, not `plan` — the server
// emits/accepts `specify` end-to-end.)
export const DOC_STATUSES = [
  'draft',
  'review',
  'implementation',
  'done',
  'approved',
  'specify',
  'build',
  'verify',
] as const;
export type DocStatus = typeof DOC_STATUSES[number];

// Spec-only lifecycle (dec-3, dec-4): five-step flow rendered by the Spec
// kanban and offered by the Spec header dropdown.
export const SPEC_STATUSES = ['draft', 'specify', 'build', 'verify', 'done'] as const;
export type SpecStatus = typeof SPEC_STATUSES[number];

// spec-136: a coined tag in a Memex. The wire shape mirrors the server `Tag`
// (db/schema.ts `tags`): `scope` is the part before `::` (NULL for a flat tag
// like `bug`), `value` is the part after (or the whole flat tag). `memexId` and
// `createdAt` ride along on the wire — kept here so fetchDoc/fetchDocs return the
// exact server payload, but `id`/`scope`/`value` are the load-bearing fields the
// UI renders. The bridge's `added_by` attribution is NOT projected into this
// shape (server contract). Tag text is USER INPUT — always render it escaped
// (React does this by default; never dangerouslySetInnerHTML a tag).
export interface Tag {
  id: string;
  memexId: string;
  /** Part before `::` (`priority` in `priority::high`). NULL = a flat tag (`bug`). */
  scope: string | null;
  /** Part after `::`, or the whole tag for a flat one. Never empty. */
  value: string;
  createdAt: string;
}

// Minimal parent projection populated by listDocs whenever parentDocId is set
// (t-20 W-F). Lets cards render "Promoted from <title> (<docType>)" without a
// second fetch — works even when the parent isn't a spec and so isn't in
// the same fetchDocs('spec') result.
export interface DocSummaryParent {
  id: string;
  handle: string;
  title: string;
  docType: string;
}

// Per migration 0036: minimal creator projection on each doc. Either field can
// be null (LEFT JOIN — legacy docs, deleted users); the whole object is null
// when documents.created_by_user_id is null. Card UI falls back to "Unknown".
export interface DocSummaryCreator {
  name: string | null;
  email: string | null;
}

export interface DocSummary {
  id: string;
  handle: string;
  title: string;
  docType: string;
  status: DocStatus;
  /**
   * Parent spec lineage (per dec-11). When set, this doc was promoted
   * from the referenced doc — used to display "Promoted from <parent>" on
   * Spec cards. Null for any doc without lineage (the common case).
   */
  parentDocId: string | null;
  /**
   * Minimal parent projection. Populated by the server whenever `parentDocId`
   * is set, regardless of the parent's docType — this is how SpecList
   * cards display "Promoted from <title> (<docType>)" for non-spec
   * parents (t-20 W-F). Undefined if the server didn't return it.
   */
  parent?: DocSummaryParent | null;
  /**
   * User who created this doc (migration 0036). Null when no creator was
   * recorded — pre-migration rows and rows whose creator was later removed
   * (FK is ON DELETE SET NULL). UI shows "Unknown" in that case.
   */
  creator?: DocSummaryCreator | null;
  createdAt: string;
  statusChangedAt: string;
  sectionCount: number;
  /**
   * Spec lifecycle flag (doc-12 t-1). NULL = active. Surfaced to power the
   * Specs kanban "Show paused" toggle (doc-12 t-13). The server filters
   * archived docs out of /api/docs by default, but paused docs are still
   * returned and excluded client-side so toggling doesn't require a refetch.
   */
  pausedAt: string | null;
  /**
   * Set if the doc has been archived (doc-12 t-1). NULL = active. The server
   * filters archived rows out of /api/docs by default, so in normal responses
   * this is null — included for parity with the server type and for any
   * future opt-in archive view.
   */
  archivedAt: string | null;
  /**
   * spec-178: demo flag — true on the five frozen spec-64 copies seeded into a personal
   * Memex for the Handhold onboarding walkthrough. Drives the DEMO badge on the board
   * card. Always returned by the server; absent/false for real specs.
   */
  isDemo?: boolean;
  /** Set when fetchDocs is called with `{ include: ['driftCount'] }` — open drift
   *  comment count for the doc. Undefined when not requested. (t-19 W2) */
  driftCount?: number;
  /** Set when fetchDocs is called with `{ include: ['acHealth'] }` — per-Spec
   *  Acceptance-Criteria health roll-up. Undefined when not requested or when
   *  the doc has no active ACs at all (treat absence as "no commitments — render
   *  the card as today"). The six counts must be derived server-side via the
   *  same `deriveVerificationState` helper the AC tab calls, so card-state and
   *  tab-state never disagree for the same Spec. (b-66) */
  acHealth?: AcHealth;
  /** Set when fetchDocs is called with `{ include: ['assignees'] }` (spec-118
   *  ac-18) — the Spec's current assignee(s), rendered on the board card more
   *  prominently than the creator. Undefined/absent means "Unassigned".
   *  Independent of role: an assignee is not necessarily an editor. */
  assignees?: DocSummaryAssignee[];
  /**
   * The doc's current tags (spec-136 t-4), ordered scope-then-value. Populated
   * ONLY when fetchDocs is called with `include: ['tags']` — develop attaches
   * tags in one batched round-trip per the `?include=tags` convention (differs
   * from the pre-develop unconditional attach). Undefined/absent means the
   * request didn't ask for tags; an included-but-untagged doc gets `[]`.
   */
  tags?: Tag[];
}

/** A Spec's assignee projection (spec-118). Independent of editor/reviewer role. */
export interface DocSummaryAssignee {
  userId: string;
  name: string | null;
  email: string | null;
}

/**
 * Per-Spec Acceptance-Criteria health roll-up. Returned by the server-side
 * aggregator behind `?include=acHealth` (b-66 t-2). The four "bucket" counts
 * (verified / failing / stale / untested) sum to `covered`; `totalActive` is
 * the count of active ACs on the Spec (the denominator the manager reads as
 * "what we committed to"). The split between `covered` and `totalActive` is
 * the silent-no-emit signal: an AC with zero tagged tests is `untested` and
 * NOT covered, even though it counts toward `totalActive`.
 *
 * Card-level palette collapses `stale + untested` into a single amber state
 * (b-66 dec-3); the four-way split survives one level down on the progress
 * strip via AcPill's `STATE_DOT` / `STATE_PILL` / `STATE_LABEL` maps.
 */
export interface AcHealth {
  totalActive: number;
  covered: number;
  verified: number;
  failing: number;
  stale: number;
  untested: number;
}

export interface Doc {
  id: string;
  handle: string;
  title: string;
  docType: string;
  status: DocStatus;
  /** See DocSummary.creator — same null-cases apply. */
  creator?: DocSummaryCreator | null;
  createdAt: string;
  statusChangedAt: string;
  /** See DocSummary.pausedAt — same semantics. */
  pausedAt?: string | null;
  /**
   * spec-178: demo flag — true on the five frozen spec-64 copies. Threaded into
   * SectionCard / DecisionPanel to suppress handle auto-linking (ac-24) and into the
   * per-phase value banner atop the demo spec. Absent/false for real specs.
   */
  isDemo?: boolean;
  /**
   * spec-178 dec-8 (ac-25/ac-26): the per-phase value callout the server attaches to a
   * demo spec's GET payload, sourced from HANDHOLD_PHASES.find(p=>p.phase===status).valueCallout.
   * Rendered by DocDocument as a banner atop the demo spec, visually distinct from the
   * spec content (it is demo guidance, not part of the spec). Absent for real specs and
   * for demo specs whose phase has no callout.
   */
  demoValueCallout?: string;
  /**
   * Timestamp of the last narrative consolidation (doc-12 t-1 column). NULL =
   * never consolidated. Spec-only — non-spec docTypes leave it null.
   * Surfaced here so the React UI's "Refresh Spec" button (t-11) can
   * compute staleness against the existing decisions list without a second
   * round-trip.
   */
  narrativeLastConsolidatedAt?: string | null;
  sections: DocSection[];
}

export interface DocSection {
  id: string;
  sectionType: string;
  title: string | null;
  content: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  // Parent doc id — used by Standard.tsx to scope bare-handle decision/task
  // resolution per b-42 t-2. Server returns it on the GET /docs/:id response;
  // optional here for legacy payloads that pre-date the b-42 addition.
  docId?: string;
}

// Per t-1 / t-4 / t-15: comments carry a typed taxonomy (12 values, see Section 7
// of doc-10), a `source` indicating whether a human or the agent posted the comment,
// and optional cross-reference fields (`referenceType` + `referenceId`) used by
// `cross_reference` comments to point at another primitive. All four are optional in
// the React UI's view of a Comment because legacy / not-yet-migrated payloads from
// before t-1 may omit them — treat undefined as `discussion` / `human`.
export const COMMENT_TYPES = [
  'discussion',
  'plan',
  'progress',
  'issue',
  'deferred',
  'cross_reference',
  'question',
  'review',
  'readiness_check',
  'approval',
  'plan_revision',
  'drift',
] as const;
export type CommentType = typeof COMMENT_TYPES[number];

export const COMMENT_SOURCES = ['human', 'agent'] as const;
export type CommentSource = typeof COMMENT_SOURCES[number];

export const COMMENT_REFERENCE_TYPES = [
  'task',
  'spec',
  'decision',
  'standard',
] as const;
export type CommentReferenceType = typeof COMMENT_REFERENCE_TYPES[number];

// spec-100 (geo-comments): a system-authored action button on a comment.
export interface CommentAction {
  label: string;
  kind: string;
  prompt?: string;
}

export interface Comment {
  id: string;
  /** Per-doc sequence — mints the `c-{seq}` handle used for deep-link URLs. */
  seq?: number;
  sectionId: string | null;
  decisionId: string | null;
  taskId: string | null;
  authorName: string;
  content: string;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  /** Typed-comment taxonomy (per Section 7). Optional — legacy rows default to `discussion`. */
  commentType?: CommentType;
  /** Server-stamped at write time. Optional for legacy rows; treat undefined as `human`. */
  source?: CommentSource;
  /** Author's user id — used to gate "delete your own comment". */
  authorUserId?: string | null;
  /** Cross-reference target type (e.g. `decision`, `standard`). */
  referenceType?: CommentReferenceType | null;
  /** Cross-reference target id (UUID or handle). */
  referenceId?: string | null;
  /** Parent doc id — used by CommentTray to scope bare-handle resolution per b-42 t-2. */
  docId?: string;
  /** spec-100: snapshot of the anchored text at creation. null/undefined => floating. */
  anchorSnippet?: string | null;
  /** spec-100: reserved attention-routing audience; v0 is always 'all'. */
  audience?: 'all' | string[];
  /** spec-100: system-authored action buttons (Address/Dismiss). */
  actions?: CommentAction[] | null;
}

export type CommentTargetType = 'section' | 'decision' | 'task';

export interface SectionComments {
  section: DocSection;
  comments: Comment[];
}

export interface DecisionComments {
  decision: Decision;
  comments: Comment[];
}

export interface TaskComments {
  task: Task;
  comments: Comment[];
}

export interface DocCommentsResult {
  sections: SectionComments[];
  decisions: DecisionComments[];
  tasks: TaskComments[];
}

// Per t-1 / dec-8 / dec-21: decisions can carry structured `options` (JSONB
// `Array<{label, trade_offs}>`) plus a `chosenOptionIndex` set when a
// resolution picks one of those options. Status was extended in t-1 to four
// values — `candidate` and `rejected` are added on top of the original
// `open`/`resolved` pair to support the agent-extraction workflow (t-5/t-9)
// and the candidate review UI (t-16). Snake-case `trade_offs` matches the
// wire format from dec-8 — don't camelCase it.
export interface DecisionOption {
  label: string;
  trade_offs: string;
}

export type DecisionStatus = 'open' | 'resolved' | 'candidate' | 'rejected';

// Provenance of who created the decision — 'human' for direct REST/UI authoring,
// 'agent' for per-turn extraction via proposeDecision (t-9 / t-12). Persisted on
// the row from t-20 W-B / 0027_v2_deferral_fixes. Optional in this view because
// pre-migration payloads (replayed from old test fixtures) may omit it; treat
// undefined as 'human'.
export type DecisionSource = 'human' | 'agent';

export interface Decision {
  id: string;
  docId: string;
  seq: number;
  title: string;
  context: string | null;
  status: DecisionStatus;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  options: DecisionOption[] | null;
  chosenOptionIndex: number | null;
  source?: DecisionSource;
}

export interface AcceptanceCriterion {
  description: string;
  done: boolean;
}

export interface Task {
  id: string;
  docId: string;
  seq: number;
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  sectionRef: string | null;
  status: 'not_started' | 'in_progress' | 'complete';
  blocked: boolean;
  blockedByDecisions: Decision[];
  blockedByTasks: Task[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Set when the task has a linked execution plan document. Used by t-19 W4
   *  graph view to mark such nodes visually. Optional because legacy / partial
   *  payloads may omit it. */
  executionPlanDocId?: string | null;
}

// ── Issues (spec-112) ──
// An Issue is a bug or a todo raised against a Spec as a whole — any phase, no
// anchor (ac-1). Mirrors the server `Issue` row (db/schema.ts). The per-Spec
// handle is `issue-N` (seq); the issue-N space is independent of ac/task/decision seqs.
export type IssueType = 'bug' | 'todo';
export type IssueStatus = 'open' | 'converted' | 'resolved' | 'wont_fix';
export type IssueSource = 'human' | 'agent';

export interface Issue {
  id: string;
  docId: string;
  seq: number;
  title: string;
  body: string;
  type: IssueType;
  severity: string | null;
  status: IssueStatus;
  source: IssueSource;
  satisfyingTaskId: string | null;
  promotedDocId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Memex-level Issues feed (spec-158 t-3/t-4) ──
// One flat row from GET /api/<ns>/<mx>/issues-list: the open issue's own fields
// plus its parent Spec's metadata, enough for the Issues page to group under the
// Spec without a second lookup. Mirrors the server `MemexIssueRow` (services/
// issues-list.ts) — `createdAt` arrives as an ISO string over the wire. The
// canonical `issue-N` handle is derived client-side from `seq`.
export interface MemexIssue {
  id: string;
  seq: number;
  type: IssueType;
  title: string;
  status: string;
  createdAt: string;
  spec: {
    docId: string;
    handle: string;
    title: string;
    status: string;
  };
}

export interface DocWithGraph extends Doc {
  decisions: Decision[];
  tasks: Task[];
  /**
   * The doc's current tags (spec-136 t-4), ordered scope-then-value by the
   * server. GET /api/docs/:id returns this unconditionally alongside
   * decisions/tasks. Optional only for forward/backward payload tolerance.
   */
  tags?: Tag[];
}

// Mirrors PlanReadinessEntry from the server (services/execution_plans.ts).
// Returned by POST /api/execution-plans/readiness; consumed by TaskPanel to
// derive the per-task plan badge via derivePlanBadgeState (ExecutionPlanModal).
export interface PlanReadinessEntry {
  taskId: string;
  executionPlanDocId: string | null;
  planStatus: string | null;
  readinessContent: string | null;
}

// ── Chat types ──

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool_status' | 'ui_tool';
  id: string;
  content: string;
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  timestamp: Date;
}

export interface ContextChip {
  // spec-112 c-1 (ratified): clicking an Issue row sets a minimal
  // {type:'issue', id, label:'issue-N — title'} chip. The agent fetches detail via
  // get_issue — NO richer payload travels through the chip (it reuses the same
  // [Focus: <label>] prefix + ChatContext store as every other chip kind).
  // spec-143 dec-3: clicking a Drift Inbox row sets a minimal
  // {type:'drift_item', id:<commentId>, label:'Drift on std-N …'} chip — the
  // same affordance as a section click, focusing the drift agent on that item.
  type: 'section' | 'decision' | 'task' | 'ac' | 'issue' | 'drift_item';
  id: string;
  label: string;
}

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; toolName: string; toolId: string }
  | { type: 'tool_result'; toolId: string; result: string }
  | { type: 'ui_tool'; toolName: string; toolId: string; input: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'done'; conversationId?: string };

// Kind-aware home payload from GET /api/namespaces/:namespaceId/home (doc-19 t-4).
export type NamespaceHomeResponse =
  | {
      kind: 'org';
      org: { id: string; name: string; slug: string };
      memexes: Array<{ id: string; slug: string; name: string; lastActivityAt: string }>;
      memberCount: number;
      currentRole: 'member' | 'administrator';
    }
  | {
      kind: 'personal';
      memex: { id: string; slug: string; name: string } | null;
    };

export interface MemexDto {
  id: string;
  namespaceId: string;
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
