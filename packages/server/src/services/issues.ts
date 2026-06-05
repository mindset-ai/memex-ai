// Service layer for Issues (spec-112).
//
// An Issue is a bug or a todo raised against a Spec. It is the human/agent-level
// backlog primitive that closes the bug→failing-AC→green-AC→resolved loop (bugs)
// or carries forward-looking work that isn't yet a committed Task (todos, ac-29/
// ac-30).
//
// "No new infrastructure" (s-4): this mirrors and EXTENDS the acs / tasks /
// decisions machinery. Tenancy is via issues.memex_id (NOT NULL, denormalised);
// parentage + the per-Spec handle space is via doc_id → documents.id (the GENERIC
// docId column — NOT the legacy `brief_id` carve-out acs carries). Every write
// goes through mutate() with entity:"issue", docId:specId and emits on the unified
// bus (std-8, ac-11). The `issue-N` handle is minted by withSeqRetry against
// UNIQUE(doc_id, seq), independent of the ac/task/comment/decision seq spaces on
// the same Spec (ac-10).
//
// Unauthorized resource access returns 404, not 403 (std-7) — getIssue /
// assertSpecInMemex throw NotFoundError when the row/Spec isn't in the memex.
//
// V1 surface:
//   createIssue        — author an Issue under a Spec (any Spec status — NO phase guard, ac-12)
//   listIssuesForSpec  — list Issues for a Spec, optionally filtered by type/status
//   getIssue           — fetch one Issue by id, tenancy-scoped
//   updateIssue        — edit title/body/severity
//   updateIssueStatus  — transition status (validated against ISSUE_STATUSES, ac-16)
//   deleteIssue        — hard delete

import { and, eq, asc, desc } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  issues,
  documents,
  tasks,
  acs,
  acParentLinks,
  taskSatisfiesAc,
  testEvents,
  memexes,
  namespaces,
} from "../db/schema.js";
import type { Issue, Task } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { nextSeq, withSeqRetry } from "./shared/sequence.js";
import { embedAndStoreIssue } from "./memex-embeddings.js";
import { buildAcRef } from "./acs.js";

export type { Issue };

// Fire-and-forget embed for an Issue whose searchable text (title/body) just
// changed. Mirrors maybeEmbedDecisionInBackground in services/decisions.ts
// (b-34 T-4) — Issues ride the same RRF FTS+vector search path (ac-13). We pass
// memexId for defence-in-depth (the helper filters its lookup by memex_id so a
// stray caller can't re-embed a stranger's Issue by UUID), and swallow
// rejections: an embedding failure must NEVER surface as a failed Issue write
// (best-effort contract — the backfill catches a missed row next run).
function maybeEmbedIssueInBackground(memexId: string, issueId: string): void {
  void embedAndStoreIssue(issueId, { memexId }).catch(() => {
    // already logged inside the helper; nothing more to do.
  });
}

// bug | todo (ac-3 / ac-30). Mirrors the `issues_type_valid` CHECK in schema.ts.
export type IssueType = "bug" | "todo";
export const ISSUE_TYPES = ["bug", "todo"] as const;
export function isIssueType(value: string): value is IssueType {
  return (ISSUE_TYPES as readonly string[]).includes(value);
}

// open | converted | resolved | wont_fix (ac-16). Mirrors the
// `issues_status_valid` CHECK in schema.ts — exactly this set, nothing else.
export type IssueStatus = "open" | "converted" | "resolved" | "wont_fix";
export const ISSUE_STATUSES = ["open", "converted", "resolved", "wont_fix"] as const;
export function isIssueStatus(value: string): value is IssueStatus {
  return (ISSUE_STATUSES as readonly string[]).includes(value);
}

// human | agent — mirrors decisions.source / doc_comments.source.
export type IssueSource = "human" | "agent";
export const ISSUE_SOURCES = ["human", "agent"] as const;
export function isIssueSource(value: string): value is IssueSource {
  return (ISSUE_SOURCES as readonly string[]).includes(value);
}

// Verifies the Spec (document) exists in the memex; throws NotFoundError otherwise.
// Mirrors assertBriefInMemex (acs.ts) / assertDocInAccount (tasks.ts, decisions.ts).
// Unauthorized resource access returns 404, not 403 (std-7).
async function assertSpecInMemex(memexId: string, docId: string): Promise<void> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Spec ${docId} not found in memex ${memexId}`);
  }
}

export interface CreateIssueInput {
  memexId: string;
  docId: string;
  title: string;
  body: string;
  type: IssueType;
  severity?: string | null;
  source?: IssueSource;
  createdByUserId?: string | null;
}

export async function createIssue(input: CreateIssueInput): Promise<Mutated<Issue>> {
  const {
    memexId,
    docId,
    title,
    body,
    type,
    severity = null,
    source = "human",
    createdByUserId = null,
  } = input;

  if (!title.trim()) {
    throw new ValidationError("Issue title is required");
  }
  if (!isIssueType(type)) {
    throw new ValidationError(
      `Invalid issue type '${type}'. Must be one of: ${ISSUE_TYPES.join(", ")}`,
    );
  }
  if (!isIssueSource(source)) {
    throw new ValidationError(
      `Invalid issue source '${source}'. Must be one of: ${ISSUE_SOURCES.join(", ")}`,
    );
  }
  // NO phase guard (ac-12): an Issue may be raised against a Spec in ANY status —
  // draft / plan / build / verify / done, paused or archived. We assert the Spec
  // exists in the memex (tenancy, std-7) but never read or gate on its status.
  await assertSpecInMemex(memexId, docId);

  // Allocate seq + insert under withSeqRetry, mirroring createTask / createAc.
  // Concurrent creates under the same Spec shouldn't 23505 on the unique
  // constraint — the `issue-N` seq is independent of every other handle space on the
  // Spec (ac-10).
  return mutate(
    {},
    { memexId, docId, entity: "issue", action: "created" },
    async () =>
      withSeqRetry(
        async () => {
          const seq = await nextSeq(issues, issues.seq, issues.docId, docId);
          const [row] = await db
            .insert(issues)
            .values({
              memexId,
              docId,
              seq,
              title,
              body,
              type,
              severity,
              status: "open",
              source,
              createdByUserId,
            })
            .returning();
          // Fire-and-forget: embed the new Issue's title+body so it's searchable
          // (ac-13). Never blocks or fails the write (best-effort, t-3).
          maybeEmbedIssueInBackground(memexId, row.id);
          return row;
        },
        "issues_doc_id_seq_unique",
      ),
  );
}

export interface ListIssuesFilter {
  type?: IssueType;
  status?: IssueStatus;
}

export async function listIssuesForSpec(
  memexId: string,
  docId: string,
  filter: ListIssuesFilter = {},
): Promise<Issue[]> {
  await assertSpecInMemex(memexId, docId);
  const conditions = [eq(issues.memexId, memexId), eq(issues.docId, docId)];
  if (filter.type) conditions.push(eq(issues.type, filter.type));
  if (filter.status) conditions.push(eq(issues.status, filter.status));
  return db.query.issues.findMany({
    where: and(...conditions),
    orderBy: [asc(issues.seq)],
  });
}

export async function getIssue(memexId: string, issueId: string): Promise<Issue> {
  const row = await db.query.issues.findFirst({
    where: and(eq(issues.id, issueId), eq(issues.memexId, memexId)),
  });
  if (!row) {
    // std-7: unauthorized resource access returns 404, not 403.
    throw new NotFoundError(`Issue ${issueId} not found in memex ${memexId}`);
  }
  return row;
}

export interface UpdateIssueInput {
  title?: string;
  body?: string;
  severity?: string | null;
}

export async function updateIssue(
  memexId: string,
  issueId: string,
  updates: UpdateIssueInput,
): Promise<Mutated<Issue>> {
  const issue = await getIssue(memexId, issueId); // tenancy check (std-7)

  const setValues: Record<string, unknown> = {};
  if (updates.title !== undefined) {
    if (!updates.title.trim()) {
      throw new ValidationError("Issue title is required");
    }
    setValues.title = updates.title;
  }
  if (updates.body !== undefined) setValues.body = updates.body;
  if (updates.severity !== undefined) setValues.severity = updates.severity;

  if (Object.keys(setValues).length === 0) {
    // No caller-supplied fields means no DB write; brand the return so the type
    // contract still says this went through mutate(). Mirrors updateTask.
    return mutate(
      {},
      { memexId, docId: issue.docId, entity: "issue", action: "updated" },
      async () => issue,
      { silent: true },
    );
  }
  setValues.updatedAt = new Date();

  return mutate(
    {},
    { memexId, docId: issue.docId, entity: "issue", action: "updated" },
    async () => {
      const [row] = await db
        .update(issues)
        .set(setValues)
        .where(and(eq(issues.id, issueId), eq(issues.memexId, memexId)))
        .returning();
      // Re-embed: an edit to title/body changes the searchable chunk (ac-13).
      // Fire-and-forget — a failing embed must never fail the write (t-3).
      maybeEmbedIssueInBackground(memexId, row.id);
      return row;
    },
  );
}

export async function updateIssueStatus(
  memexId: string,
  issueId: string,
  status: string,
): Promise<Mutated<Issue>> {
  // ac-16: reject any status value outside the allowed set BEFORE the write, so a
  // bad value never reaches the `issues_status_valid` CHECK as a raw 23514.
  if (!isIssueStatus(status)) {
    throw new ValidationError(
      `Invalid issue status '${status}'. Must be one of: ${ISSUE_STATUSES.join(", ")}`,
    );
  }
  const issue = await getIssue(memexId, issueId); // tenancy check (std-7)

  return mutate(
    {},
    { memexId, docId: issue.docId, entity: "issue", action: "updated" },
    async () => {
      const [row] = await db
        .update(issues)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(issues.id, issueId), eq(issues.memexId, memexId)))
        .returning();
      return row;
    },
  );
}

export async function deleteIssue(memexId: string, issueId: string): Promise<Mutated<Issue>> {
  const issue = await getIssue(memexId, issueId); // tenancy check + capture row for return

  return mutate(
    {},
    { memexId, docId: issue.docId, entity: "issue", action: "deleted" },
    async () => {
      await db.delete(issues).where(and(eq(issues.id, issueId), eq(issues.memexId, memexId)));
      return issue;
    },
  );
}

// ══════════════════════════════════════════════════════════════════════
// Conversions + lifecycle (spec-112 s-5, t-6)
// ══════════════════════════════════════════════════════════════════════
//
// The Issue state machine's bidirectional bridges (the "two planes", ac-29) plus
// the auto-resolve hooks. Down-bridge (Issue→Task), up-bridge (Task→Issue),
// sideways (Issue→Spec via promoteFromIssueRef, wired in documents.ts/tool-specs),
// and the auto-resolve transitions that fire on task-completion / test-event
// ingestion / child-Spec-done.
//
// "No new infrastructure" (s-4): every write rides the existing
// tasks/acs/ac_parent_links/task_satisfies_ac tables via mutate()+bus (std-8).

// Resolve the namespace/memex/spec-handle slug components for a Spec doc so we can
// rebuild an AC's canonical ref (buildAcRef) to match against test_events.ac_uid.
// Mirrors resolveBriefSlugsForRef in acs.ts (kept local — that one isn't exported).
async function resolveSpecSlugs(
  docId: string,
): Promise<{ namespace: string; memex: string; briefHandle: string } | null> {
  const [row] = await db
    .select({
      namespace: namespaces.slug,
      memex: memexes.slug,
      briefHandle: documents.handle,
    })
    .from(documents)
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(documents.id, docId))
    .limit(1);
  if (!row || !row.briefHandle) return null;
  return { namespace: row.namespace, memex: row.memex, briefHandle: row.briefHandle };
}

// ── Down-bridge: Issue → Task (ac-20 / ac-21, dec-6 / dec-7) ──────────────────
//
// ONE atomic mutate() wrapping a db.transaction(): create the Task (seeded from
// the Issue), mint an `implementation` AC stating the Issue's expected behaviour,
// create the task_satisfies_ac link, create the ac_parent_links row
// (parent_kind='issue', parent_id=issue.id), and flip the Issue → converted with
// its satisfying_task_id set. Partial failure rolls EVERYTHING back — no Task
// without its AC, no AC without its links, no half-converted Issue (ac-20).

export interface ConvertIssueToTaskResult {
  task: Task;
  acId: string;
  issue: Issue;
}

export async function convertIssueToTask(
  memexId: string,
  issueId: string,
): Promise<Mutated<ConvertIssueToTaskResult>> {
  const issue = await getIssue(memexId, issueId); // tenancy check (std-7)

  if (issue.status !== "open") {
    throw new ValidationError(
      `Issue ${issueId} is ${issue.status}; only an 'open' Issue can be converted to a Task.`,
    );
  }

  // The Task title/body are seeded from the Issue; the AC statement captures the
  // Issue's expected behaviour (for a bug, that the symptom no longer reproduces).
  const taskTitle = issue.title;
  const taskDescription =
    `${issue.body}\n\n` +
    `(Converted from Issue issue-${issue.seq} [${issue.type}` +
    (issue.severity ? `, ${issue.severity}` : "") +
    `].)`;
  const acStatement =
    issue.type === "bug"
      ? `The bug from Issue issue-${issue.seq} ("${issue.title}") no longer reproduces.`
      : `The behaviour described by Issue issue-${issue.seq} ("${issue.title}") is delivered.`;

  return mutate(
    {},
    [
      { memexId, docId: issue.docId, entity: "task", action: "created" },
      { memexId, docId: issue.docId, entity: "ac", action: "created" },
      { memexId, docId: issue.docId, entity: "issue", action: "updated" },
    ],
    async () =>
      db.transaction(async (tx) => {
        // 1. Task — allocate its per-Spec t-N seq under the same UNIQUE(doc_id,seq)
        //    contract createTask uses. Inside the tx so a later failure rolls it back.
        const taskSeq = await nextSeq(tasks, tasks.seq, tasks.docId, issue.docId);
        const [task] = await tx
          .insert(tasks)
          .values({
            memexId,
            docId: issue.docId,
            seq: taskSeq,
            title: taskTitle,
            description: taskDescription,
            acceptanceCriteria: [],
            sectionRef: null,
            status: "not_started",
          })
          .returning();

        // 2. Implementation AC — its per-Spec ac-N seq is independent of the task seq.
        const acSeq = await nextSeq(acs, acs.seq, acs.briefId, issue.docId);
        const [ac] = await tx
          .insert(acs)
          .values({
            memexId,
            briefId: issue.docId,
            seq: acSeq,
            kind: "implementation",
            statement: acStatement,
            status: "active",
          })
          .returning();

        // 3. task_satisfies_ac — the verifying link the auto-resolve hook reads.
        await tx.insert(taskSatisfiesAc).values({ taskId: task.id, acId: ac.id });

        // 4. ac_parent_links — parent the AC on the Issue (parent_kind='issue', ac-19).
        await tx.insert(acParentLinks).values({
          acId: ac.id,
          parentKind: "issue",
          parentId: issue.id,
        });

        // 5. Issue → converted, recording the satisfying Task (ac-21).
        const [updatedIssue] = await tx
          .update(issues)
          .set({ status: "converted", satisfyingTaskId: task.id, updatedAt: new Date() })
          .where(and(eq(issues.id, issue.id), eq(issues.memexId, memexId)))
          .returning();

        return { task, acId: ac.id, issue: updatedIssue };
      }),
  );
}

// ── Auto-resolve hook (ac-22, dec-6) ──────────────────────────────────────────
//
// A `converted` Issue transitions → `resolved` exactly when its satisfying Task is
// `complete` AND the verifying AC's LATEST test_event is a pass. Otherwise it stays
// `converted` (a complete Task with a red/absent AC is NOT resolved — the bug isn't
// proven fixed, ac-7). Called from the task-completion path (tasks.ts) and the
// test-event ingestion path (routes/test-events.ts) so either trigger can close
// the loop. Best-effort + idempotent: re-running on an already-resolved Issue is a
// no-op; a Task with no converted Issue pointing at it is a no-op.

// Has the verifying AC for this conversion gone green? Reads the AC linked via
// task_satisfies_ac to the satisfying Task, rebuilds its canonical ref, and checks
// the LATEST test_event by created_at is a 'pass'.
async function verifyingAcIsGreen(satisfyingTaskId: string, docId: string): Promise<boolean> {
  const links = await db
    .select({ acId: taskSatisfiesAc.acId, seq: acs.seq })
    .from(taskSatisfiesAc)
    .innerJoin(acs, eq(acs.id, taskSatisfiesAc.acId))
    .where(eq(taskSatisfiesAc.taskId, satisfyingTaskId));
  if (links.length === 0) return false;

  const slugs = await resolveSpecSlugs(docId);
  if (!slugs) return false;

  // ALL verifying ACs for the Task must be green (any failing/absent latest event
  // blocks resolution). For the conversion path there's exactly one, but we treat
  // the general case so multi-AC tasks don't resolve prematurely.
  for (const link of links) {
    const acUid = buildAcRef(slugs, link.seq);
    const [latest] = await db
      .select({ status: testEvents.status })
      .from(testEvents)
      .where(eq(testEvents.acUid, acUid))
      .orderBy(desc(testEvents.createdAt))
      .limit(1);
    if (!latest || latest.status !== "pass") return false;
  }
  return true;
}

// Try to auto-resolve every `converted` Issue whose satisfying Task is the given
// Task. Fires from the task-completion path. Returns the ids of Issues resolved.
export async function maybeAutoResolveIssuesForTask(
  memexId: string,
  taskId: string,
): Promise<string[]> {
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)),
  });
  if (!task || task.status !== "complete") return [];

  const candidates = await db.query.issues.findMany({
    where: and(
      eq(issues.memexId, memexId),
      eq(issues.satisfyingTaskId, taskId),
      eq(issues.status, "converted"),
    ),
  });
  if (candidates.length === 0) return [];

  const green = await verifyingAcIsGreen(taskId, task.docId);
  if (!green) return [];

  const resolved: string[] = [];
  for (const issue of candidates) {
    await mutate(
      {},
      { memexId, docId: issue.docId, entity: "issue", action: "updated" },
      async () => {
        const [row] = await db
          .update(issues)
          .set({ status: "resolved", updatedAt: new Date() })
          .where(
            and(
              eq(issues.id, issue.id),
              eq(issues.memexId, memexId),
              // Re-check status in the predicate so a concurrent transition doesn't
              // double-resolve (idempotent).
              eq(issues.status, "converted"),
            ),
          )
          .returning();
        return row ?? issue;
      },
    );
    resolved.push(issue.id);
  }
  return resolved;
}

// Try to auto-resolve any Issue whose verifying AC just received a passing
// test_event. Fires from the test-event ingestion path: an AC may go green AFTER
// its satisfying Task is already complete, so this is the second trigger that
// closes the bug→failing-AC→green-AC→resolved loop (ac-7, ac-22). `acUid` is the
// canonical ref the test_events row carried; we map it back to the Task(s) that
// satisfy it and re-run the per-Task gate.
export async function maybeAutoResolveIssuesForAcUid(acUid: string): Promise<string[]> {
  // ac_uid grammar: <ns>/<mx>/specs/<spec-handle>/acs/ac-<seq>. Reverse it to the AC
  // row, then to the Task(s) that satisfy it, then run the same gate as the task path.
  // Scope the doc lookup by namespace+memex slug — `documents.handle` (e.g. spec-1)
  // is per-memex, NOT globally unique, so a bare handle match would collide across
  // tenants (std-7: a cross-tenant collision must never resolve to the wrong doc).
  const m = acUid.match(/^([^/]+)\/([^/]+)\/specs\/([^/]+)\/acs\/ac-(\d+)$/);
  if (!m) return [];
  const namespaceSlug = m[1];
  const memexSlug = m[2];
  const specHandle = m[3];
  const acSeq = Number(m[4]);

  const [doc] = await db
    .select({ id: documents.id, memexId: documents.memexId })
    .from(documents)
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(
      and(
        eq(documents.handle, specHandle),
        eq(memexes.slug, memexSlug),
        eq(namespaces.slug, namespaceSlug),
      ),
    )
    .limit(1);
  if (!doc) return [];

  const [ac] = await db
    .select({ id: acs.id })
    .from(acs)
    .where(and(eq(acs.briefId, doc.id), eq(acs.seq, acSeq)))
    .limit(1);
  if (!ac) return [];

  const satisfying = await db
    .select({ taskId: taskSatisfiesAc.taskId })
    .from(taskSatisfiesAc)
    .where(eq(taskSatisfiesAc.acId, ac.id));

  const resolved: string[] = [];
  for (const s of satisfying) {
    const ids = await maybeAutoResolveIssuesForTask(doc.memexId, s.taskId);
    resolved.push(...ids);
  }
  return resolved;
}

// ── Up-bridge: Task → Issue (ac-30 / ac-31 / ac-32, dec-9) ────────────────────
//
// The fourth escalation shape. An agent Task that hits agent-impossible work is
// pushed up into a human Todo Issue and then DELETED. If the Task originated from
// an issue→task conversion (an Issue points at it via satisfying_task_id), we do
// NOT create a second Issue — we revert that ORIGIN Issue converted→open and fold
// the offline-work reason into its body (ac-31). One Issue, not two.

export interface KickTaskToIssueResult {
  issue: Issue;
  deletedTaskId: string;
  reverted: boolean;
}

export async function kickTaskToIssue(
  memexId: string,
  taskId: string,
  reason: string,
): Promise<Mutated<KickTaskToIssueResult>> {
  if (!reason.trim()) {
    throw new ValidationError("kick_task_to_issue requires a non-empty offline-work reason.");
  }

  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)),
  });
  if (!task) {
    throw new NotFoundError(`Task ${taskId} not found in memex ${memexId}`);
  }

  // Did this Task come from an issue→task conversion? If so, revert that origin
  // Issue instead of minting a fresh one (ac-31).
  const origin = await db.query.issues.findFirst({
    where: and(eq(issues.memexId, memexId), eq(issues.satisfyingTaskId, taskId)),
  });

  const noteFor = (existingBody: string) =>
    `${existingBody}\n\n— Kicked back from agent Task t-${task.seq}: ${reason}`;

  return mutate(
    {},
    origin
      ? [
          { memexId, docId: task.docId, entity: "issue", action: "updated" },
          { memexId, docId: task.docId, entity: "task", action: "deleted" },
        ]
      : [
          { memexId, docId: task.docId, entity: "issue", action: "created" },
          { memexId, docId: task.docId, entity: "task", action: "deleted" },
        ],
    async () =>
      db.transaction(async (tx) => {
        let issue: Issue;
        let reverted = false;

        if (origin) {
          // Revert origin Issue converted→open, fold the note in, drop the stale
          // satisfying_task_id (the Task is about to be deleted). One Issue (ac-31).
          const [row] = await tx
            .update(issues)
            .set({
              status: "open",
              body: noteFor(origin.body),
              satisfyingTaskId: null,
              updatedAt: new Date(),
            })
            .where(and(eq(issues.id, origin.id), eq(issues.memexId, memexId)))
            .returning();
          issue = row;
          reverted = true;
        } else {
          // Fresh open todo Issue on the Task's Spec seeded from the Task + reason
          // (ac-30). A normal Issue — open, trips the gate, searchable (ac-32).
          const seq = await nextSeq(issues, issues.seq, issues.docId, task.docId);
          const [row] = await tx
            .insert(issues)
            .values({
              memexId,
              docId: task.docId,
              seq,
              title: task.title,
              body: `${task.description}\n\n— Kicked back from agent Task t-${task.seq}: ${reason}`,
              type: "todo",
              severity: null,
              status: "open",
              source: "agent",
              createdByUserId: null,
            })
            .returning();
          issue = row;
        }

        // Delete the dead agent Task. ON DELETE SET NULL on issues.satisfying_task_id
        // means even if we somehow missed the origin lookup the Issue is never
        // cascade-deleted; here we've already nulled it on the reverted Issue.
        await tx.delete(tasks).where(and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)));

        return { issue, deletedTaskId: taskId, reverted };
      }),
    // The new/ reverted Issue must be searchable (ac-32) — embed it fire-and-forget,
    // outside the tx (the row is committed by the time mutate emits).
  ).then((result) => {
    maybeEmbedIssueInBackground(memexId, result.issue.id);
    return result;
  });
}

// ── Sideways: Issue → Spec auto-resolve (ac-24) ───────────────────────────────
//
// When a child Spec promoted from an Issue (promoteFromIssueRef) reaches `done`,
// the source Issue transitions converted→resolved. Fires from updateDocStatus in
// documents.ts. Best-effort + idempotent.
export async function maybeAutoResolveIssuesForPromotedDoc(
  memexId: string,
  childDocId: string,
): Promise<string[]> {
  const child = await db.query.documents.findFirst({
    where: and(eq(documents.id, childDocId), eq(documents.memexId, memexId)),
  });
  if (!child || child.status !== "done") return [];

  const candidates = await db.query.issues.findMany({
    where: and(
      eq(issues.memexId, memexId),
      eq(issues.promotedDocId, childDocId),
      eq(issues.status, "converted"),
    ),
  });
  if (candidates.length === 0) return [];

  const resolved: string[] = [];
  for (const issue of candidates) {
    await mutate(
      {},
      { memexId, docId: issue.docId, entity: "issue", action: "updated" },
      async () => {
        const [row] = await db
          .update(issues)
          .set({ status: "resolved", updatedAt: new Date() })
          .where(
            and(
              eq(issues.id, issue.id),
              eq(issues.memexId, memexId),
              eq(issues.status, "converted"),
            ),
          )
          .returning();
        return row ?? issue;
      },
    );
    resolved.push(issue.id);
  }
  return resolved;
}

// ── Sideways: mark an Issue as promoted-to-child-Spec (ac-23 / ac-24) ─────────
//
// Called from the promoteFromIssueRef path in tool-specs after promoteToSpec has
// minted the child Spec. Sets the Issue → converted and records promoted_doc_id so
// the child-done auto-resolve hook can find it. The child Spec's parent_doc_id is
// the Issue's SOURCE Spec (set by promoteToSpec), preserving lineage (ac-23).
export async function markIssuePromoted(
  memexId: string,
  issueId: string,
  childDocId: string,
): Promise<Mutated<Issue>> {
  const issue = await getIssue(memexId, issueId); // tenancy check (std-7)
  return mutate(
    {},
    { memexId, docId: issue.docId, entity: "issue", action: "updated" },
    async () => {
      const [row] = await db
        .update(issues)
        .set({ status: "converted", promotedDocId: childDocId, updatedAt: new Date() })
        .where(and(eq(issues.id, issueId), eq(issues.memexId, memexId)))
        .returning();
      return row;
    },
  );
}
