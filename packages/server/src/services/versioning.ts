// spec-448 t-2/t-3/t-4 — Document versioning: cut, view-as-of, and rollback.
//
// A "version" is an immutable, content-addressed snapshot of a Spec's (or any
// doc-type's — dec-5/ac-34: the substrate is doc-type-agnostic) full artifact
// graph: sections + decisions + acs + tasks + issues + comments. Snapshots
// live in `document_versions` (t-1 schema); `documents.version` is the
// monotonic counter for the doc's current (uncut) working state.
//
// Three operations:
//   cutVersion       — freeze the CURRENT graph as an immutable version, then
//                       advance documents.version by one (dec-6). Artifact
//                       classes NOT carried forward are left behind: their
//                       live rows are stamped retired_at_version=N so they
//                       stop appearing in the working set but still render
//                       when viewing the frozen version (dec-2). Narrative
//                       sections always carry — only decisions/acs/tasks/
//                       issues/comments are prunable.
//   getVersionSnapshot — a read-only "view as-of vK" — returns the frozen
//                       graph exactly as archived (dec-1), no live joins.
//   restoreVersion    — rollback. Auto-freezes the current live state first
//                       (so it's never lost, ac-20/dec-3), then materialises
//                       a NEW higher version whose content equals the chosen
//                       prior snapshot (ac-21) and records restored_from_version
//                       (ac-22). Version numbers only ever increase; the doc's
//                       id/handle/status are never touched (ac-23). Whole-graph
//                       restore only in v1 (dec-3) — selective/partial restore
//                       is out of scope.
//
// Every write here routes through mutate() (std-8) with the caller's
// RequestCtx threaded onto the activity contract (std-32).

import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  docSections,
  docComments,
  decisions,
  acs,
  tasks,
  issues,
  documentVersions,
} from "../db/schema.js";
import type {
  Doc,
  DocSection,
  DocComment,
  Decision,
  Task,
  Issue,
  DocumentVersion,
} from "../db/schema.js";
import type { Ac } from "./acs.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { resolveActorColumns } from "./actor.js";

// Structural transaction handle — mirrors the `Tx` alias convention used by
// clause-refs.ts / clauses.ts / user-namespaces.ts.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── Carry-forward vocabulary (dec-2) ─────────────────────────────────────
// Narrative sections ALWAYS carry forward — they are never a candidate for
// retirement via this mechanism, so they're deliberately excluded from this
// set (t-2: "Narrative sections always carry").
export const CARRY_FORWARD_CLASSES = [
  "decisions",
  "acs",
  "tasks",
  "issues",
  "comments",
] as const;
export type CarryForwardClass = (typeof CARRY_FORWARD_CLASSES)[number];

// The full artifact graph a version snapshot captures. Comments carry an
// extra `versionAtWrite` — the documents.version that was active at the
// moment the comment was originally authored (dec-4/ac-24), derived from
// correlating the comment's createdAt against this doc's prior cuts. This
// lets "view as-of vK" render vK's comments even though doc_comments has no
// dedicated "written at version" column of its own.
export interface ArtifactSnapshot {
  sections: DocSection[];
  decisions: Decision[];
  acs: Ac[];
  tasks: Task[];
  issues: Issue[];
  comments: Array<DocComment & { versionAtWrite: number }>;
}

// ── Canonical JSON + checksum (dec-1) ────────────────────────────────────

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
    return out;
  }
  return value;
}

/** Content-addressed sha256 over the canonical (stable-key-ordered) JSON form. */
export function computeSnapshotChecksum(snapshot: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(snapshot))).digest("hex");
}

// ── Snapshot construction ────────────────────────────────────────────────

// Which documents.version was "live" at a given timestamp, derived from the
// doc's prior cuts (each document_versions row marks the end of one version
// and the start of the next). No prior cuts => the doc has always been on v1.
function versionActiveAt(
  priorCuts: Array<{ versionNumber: number; createdAt: Date }>,
  at: Date,
): number {
  let active = 1;
  for (const cut of priorCuts) {
    if (cut.createdAt <= at) active = cut.versionNumber + 1;
  }
  return active;
}

// Full-fidelity graph read: EVERY row tied to the doc across the six
// artifact tables, regardless of status/retired_at_version — a version
// snapshot is an archival record, not a live-view projection (dec-1/dec-2:
// "the version snapshot read INCLUDES" retired artifacts).
async function buildSnapshot(tx: Tx, docId: string): Promise<ArtifactSnapshot> {
  const [sectionRows, decisionRows, acRows, taskRows, issueRows, commentRows, priorCuts] =
    await Promise.all([
      tx.select().from(docSections).where(eq(docSections.docId, docId)).orderBy(asc(docSections.seq)),
      tx.select().from(decisions).where(eq(decisions.docId, docId)).orderBy(asc(decisions.seq)),
      tx.select().from(acs).where(eq(acs.briefId, docId)).orderBy(asc(acs.seq)),
      tx.select().from(tasks).where(eq(tasks.docId, docId)).orderBy(asc(tasks.seq)),
      tx.select().from(issues).where(eq(issues.docId, docId)).orderBy(asc(issues.seq)),
      tx.select().from(docComments).where(eq(docComments.docId, docId)).orderBy(asc(docComments.seq)),
      tx
        .select({ versionNumber: documentVersions.versionNumber, createdAt: documentVersions.createdAt })
        .from(documentVersions)
        .where(eq(documentVersions.docId, docId))
        .orderBy(asc(documentVersions.versionNumber)),
    ]);

  const comments = commentRows.map((c) => ({
    ...c,
    versionAtWrite: versionActiveAt(priorCuts, c.createdAt),
  }));

  return {
    sections: sectionRows,
    decisions: decisionRows,
    acs: acRows,
    tasks: taskRows,
    issues: issueRows,
    comments,
  };
}

// Live (filtered) graph read: the CURRENT working set only — the same
// exclusions the primary get_doc/listDecisions/listTasks/listAcsForBrief/
// listIssuesForSpec reads apply (soft-deleted status + retired_at_version,
// gap closure t-6/ac-18). Used by the diff endpoint to let a caller compare a
// frozen version against the doc's current live state ("primary") without
// requiring a version to have been cut for it yet (ac-26: the primary is
// selectable alongside any prior version).
async function buildLiveSnapshot(memexId: string, docId: string): Promise<ArtifactSnapshot> {
  const [sectionRows, decisionRows, acRows, taskRows, issueRows, commentRows, priorCuts] =
    await Promise.all([
      db
        .select()
        .from(docSections)
        .where(
          and(
            eq(docSections.docId, docId),
            sql`(${docSections.status} <> 'deleted' OR ${docSections.status} IS NULL)`,
            isNull(docSections.retiredAtVersion),
          ),
        )
        .orderBy(asc(docSections.seq)),
      db
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.docId, docId),
            eq(decisions.memexId, memexId),
            ne(decisions.status, "deleted"),
            isNull(decisions.retiredAtVersion),
          ),
        )
        .orderBy(asc(decisions.seq)),
      db
        .select()
        .from(acs)
        .where(and(eq(acs.briefId, docId), eq(acs.memexId, memexId), isNull(acs.retiredAtVersion)))
        .orderBy(asc(acs.seq)),
      db
        .select()
        .from(tasks)
        .where(and(eq(tasks.docId, docId), eq(tasks.memexId, memexId), isNull(tasks.retiredAtVersion)))
        .orderBy(asc(tasks.seq)),
      db
        .select()
        .from(issues)
        .where(and(eq(issues.docId, docId), eq(issues.memexId, memexId), isNull(issues.retiredAtVersion)))
        .orderBy(asc(issues.seq)),
      db
        .select()
        .from(docComments)
        .where(and(eq(docComments.docId, docId), isNull(docComments.retiredAtVersion)))
        .orderBy(asc(docComments.seq)),
      db
        .select({ versionNumber: documentVersions.versionNumber, createdAt: documentVersions.createdAt })
        .from(documentVersions)
        .where(eq(documentVersions.docId, docId))
        .orderBy(asc(documentVersions.versionNumber)),
    ]);

  const comments = commentRows.map((c) => ({
    ...c,
    versionAtWrite: versionActiveAt(priorCuts, c.createdAt),
  }));

  return {
    sections: sectionRows,
    decisions: decisionRows,
    acs: acRows,
    tasks: taskRows,
    issues: issueRows,
    comments,
  };
}

// ── cutVersion (t-2) ─────────────────────────────────────────────────────

async function loadDocForTenant(memexId: string, docId: string): Promise<Doc> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });
  // 404, not 403 (std-7) — a cross-tenant id must not reveal the doc exists.
  if (!doc) throw new NotFoundError(`Document ${docId} not found`);
  return doc;
}

/**
 * Freeze the doc's FULL current artifact graph as an immutable
 * `document_versions` row, then advance `documents.version` by exactly one.
 *
 * `carryForward` names the artifact classes (decisions/acs/tasks/issues/
 * comments) whose LIVE rows are left untouched (ac-19). Every class NOT
 * named is stamped `retired_at_version = N` (the version just frozen) on its
 * currently-live rows (ac-17) — a leave-behind marker, not a delete (dec-2).
 * Narrative sections are never retired by this mechanism (they always carry).
 *
 * Doc-type-agnostic (ac-34): works for any `documents.docType`, not just
 * 'spec'.
 */
export async function cutVersion(
  memexId: string,
  docId: string,
  name: string,
  carryForward: Iterable<CarryForwardClass>,
  ctx: RequestCtx = {},
): Promise<Mutated<DocumentVersion>> {
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (trimmedName.length === 0) {
    throw new ValidationError("Version name must be a non-empty string");
  }

  const doc = await loadDocForTenant(memexId, docId);
  const keep = new Set(carryForward);
  const actorCols = await resolveActorColumns(ctx);

  return mutate(
    ctx,
    (created: DocumentVersion) => ({
      memexId,
      docId,
      entity: "document_version",
      action: "created",
      narrative: `cut version ${created.versionNumber} ("${trimmedName}") of ${doc.handle}`,
    }),
    async () =>
      db.transaction(async (tx) => {
        const [current] = await tx
          .select({ version: documents.version })
          .from(documents)
          .where(and(eq(documents.id, docId), eq(documents.memexId, memexId)));
        if (!current) throw new NotFoundError(`Document ${docId} not found`);
        const N = current.version;

        const snapshot = await buildSnapshot(tx, docId);
        const checksum = computeSnapshotChecksum(snapshot);

        const [row] = await tx
          .insert(documentVersions)
          .values({
            memexId,
            docId,
            versionNumber: N,
            name: trimmedName,
            checksum,
            // Drizzle's jsonb column typing is opaque `unknown` — the snapshot
            // shape is owned by this service (schema.ts comment), not enforced
            // by the column type.
            snapshot: snapshot as unknown,
            ...actorCols,
          })
          .returning();

        await tx
          .update(documents)
          .set({ version: N + 1 })
          .where(and(eq(documents.id, docId), eq(documents.memexId, memexId)));

        if (!keep.has("decisions")) {
          await tx
            .update(decisions)
            .set({ retiredAtVersion: N })
            .where(and(eq(decisions.docId, docId), isNull(decisions.retiredAtVersion)));
        }
        if (!keep.has("acs")) {
          await tx
            .update(acs)
            .set({ retiredAtVersion: N })
            .where(and(eq(acs.briefId, docId), isNull(acs.retiredAtVersion)));
        }
        if (!keep.has("tasks")) {
          await tx
            .update(tasks)
            .set({ retiredAtVersion: N })
            .where(and(eq(tasks.docId, docId), isNull(tasks.retiredAtVersion)));
        }
        if (!keep.has("issues")) {
          await tx
            .update(issues)
            .set({ retiredAtVersion: N })
            .where(and(eq(issues.docId, docId), isNull(issues.retiredAtVersion)));
        }
        if (!keep.has("comments")) {
          await tx
            .update(docComments)
            .set({ retiredAtVersion: N })
            .where(and(eq(docComments.docId, docId), isNull(docComments.retiredAtVersion)));
        }

        return row as DocumentVersion;
      }),
  );
}

// ── getVersionSnapshot (t-3) ─────────────────────────────────────────────

/**
 * Read-only "view as-of vK" — returns the frozen `document_versions` row
 * (including its full artifact-graph snapshot) exactly as archived. No live
 * joins: retired artifacts, and the section text/comments as they stood at
 * that cut, are all present verbatim (dec-1/dec-2, ac-18/ac-25).
 *
 * Tenancy-checked: an unknown doc or an unknown version number both 404
 * (std-7) — never a 403 that would confirm the resource's existence.
 */
export async function getVersionSnapshot(
  memexId: string,
  docId: string,
  versionNumber: number,
): Promise<DocumentVersion> {
  await loadDocForTenant(memexId, docId);

  const row = await db.query.documentVersions.findFirst({
    where: and(
      eq(documentVersions.docId, docId),
      eq(documentVersions.memexId, memexId),
      eq(documentVersions.versionNumber, versionNumber),
    ),
  });
  if (!row) {
    throw new NotFoundError(`Version ${versionNumber} of document ${docId} not found`);
  }
  return row;
}

// ── listVersions (t-6) ───────────────────────────────────────────────────

/** Lightweight projection for the version-history list — no snapshot payload. */
export interface VersionSummary {
  versionNumber: number;
  name: string;
  createdAt: Date;
  actorName: string | null;
  restoredFromVersion: number | null;
}

/**
 * List every cut version of a doc, newest first — the version-switcher /
 * history surface. Deliberately omits `snapshot` (fetched separately via
 * `getVersionSnapshot` when a specific version is opened) so listing stays
 * cheap regardless of how large a doc's artifact graph has grown.
 *
 * Tenancy-checked like every other read here: an unknown doc 404s (std-7).
 */
export async function listVersions(memexId: string, docId: string): Promise<VersionSummary[]> {
  await loadDocForTenant(memexId, docId);

  return db
    .select({
      versionNumber: documentVersions.versionNumber,
      name: documentVersions.name,
      createdAt: documentVersions.createdAt,
      actorName: documentVersions.actorName,
      restoredFromVersion: documentVersions.restoredFromVersion,
    })
    .from(documentVersions)
    .where(and(eq(documentVersions.docId, docId), eq(documentVersions.memexId, memexId)))
    .orderBy(desc(documentVersions.versionNumber));
}

// ── diff-data (t-6) ──────────────────────────────────────────────────────

/** A diff side is either a concrete cut version number, or the live primary. */
export type SnapshotToken = number | "primary";

export interface VersionOrPrimarySnapshot {
  version: SnapshotToken;
  name: string | null;
  createdAt: Date | null;
  restoredFromVersion: number | null;
  checksum: string;
  snapshot: ArtifactSnapshot;
}

/**
 * Resolve one side of a diff request (ac-26: the version switcher can compare
 * ANY two versions, including the primary, not just adjacent ones):
 *   - a concrete version number reads the frozen `document_versions` row via
 *     `getVersionSnapshot` (same tenancy/404 posture, std-7).
 *   - the `"primary"` token composes the doc's CURRENT live graph on the fly
 *     (`buildLiveSnapshot`) — the working state has no `document_versions` row
 *     of its own until it's next cut, so this is the only way to diff against it.
 */
export async function getVersionOrPrimarySnapshot(
  memexId: string,
  docId: string,
  token: SnapshotToken,
): Promise<VersionOrPrimarySnapshot> {
  if (token === "primary") {
    await loadDocForTenant(memexId, docId); // tenancy check (std-7)
    const snapshot = await buildLiveSnapshot(memexId, docId);
    return {
      version: "primary",
      name: null,
      createdAt: null,
      restoredFromVersion: null,
      checksum: computeSnapshotChecksum(snapshot),
      snapshot,
    };
  }

  const row = await getVersionSnapshot(memexId, docId, token);
  return {
    version: row.versionNumber,
    name: row.name,
    createdAt: row.createdAt,
    restoredFromVersion: row.restoredFromVersion,
    checksum: row.checksum,
    snapshot: row.snapshot as ArtifactSnapshot,
  };
}

// ── restoreVersion (t-4) ─────────────────────────────────────────────────

type ActorCols = Awaited<ReturnType<typeof resolveActorColumns>>;

// Replace the doc's LIVE artifact graph with the content of a frozen
// snapshot. This is the "materialise" step (dec-3).
//
// NEVER a hard delete (b-97 dec-2 established decisions as soft-delete-only,
// and the same posture is kept uniformly across all six artifact tables
// here): reconciliation is UPDATE-matched-by-`seq` (the allocate-once
// identity every one of these tables already carries), plus an INSERT for a
// snapshot row with no live counterpart at all (only reachable if a row was
// hard-deleted outside this versioning flow — e.g. acs.deleteAc — since
// every OTHER write path here is soft-delete-only). A live row whose `seq`
// is absent from the snapshot (created after the cut being restored to) is
// left BEHIND — stamped `retired_at_version = sourceVersionNumber` — exactly
// dec-2's leave-behind marker, not a delete.
//
// Because ids are never churned, comments' section_id/decision_id/task_id
// FKs — and every OTHER table's FK onto these six (decision_deps, task_deps,
// task_satisfies_ac, ac_parent_links, issues.satisfying_task_id) — need no
// remapping at all: a matched row keeps its id, only its content moves.
async function materialiseGraph(
  tx: Tx,
  memexId: string,
  docId: string,
  snap: ArtifactSnapshot,
  sourceVersionNumber: number,
  actorCols: ActorCols,
): Promise<void> {
  // Reconcile one artifact class: UPDATE rows matched by seq to the
  // snapshot's content verbatim (including its own retired_at_version —
  // preserving whatever leave-behind state the snapshot itself recorded),
  // INSERT any snapshot row with no live counterpart, and retire (never
  // delete) any live row whose seq the snapshot doesn't have.
  // Deliberately loosely typed (`any`): this helper is generic over five
  // structurally-different Drizzle tables, and Drizzle's per-table insert/
  // update builder types don't unify under one generic signature. Each call
  // site below supplies its own strongly-typed field-mapper closures
  // (`contentFields` / `insertFields`), which is where real type safety
  // (matching each table's actual columns) is enforced.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function reconcile(
    table: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    liveRows: Array<{ id: string; seq: number }>,
    snapItems: Array<{ seq: number }>,
    contentFields: (item: any) => Record<string, unknown>, // eslint-disable-line @typescript-eslint/no-explicit-any
    insertFields: (item: any) => Record<string, unknown>, // eslint-disable-line @typescript-eslint/no-explicit-any
    idColumn: Parameters<typeof eq>[0],
  ): Promise<void> {
    const liveBySeq = new Map(liveRows.map((r) => [r.seq, r]));
    const snapBySeq = new Map(snapItems.map((s) => [s.seq, s]));

    for (const [seq, item] of snapBySeq) {
      const live = liveBySeq.get(seq);
      if (live) {
        await tx.update(table).set(contentFields(item)).where(eq(idColumn, live.id));
      } else {
        await tx.insert(table).values({ ...insertFields(item), seq, ...actorCols });
      }
    }
    for (const [seq, live] of liveBySeq) {
      if (!snapBySeq.has(seq)) {
        await tx.update(table).set({ retiredAtVersion: sourceVersionNumber }).where(eq(idColumn, live.id));
      }
    }
  }

  const liveSections = await tx.select().from(docSections).where(eq(docSections.docId, docId));
  await reconcile(
    docSections,
    liveSections,
    snap.sections,
    (s) => ({
      sectionType: s.sectionType,
      title: s.title,
      description: s.description,
      content: s.content,
      preamble: s.preamble,
      position: s.position,
      status: s.status,
      previousStatus: s.previousStatus,
      retiredAtVersion: s.retiredAtVersion,
    }),
    (s) => ({
      docId,
      sectionType: s.sectionType,
      title: s.title,
      description: s.description,
      content: s.content,
      preamble: s.preamble,
      position: s.position,
      status: s.status,
      previousStatus: s.previousStatus,
      retiredAtVersion: s.retiredAtVersion,
    }),
    docSections.id,
  );

  const liveDecisions = await tx.select().from(decisions).where(eq(decisions.docId, docId));
  await reconcile(
    decisions,
    liveDecisions,
    snap.decisions,
    (d) => ({
      title: d.title,
      context: d.context,
      status: d.status,
      options: d.options,
      chosenOptionIndex: d.chosenOptionIndex,
      source: d.source,
      resolution: d.resolution,
      resolvedAt: d.resolvedAt,
      previousStatus: d.previousStatus,
      retiredAtVersion: d.retiredAtVersion,
    }),
    (d) => ({
      memexId,
      docId,
      title: d.title,
      context: d.context,
      status: d.status,
      options: d.options,
      chosenOptionIndex: d.chosenOptionIndex,
      source: d.source,
      resolution: d.resolution,
      resolvedAt: d.resolvedAt,
      previousStatus: d.previousStatus,
      retiredAtVersion: d.retiredAtVersion,
    }),
    decisions.id,
  );

  const liveAcs = await tx.select().from(acs).where(eq(acs.briefId, docId));
  await reconcile(
    acs,
    liveAcs,
    snap.acs,
    (a) => ({
      kind: a.kind,
      statement: a.statement,
      status: a.status,
      acceptedBy: a.acceptedBy,
      acceptedAt: a.acceptedAt,
      reviewedReason: a.reviewedReason,
      retiredAtVersion: a.retiredAtVersion,
    }),
    (a) => ({
      memexId,
      briefId: docId,
      kind: a.kind,
      statement: a.statement,
      status: a.status,
      acceptedBy: a.acceptedBy,
      acceptedAt: a.acceptedAt,
      reviewedReason: a.reviewedReason,
      retiredAtVersion: a.retiredAtVersion,
    }),
    acs.id,
  );

  const liveTasks = await tx.select().from(tasks).where(eq(tasks.docId, docId));
  await reconcile(
    tasks,
    liveTasks,
    snap.tasks,
    (t) => ({
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptanceCriteria,
      sectionRef: t.sectionRef,
      status: t.status,
      executionPlanDocId: t.executionPlanDocId,
      retiredAtVersion: t.retiredAtVersion,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
    }),
    (t) => ({
      memexId,
      docId,
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptanceCriteria,
      sectionRef: t.sectionRef,
      status: t.status,
      executionPlanDocId: t.executionPlanDocId,
      retiredAtVersion: t.retiredAtVersion,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
    }),
    tasks.id,
  );

  const liveIssues = await tx.select().from(issues).where(eq(issues.docId, docId));
  await reconcile(
    issues,
    liveIssues,
    snap.issues,
    (i) => ({
      title: i.title,
      body: i.body,
      type: i.type,
      severity: i.severity,
      status: i.status,
      source: i.source,
      retiredAtVersion: i.retiredAtVersion,
    }),
    (i) => ({
      memexId,
      docId,
      title: i.title,
      body: i.body,
      type: i.type,
      severity: i.severity,
      status: i.status,
      source: i.source,
      createdByUserId: i.createdByUserId,
      retiredAtVersion: i.retiredAtVersion,
    }),
    issues.id,
  );

  // Comments: ids of their section/decision/task targets never changed
  // above, so no FK remapping is needed — reconcile content by seq exactly
  // like every other class.
  const liveComments = await tx.select().from(docComments).where(eq(docComments.docId, docId));
  await reconcile(
    docComments,
    liveComments,
    snap.comments,
    (c) => ({
      sectionId: c.sectionId,
      decisionId: c.decisionId,
      taskId: c.taskId,
      authorName: c.authorName,
      authorUserId: c.authorUserId,
      authorNamespaceId: c.authorNamespaceId,
      channel: c.channel,
      content: c.content,
      commentType: c.commentType,
      source: c.source,
      referenceBriefId: c.referenceBriefId,
      referenceStandardId: c.referenceStandardId,
      referenceDecisionId: c.referenceDecisionId,
      referenceTaskId: c.referenceTaskId,
      resolution: c.resolution,
      resolvedAt: c.resolvedAt,
      anchorSnippet: c.anchorSnippet,
      audience: c.audience,
      actions: c.actions,
      assigneeUserId: c.assigneeUserId,
      assignedBy: c.assignedBy,
      assignedAt: c.assignedAt,
      retiredAtVersion: c.retiredAtVersion,
    }),
    (c) => ({
      memexId,
      docId,
      sectionId: c.sectionId,
      decisionId: c.decisionId,
      taskId: c.taskId,
      authorName: c.authorName,
      authorUserId: c.authorUserId,
      authorNamespaceId: c.authorNamespaceId,
      channel: c.channel,
      content: c.content,
      commentType: c.commentType,
      source: c.source,
      referenceBriefId: c.referenceBriefId,
      referenceStandardId: c.referenceStandardId,
      referenceDecisionId: c.referenceDecisionId,
      referenceTaskId: c.referenceTaskId,
      resolution: c.resolution,
      resolvedAt: c.resolvedAt,
      anchorSnippet: c.anchorSnippet,
      audience: c.audience,
      actions: c.actions,
      assigneeUserId: c.assigneeUserId,
      assignedBy: c.assignedBy,
      assignedAt: c.assignedAt,
      retiredAtVersion: c.retiredAtVersion,
    }),
    docComments.id,
  );
}

/**
 * Rollback: restore the doc's live artifact graph to a prior version's
 * content.
 *
 * 1. Auto-freeze the CURRENT live state as a new immutable version first
 *    (via `cutVersion`, carrying every class forward — a pure checkpoint,
 *    nothing is retired) so the pre-restore state is never lost (ac-20).
 * 2. Materialise the source version's content onto the live tables.
 * 3. Insert ANOTHER `document_versions` row — content-identical to the
 *    source snapshot (ac-21) — with `restored_from_version` set (ac-22),
 *    and advance `documents.version` again. Version numbers only ever
 *    increase; nothing is overwritten in place (dec-3).
 *
 * `documents.id` / `handle` / `status` are never touched (ac-23).
 */
export async function restoreVersion(
  memexId: string,
  docId: string,
  sourceVersionNumber: number,
  ctx: RequestCtx = {},
): Promise<Mutated<DocumentVersion>> {
  const doc = await loadDocForTenant(memexId, docId);
  // Validates the source version exists in THIS tenant (404, not 403, std-7).
  const source = await getVersionSnapshot(memexId, docId, sourceVersionNumber);

  // ac-20: auto-freeze current state first. Every class carries forward —
  // this is a pure checkpoint, not a prune — since materialisation is about
  // to replace the live graph wholesale anyway.
  await cutVersion(
    memexId,
    docId,
    `Auto-saved before restoring v${sourceVersionNumber}`,
    CARRY_FORWARD_CLASSES,
    ctx,
  );

  const actorCols = await resolveActorColumns(ctx);
  const snap = source.snapshot as ArtifactSnapshot;

  return mutate(
    ctx,
    (created: DocumentVersion) => ({
      memexId,
      docId,
      entity: "document_version",
      action: "created",
      narrative: `restored ${doc.handle} from v${sourceVersionNumber} (now v${created.versionNumber})`,
    }),
    async () =>
      db.transaction(async (tx) => {
        const [current] = await tx
          .select({ version: documents.version })
          .from(documents)
          .where(and(eq(documents.id, docId), eq(documents.memexId, memexId)));
        if (!current) throw new NotFoundError(`Document ${docId} not found`);
        const N = current.version;

        await materialiseGraph(tx, memexId, docId, snap, sourceVersionNumber, actorCols);

        // ac-21: content EQUALS the chosen prior snapshot — reuse the source
        // snapshot + checksum verbatim rather than re-deriving from the
        // freshly materialised (new-id, new-timestamp) live rows, so
        // equality is exact and trivially provable, not approximate.
        const [row] = await tx
          .insert(documentVersions)
          .values({
            memexId,
            docId,
            versionNumber: N,
            name: `Restored from v${sourceVersionNumber}`,
            checksum: source.checksum,
            snapshot: source.snapshot,
            restoredFromVersion: sourceVersionNumber,
            ...actorCols,
          })
          .returning();

        await tx
          .update(documents)
          .set({ version: N + 1 })
          .where(and(eq(documents.id, docId), eq(documents.memexId, memexId)));

        return row as DocumentVersion;
      }),
  );
}
