// Single source of truth for the small finite enums used across services and routes.
// Lives in types/ rather than db/schema.ts to keep import direction one-way:
// schema → types (via re-exports) is fine; types → schema would create a cycle.
//
// sectionType is intentionally NOT in this file: it's free-form text in both the DB and
// code (e.g. "context", "scope", "summary") and locking it to a finite union would force
// schema migrations on every new section type. DOC_TYPES is enumerated below for app-side
// validation only — the column itself stays free-form.

export type Role = "member" | "administrator";

export type MembershipStatus = "active" | "disabled";

export type UserStatus = "active" | "disabled";

// Per dec-3 of doc-10 the rename `review`→`plan`, `implementation`→`build`, plus new
// `verify`, applies to docType='spec' rows only (and per spec-181 the second
// phase was renamed again, `plan`→`specify`). The legacy `review` and
// `implementation` values stay in the union because Standards / Documents / Execution
// plans still carry them. Use `SpecStatus` (below) when constraining to the Spec
// kanban + dropdown surface.
export type DocStatus =
  | "draft"
  | "review"
  | "implementation"
  | "done"
  | "approved"
  | "specify"
  | "build"
  | "verify";

// Spec-only lifecycle: what the kanban renders and what the Spec header
// dropdown offers. Excludes `'approved'` (execution-plan-only) and the legacy
// `review`/`implementation` (still valid at the column level for non-Spec docs).
export type SpecStatus = "draft" | "specify" | "build" | "verify" | "done";

export type TaskStatus = "not_started" | "in_progress" | "complete";

export type DecisionStatus = "open" | "resolved" | "candidate" | "rejected";

// Section 7 of doc-10 ("Closing the Whitepaper Gap"): the 12 typed-comment values. Most are
// agent-authored; `discussion` (default) and `review` / `approval` are typically human.
export type CommentType =
  | "discussion"
  | "plan"
  | "progress"
  | "issue"
  | "deferred"
  | "cross_reference"
  | "question"
  | "review"
  | "readiness_check"
  | "approval"
  | "plan_revision"
  | "drift";

export type CommentSource = "human" | "agent";

// spec-100 (geo-comments): a system-authored action button on a comment.
//   kind='agent'   — invokes the side agent with `prompt` (system-defined,
//                    never user-typed). `prompt` is required for this kind.
//   kind='dismiss' — closes the comment without invoking the agent.
// `kind` is deliberately an open string so v2 colleague-routing can add
// 'route' without a schema migration (spec-100 §7, "schema discipline").
export interface CommentAction {
  label: string;
  kind: string;
  prompt?: string;
}

// spec-100: attention-routing audience. v0 always writes the literal 'all';
// v1+ will start writing a userId[] when the agent targets specific readers.
// Reserved on the model now so v1 adds no migration.
export type CommentAudience = "all" | string[];

// Cross-reference target type — populated alongside `referenceId` only for
// `comment_type='cross_reference'` rows (Section 7 of doc-10).
export type CommentReferenceType = "task" | "spec" | "decision" | "standard";

// docType is free-form in the DB column (the CHECK constraint stays off so new types
// don't require a migration), but the agent + UI validate against this list.
// Per b-105: the legacy docType values introduced in earlier migrations
// (originally `strategy`, renamed `mission`, renamed `brief`) were migrated to
// `spec` (drizzle/0063) and removed from the union; new code uses `spec`
// exclusively. Old values are preserved in historical migration SQL only.
export type DocType =
  | "spec"
  | "standard"
  | "document"
  | "execution_plan"
  | "adr"
  | "runbook";

export const ROLES: readonly Role[] = ["member", "administrator"] as const;
export const MEMBERSHIP_STATUSES: readonly MembershipStatus[] = ["active", "disabled"] as const;
export const DOC_STATUSES: readonly DocStatus[] = [
  "draft",
  "review",
  "implementation",
  "done",
  "approved",
  "specify",
  "build",
  "verify",
] as const;
export const SPEC_STATUSES: readonly SpecStatus[] = ["draft", "specify", "build", "verify", "done"] as const;
export const TASK_STATUSES: readonly TaskStatus[] = ["not_started", "in_progress", "complete"] as const;
export const DECISION_STATUSES: readonly DecisionStatus[] = ["open", "resolved", "candidate", "rejected"] as const;
export const COMMENT_TYPES: readonly CommentType[] = [
  "discussion",
  "plan",
  "progress",
  "issue",
  "deferred",
  "cross_reference",
  "question",
  "review",
  "readiness_check",
  "approval",
  "plan_revision",
  "drift",
] as const;
export const COMMENT_SOURCES: readonly CommentSource[] = ["human", "agent"] as const;
export const COMMENT_REFERENCE_TYPES: readonly CommentReferenceType[] = [
  "task",
  "spec",
  "decision",
  "standard",
] as const;
// Order matters: DOC_TYPES[1] is hard-pinned to "standard" by services/standards*.ts
// (defensive STANDARD_DOC_TYPE constants verify this at module load). Keep "spec"
// at index 0 and "standard" at index 1.
export const DOC_TYPES: readonly DocType[] = [
  "spec",
  "standard",
  "document",
  "execution_plan",
  "adr",
  "runbook",
] as const;

export function isRole(value: unknown): value is Role {
  return value === "member" || value === "administrator";
}

export function isMembershipStatus(value: unknown): value is MembershipStatus {
  return value === "active" || value === "disabled";
}

export function isDocStatus(value: unknown): value is DocStatus {
  return (
    value === "draft" ||
    value === "review" ||
    value === "implementation" ||
    value === "done" ||
    value === "approved" ||
    value === "specify" ||
    value === "build" ||
    value === "verify"
  );
}

export function isSpecStatus(value: unknown): value is SpecStatus {
  return (
    value === "draft" ||
    value === "specify" ||
    value === "build" ||
    value === "verify" ||
    value === "done"
  );
}

// Per t-7 (Spec cite) / t-20 W-A (qualified handles): standard references take
// three forms:
//   - bare              `dec-N`        (legacy)
//   - doc-qualified     `doc-N:dec-M`  (legacy qualified)
//   - Spec-qualified    `mis-N:dec-M`  (canonical — auto-asserts parent docType=spec.
//                                      Prefix `mis-` is a pre-Spec historical
//                                      form preserved under b-105 allowlist.)
// Use this guard to detect any of the three before passing through to handle
// resolution.
export function isCanonicalDecisionHandle(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^(?:(?:mis|doc)-\d+:)?dec-\d+$/.test(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "not_started" || value === "in_progress" || value === "complete";
}

export function isDecisionStatus(value: unknown): value is DecisionStatus {
  return value === "open" || value === "resolved" || value === "candidate" || value === "rejected";
}

export function isCommentType(value: unknown): value is CommentType {
  return typeof value === "string" && (COMMENT_TYPES as readonly string[]).includes(value);
}

export function isCommentSource(value: unknown): value is CommentSource {
  return value === "human" || value === "agent";
}

export function isCommentReferenceType(value: unknown): value is CommentReferenceType {
  return (
    typeof value === "string" &&
    (COMMENT_REFERENCE_TYPES as readonly string[]).includes(value)
  );
}

export function isDocType(value: unknown): value is DocType {
  return typeof value === "string" && (DOC_TYPES as readonly string[]).includes(value);
}
