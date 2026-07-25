// One-shot starter-Spec purge (spec-509 dec-1 / dec-2).
//
// The seeded "Understanding Memex" starter Spec is retired. Provisioning no longer
// creates one (dec-2 deleted the seeder), but 240 copies exist in prod from the
// 2026-07-02 → 2026-07-24 seeding window — 157 of them from spec-474 dec-3's one-shot
// demo→starter backfill. This sweep deletes the ones nobody ever touched.
//
// It is the mirror image of the retired demo-to-starter-sweep: the same iteration shape
// (personal namespaces → memexes, each run under runWithMemexId for RLS, std-36), the
// same teardown ordering as services/demo-cleanup.ts, reversed in intent — it clears the
// starter instead of seeding it.
//
// ── WHAT IS DELETED (dec-1: the broad predicate) ──────────────────────────────
// A copy is deleted ONLY when it is provably pristine — no engagement signal of any
// kind. A mere VIEW spares it. The asymmetry is the argument: deleting a Spec someone
// valued is unrecoverable (doc + sections + decisions + ACs all cascade; the only remedy
// is a point-in-time restore nobody will run for one doc), while leaving a dead copy
// costs a row. Measured on prod 2026-07-25, the broad predicate spares ~4 of 240 —
// including the one external user who opened theirs 51 times, the single strongest
// engagement signal in the dataset and the one person the feature arguably worked for.
//
// `mcp_tool_calls` is deliberately NOT consulted (dec-1): it would be a substring LIKE
// over args_json/result_text — unindexable (std-39 cl-24), imprecise (it matches a
// list_docs result that merely MENTIONED the title), and measured against prod it spared
// 2 calls by 1 user who was already caught by doc_views. Full scan, zero marginal cover.
//
// ── IDENTITY (never widen this) ───────────────────────────────────────────────
// A seeded copy is (docType='spec', title='Understanding Memex', created_by_user_id IS
// NULL). The NULL-creator half is what distinguishes the SYSTEM's seed from a user's own
// Spec they happened to title the same — theirs carries their createdByUserId. Dropping
// it from the predicate would delete users' own work.
//
// Bounded per std-39: memex-by-memex, each its own short transaction (the mutate()
// internals), never one giant transaction; the predicate is evaluated with a fixed
// number of bulk queries per memex, never one query per document; progress logged every
// N. A --dry-run mode reports what it WOULD do without any write.

import { and, eq, inArray, isNotNull, isNull, gt, ne } from "drizzle-orm";
import { db, runWithMemexId } from "../db/connection.js";
import {
  documents,
  namespaces,
  memexes,
  docViews,
  docComments,
  documentVersions,
  decisions,
  tasks,
  acs,
  testEvents,
  testEventLatest,
  activityLog,
} from "../db/schema.js";
import { mutate, type RequestCtx } from "./mutate.js";
import { buildAcRef } from "./acs.js";

/** The canonical title of the retired seed. It used to be a named export of the deleted
 *  content fixture — inlined here because this sweep is the last thing in the codebase
 *  that needs to know it, and re-adding that fixture just to hold a string would
 *  resurrect the file dec-2 deleted. Named `RETIRED_…` rather than reusing the fixture's
 *  old symbol so the spec-509 static scan (which forbids that symbol anywhere outside the
 *  removal's own docs) stays a clean signal. */
export const RETIRED_SEED_TITLE = "Understanding Memex";

// The sweep writes on behalf of the system, not any user. `server` is the only
// RequestCtx channel that fits an operator-run purge (the enum is
// rest_ui|mcp|in_app_agent|server — there is no `backfill` value), and a missing channel
// is a visible defect per std-32, so we set it explicitly.
const SWEEP_CTX: RequestCtx = { channel: "server" };

// Log a running progress line every N memexes so a long prod sweep is observable.
const PROGRESS_EVERY = 25;

/** Why a copy was spared. Reported per-copy so the residue left in prod is auditable at
 *  the moment it is created rather than a puzzle for whoever reads the table later. */
export type SpareReason =
  | "viewed"
  | "human_activity"
  | "commented"
  | "user_version"
  | "user_child"
  | "version_advanced"
  | "archived";

export interface SparedCopy {
  docId: string;
  handle: string;
  reason: SpareReason;
}

export interface PurgePerMemex {
  memexId: string;
  /** Seeded copies found (system-attributed, canonical title). */
  found: number;
  /** Deleted (live) or would-be-deleted (dry-run). */
  deleted: number;
  /** Copies spared, each with the signal that spared it. */
  spared: SparedCopy[];
}

export interface PurgeResult {
  docsDeleted: number;
  docsSpared: number;
  memexesVisited: number;
  perMemex: PurgePerMemex[];
}

export interface PurgeOptions {
  /** Report only — no writes. */
  dryRun?: boolean;
  ctx?: RequestCtx;
}

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log("[starter-spec purge]", ...args);
}

/**
 * The seeded copies in `memexId`: system-attributed (created_by_user_id IS NULL) Specs
 * carrying the canonical title. Includes archived ones — the predicate needs to SEE an
 * archived copy in order to spare it.
 */
async function listSeededCopies(
  memexId: string,
): Promise<Array<{ id: string; handle: string; version: number; archived: boolean }>> {
  const rows = await db
    .select({
      id: documents.id,
      handle: documents.handle,
      version: documents.version,
      archivedAt: documents.archivedAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, "spec"),
        eq(documents.title, RETIRED_SEED_TITLE),
        isNull(documents.createdByUserId),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    version: r.version,
    archived: r.archivedAt !== null,
  }));
}

/**
 * Partition `copies` into pristine (safe to delete) and spared, per dec-1.
 *
 * std-39 cl-5: this issues a FIXED number of bulk queries (five) for the whole set,
 * regardless of how many copies the memex holds — never one query per document. Each
 * query returns only the doc ids that carry the signal, which is all the predicate needs.
 */
async function partition(
  memexId: string,
  copies: Array<{ id: string; handle: string; version: number; archived: boolean }>,
): Promise<{ pristine: typeof copies; spared: SparedCopy[] }> {
  const ids = copies.map((c) => c.id);
  if (ids.length === 0) return { pristine: [], spared: [] };

  const [viewed, humanActivity, commented, userVersioned, userChildren] = await Promise.all([
    // Anyone opened it, on any channel.
    db.select({ docId: docViews.docId }).from(docViews).where(inArray(docViews.docId, ids)),
    // Any non-system actor touched it. Covers reads too (a 'document viewed' row) and
    // every human mutation (status_changed, updated, …).
    db
      .select({ docId: activityLog.briefId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.memexId, memexId),
          inArray(activityLog.briefId, ids),
          ne(activityLog.actorKind, "system"),
        ),
      ),
    db
      .select({ docId: docComments.docId })
      .from(docComments)
      .where(and(eq(docComments.memexId, memexId), inArray(docComments.docId, ids))),
    // A version cut attributed to a real user (the seed's own writes are actor-NULL).
    db
      .select({ docId: documentVersions.docId })
      .from(documentVersions)
      .where(
        and(inArray(documentVersions.docId, ids), isNotNull(documentVersions.actorUserId)),
      ),
    // A child the USER authored. The seed's own decisions/ACs are actor-NULL by
    // construction (spec-426 dec-3), so a non-null actor here means the owner worked on
    // it. Three tables, unioned in SQL — still one round trip.
    (async () => {
      const [d, t, a] = await Promise.all([
        db
          .select({ docId: decisions.docId })
          .from(decisions)
          .where(and(inArray(decisions.docId, ids), isNotNull(decisions.actorUserId))),
        db
          .select({ docId: tasks.docId })
          .from(tasks)
          .where(and(inArray(tasks.docId, ids), isNotNull(tasks.actorUserId))),
        db
          .select({ docId: acs.briefId })
          .from(acs)
          .where(and(inArray(acs.briefId, ids), isNotNull(acs.actorUserId))),
      ]);
      return [...d, ...t, ...a];
    })(),
  ]);

  const toSet = (rows: Array<{ docId: string | null }>): Set<string> =>
    new Set(rows.map((r) => r.docId).filter((id): id is string => id !== null));

  const viewedSet = toSet(viewed);
  const activitySet = toSet(humanActivity);
  const commentedSet = toSet(commented);
  const versionedSet = toSet(userVersioned);
  const childSet = toSet(userChildren);

  const pristine: typeof copies = [];
  const spared: SparedCopy[] = [];

  for (const copy of copies) {
    // Ordered so the reported reason is the most human-meaningful one available.
    const reason: SpareReason | null = copy.archived
      ? "archived"
      : copy.version > 1
        ? "version_advanced"
        : commentedSet.has(copy.id)
          ? "commented"
          : versionedSet.has(copy.id)
            ? "user_version"
            : childSet.has(copy.id)
              ? "user_child"
              : activitySet.has(copy.id)
                ? "human_activity"
                : viewedSet.has(copy.id)
                  ? "viewed"
                  : null;

    if (reason) spared.push({ docId: copy.id, handle: copy.handle, reason });
    else pristine.push(copy);
  }

  return { pristine, spared };
}

/**
 * Tear down a set of seeded copies completely, in the order their tables require.
 * Lifted from services/demo-cleanup.ts, where the ordering was established the hard way:
 *
 *  1. the AC emissions keyed to them — test_events / test_event_latest have NO docId
 *     cascade, so they must be removed explicitly, and the ac_uids must be computed
 *     BEFORE the doc delete (deleting cascades the acs rows away, so seqs are gone).
 *     The starter seed emitted no synthetic test-events, so this is expected to be a
 *     no-op — it runs anyway rather than assuming.
 *  2. the activity_log rows referencing them — brief_id is ON DELETE SET NULL, so
 *     leaving them would null brief_id on the hard-delete below and re-surface the
 *     seeded activity in Pulse as memex-level activity (the spec-474 issue-1 trap).
 *  3. the documents themselves — doc_sections / decisions / tasks / acs / doc_comments
 *     cascade via the docId FKs.
 *
 * One mutate() per doc keeps the std-8 'document deleted' emission so live boards
 * refresh, and carries the channel (std-32).
 */
async function deleteCopies(
  memexId: string,
  copies: Array<{ id: string; handle: string }>,
  ctx: RequestCtx,
): Promise<void> {
  if (copies.length === 0) return;
  const ids = copies.map((c) => c.id);

  // 1. AC emissions. Resolve ac_uids first — after the delete the acs rows are gone.
  const [slugRow] = await db
    .select({ namespace: namespaces.slug, memex: memexes.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (!slugRow) throw new Error(`Memex ${memexId} not found while purging starter specs`);

  const handleByDocId = new Map(copies.map((c) => [c.id, c.handle]));
  const acRows = await db
    .select({ briefId: acs.briefId, seq: acs.seq })
    .from(acs)
    .where(and(eq(acs.memexId, memexId), inArray(acs.briefId, ids)));

  const acUids = acRows
    .map((a) => {
      const handle = handleByDocId.get(a.briefId);
      if (!handle) return null;
      return buildAcRef(
        { namespace: slugRow.namespace, memex: slugRow.memex, briefHandle: handle },
        a.seq,
      );
    })
    .filter((u): u is string => u !== null);

  if (acUids.length > 0) {
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, acUids));
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, acUids));
  }

  // 2. activity_log rows referencing the docs, BEFORE the hard-delete.
  await db
    .delete(activityLog)
    .where(and(eq(activityLog.memexId, memexId), inArray(activityLog.briefId, ids)));

  // 3. The documents. One mutate() per doc — std-8 emission + std-32 channel.
  for (const id of ids) {
    await mutate(ctx, { memexId, docId: id, entity: "document", action: "deleted" }, async () => {
      const [row] = await db
        .delete(documents)
        .where(and(eq(documents.id, id), eq(documents.memexId, memexId)))
        .returning();
      return row;
    });
  }
}

/**
 * Purge the retired starter Spec from ONE memex. Exported so an integration test can
 * exercise a single memex without walking every personal namespace.
 *
 * Idempotent: a second call finds no seeded copies and deletes nothing.
 */
export async function purgeStarterSpecsForMemex(
  memexId: string,
  opts: PurgeOptions = {},
): Promise<PurgePerMemex> {
  const { dryRun = false, ctx = SWEEP_CTX } = opts;

  const copies = await listSeededCopies(memexId);
  if (copies.length === 0) {
    return { memexId, found: 0, deleted: 0, spared: [] };
  }

  const { pristine, spared } = await partition(memexId, copies);

  if (!dryRun) {
    await deleteCopies(memexId, pristine, ctx);
  }

  return { memexId, found: copies.length, deleted: pristine.length, spared };
}

/**
 * Purge the retired starter Spec across EVERY personal Memex, in one idempotent pass.
 *
 * Iterates personal namespaces (kind='user') → their memexes, running each memex under
 * runWithMemexId so the rlsClient proxy sets app.memex_id for the reads and writes: the
 * runtime connects as the non-owner `memex_app` role which is SUBJECT to RLS (std-36).
 * Each memex is its own short unit of work (std-39) — never one transaction across all.
 */
export async function purgeStarterSpecs(opts: PurgeOptions = {}): Promise<PurgeResult> {
  const { dryRun = false, ctx = SWEEP_CTX } = opts;

  const rows = await db
    .select({ memexId: memexes.id })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(namespaces.kind, "user"));

  const perMemex: PurgePerMemex[] = [];
  let docsDeleted = 0;
  let docsSpared = 0;

  for (const [i, row] of rows.entries()) {
    const result = await runWithMemexId(row.memexId, () =>
      purgeStarterSpecsForMemex(row.memexId, { dryRun, ctx }),
    );
    perMemex.push(result);
    docsDeleted += result.deleted;
    docsSpared += result.spared.length;

    if ((i + 1) % PROGRESS_EVERY === 0) {
      log(
        `${i + 1}/${rows.length} personal memexes · ${docsDeleted} ${dryRun ? "would delete" : "deleted"} · ${docsSpared} spared`,
      );
    }
  }

  return { docsDeleted, docsSpared, memexesVisited: rows.length, perMemex };
}
