import { and, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
import {
  QA_REPORT_SECTION_PREFIX,
  isQaReportSectionType,
  qaReportVersion,
} from "@memex/shared";
import { db } from "../db/connection.js";
import { docSections, documents, qaReportViews } from "../db/schema.js";
import type { DocSection } from "../db/schema.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { addSection } from "./sections.js";

// spec-260 (dec-1, dec-2): a QA report is a read-only `doc_sections` row with
// section_type='qa_report'. Each build session APPENDS a distinct, dated version
// rather than overwriting, so history survives build→verify→reopen→build. Because
// (doc_id, section_type) is unique per doc, each version gets its own key:
//
//   qa_report, qa_report-2, qa_report-3, …
//
// The latest version is the highest suffix (also the newest created_at). Every row
// carries its own created_at + std-32 actor, which is what lets the workspace feed
// (dec-5) list each session as its own entry and the unread counter (dec-6) count
// per version. The version grammar itself lives in @memex/shared (one source for
// the server paths and the UI render seats); re-exported here for the existing
// service-layer call sites.
export { QA_REPORT_SECTION_PREFIX, isQaReportSectionType, qaReportVersion };

/**
 * Compute the next qa_report section_type for a doc. We scan ALL existing rows
 * (including soft-deleted — the (doc_id, section_type) unique constraint is
 * unconditional, so a reused key would collide even with a deleted row) and pick
 * one past the highest version present. The first ever report is `qa_report`.
 */
export async function nextQaReportSectionType(docId: string): Promise<string> {
  const rows = await db
    .select({ sectionType: docSections.sectionType })
    .from(docSections)
    .where(eq(docSections.docId, docId));

  let maxVersion = 0;
  for (const { sectionType } of rows) {
    const v = qaReportVersion(sectionType);
    if (v !== null) maxVersion = Math.max(maxVersion, v);
  }

  const next = maxVersion + 1;
  return next === 1 ? QA_REPORT_SECTION_PREFIX : `${QA_REPORT_SECTION_PREFIX}-${next}`;
}

/**
 * Append a QA report to a Spec as a new versioned `doc_sections` row. The write goes
 * through addSection → mutate(), so the std-32 actor/channel columns are stamped (the
 * "who executed it" the feed shows) and the std-8 bus fires (live panels + feed).
 *
 * APPEND, never overwrite (ac-14): a second call on the same Spec lands a fresh
 * section_type (qa_report-2, …); the previous session's row stays retrievable. The
 * caller never picks the version key — that's computed here so a build agent can't
 * accidentally clobber a prior session by reusing `qa_report`.
 */
export async function appendQaReport(
  memexId: string,
  docId: string,
  content: string,
  title?: string,
  ctx: RequestCtx = {},
): Promise<Mutated<DocSection>> {
  const sectionType = await nextQaReportSectionType(docId);
  // addSection re-checks the doc belongs to memexId before mutating (tenancy gate).
  return addSection(memexId, docId, sectionType, content, title ?? "QA Report", undefined, ctx);
}

// ── Workspace feed (dec-5) ─────────────────────────────────────────────────────
//
// The cross-Spec QA Reports feed: every qa_report* section across the memex's
// Specs, newest-first, keyset-paginated via `since` (mirroring listActivity /
// the Pulse "Load More" pattern). Each row carries its own created_at (WHEN),
// the parent Spec's handle + title (WHICH), and the std-32 actor columns (WHO).

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// SQL predicate matching exactly the version keys appendQaReport mints:
// `qa_report` or `qa_report-N`. A plain LIKE 'qa_report%' would also match
// unrelated keys like 'qa_report_notes', so the suffix is anchored.
const qaReportSectionPredicate = () =>
  sql`(${docSections.sectionType} = 'qa_report' OR ${docSections.sectionType} ~ '^qa_report-[0-9]+$')`;

// doc_sections carries the std-32 channel; actor_kind is derived from it the
// same way the activity-log sink derives it (services/activity-log.ts).
const CHANNEL_TO_ACTOR_KIND: Record<string, QaReportFeedRow["actorKind"]> = {
  rest_ui: "human",
  mcp: "mcp_agent",
  in_app_agent: "in_app_agent",
  server: "system",
};

export interface QaReportFeedRow {
  /** The qa_report doc_sections row id. */
  id: string;
  docId: string;
  /** Parent Spec handle (`spec-N`) + title, for the WHICH-Spec column + link. */
  docHandle: string;
  docTitle: string;
  /** `qa_report` / `qa_report-2` / … — encodes the build-session version. */
  sectionType: string;
  version: number;
  title: string | null;
  content: string;
  /** std-32 WHO columns, stamped at write time. */
  actorUserId: string | null;
  actorName: string | null;
  actorKind: "human" | "mcp_agent" | "in_app_agent" | "system";
  channel: string | null;
  createdAt: Date;
}

export interface ListQaReportsOptions {
  memexId: string;
  /** Page size — default 50, capped at 200 (the listActivity convention). */
  limit?: number;
  /** Keyset boundary: return rows strictly OLDER than this timestamp. */
  since?: Date;
}

export async function listQaReports(opts: ListQaReportsOptions): Promise<QaReportFeedRow[]> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT)));

  const conditions = [
    eq(documents.memexId, opts.memexId),
    // QA reports attach to Specs only (the write path enforces it); demo Specs
    // are excluded from the feed like they are from the Pulse timeline.
    eq(documents.docType, "spec"),
    ne(documents.isDemo, true),
    ne(docSections.status, "deleted"),
    qaReportSectionPredicate(),
  ];
  if (opts.since !== undefined) conditions.push(lt(docSections.createdAt, opts.since));

  const rows = await db
    .select({
      id: docSections.id,
      docId: docSections.docId,
      docHandle: documents.handle,
      docTitle: documents.title,
      sectionType: docSections.sectionType,
      title: docSections.title,
      content: docSections.content,
      actorUserId: docSections.actorUserId,
      actorName: docSections.actorName,
      channel: docSections.channel,
      createdAt: docSections.createdAt,
    })
    .from(docSections)
    .innerJoin(documents, eq(docSections.docId, documents.id))
    .where(and(...conditions))
    // Newest-first with a deterministic tiebreaker (the listActivity convention).
    .orderBy(desc(docSections.createdAt), desc(docSections.id))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    version: qaReportVersion(row.sectionType) ?? 1,
    actorKind: CHANNEL_TO_ACTOR_KIND[row.channel ?? "server"] ?? "system",
  }));
}

// ── Per-user unread counter (dec-6) ────────────────────────────────────────────
//
// Unread = the number of qa_report* rows in the memex created after the viewer's
// last_viewed_at marker. Count-everything semantics: NO actor filter — the
// viewer's own-agent reports count too (actor is display-only). A missing marker
// means the user has never viewed the feed, so every report counts.

export async function countUnreadQaReports(memexId: string, userId: string): Promise<number> {
  const [marker] = await db
    .select({ lastViewedAt: qaReportViews.lastViewedAt })
    .from(qaReportViews)
    .where(and(eq(qaReportViews.userId, userId), eq(qaReportViews.memexId, memexId)));

  const conditions = [
    eq(documents.memexId, memexId),
    eq(documents.docType, "spec"),
    ne(documents.isDemo, true),
    ne(docSections.status, "deleted"),
    qaReportSectionPredicate(),
  ];
  if (marker) conditions.push(gt(docSections.createdAt, marker.lastViewedAt));

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(docSections)
    .innerJoin(documents, eq(docSections.docId, documents.id))
    .where(and(...conditions));

  return row?.count ?? 0;
}

/**
 * Record that `userId` viewed the memex's QA Reports feed NOW — upserts the
 * (user, memex) marker, zeroing the unread badge. Returns the new marker time.
 *
 * Goes through mutate() per std-8, but SILENT: the marker is per-user
 * read-state (an idempotent re-write of "when did I last look"), not
 * collaborative content — broadcasting every view would be bus noise, and the
 * badge's own zeroing is client-local (the page that posted the view already
 * knows). std-32's activity columns don't apply to this table by design.
 */
export async function recordQaReportsView(memexId: string, userId: string): Promise<Date> {
  const now = new Date();
  await mutate(
    {},
    { memexId, entity: "qa_report_view", action: "updated" },
    async () =>
      db
        .insert(qaReportViews)
        .values({ userId, memexId, lastViewedAt: now })
        .onConflictDoUpdate({
          target: [qaReportViews.userId, qaReportViews.memexId],
          set: { lastViewedAt: now },
        }),
    { silent: true },
  );
  return now;
}
