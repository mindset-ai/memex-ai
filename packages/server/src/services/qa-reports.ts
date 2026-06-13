import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import {
  QA_REPORT_SECTION_PREFIX,
  isQaReportSectionType,
  qaReportVersion,
} from "@memex/shared";
import { db } from "../db/connection.js";
import {
  docSections,
  documents,
  documentTags,
  qaReportViews,
  tags,
  users,
} from "../db/schema.js";
import type { DocSection } from "../db/schema.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { addSection } from "./sections.js";
import { listDocTagsForDocs } from "./tags.js";

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

/** A tag carried on a feed row's owning Spec — the rail-facing subset (spec-286). */
export interface QaReportTagRef {
  id: string;
  scope: string | null;
  value: string;
}

export interface QaReportFeedRow {
  /** The qa_report doc_sections row id. */
  id: string;
  docId: string;
  /** Parent Spec handle (`spec-N`) + title, for the WHICH-Spec column + link. */
  docHandle: string;
  docTitle: string;
  /** The owning Spec's current phase (documents.status) — drives the phase pill (spec-286). */
  phase: string;
  /** `qa_report` / `qa_report-2` / … — encodes the build-session version. */
  sectionType: string;
  version: number;
  title: string | null;
  content: string;
  /**
   * The Spec's AUTHOR (spec-286 dec-1): the creator (documents.created_by_user_id,
   * seeded as the editor — there is no distinct owner role). Distinct from the
   * IMPLEMENTER below, which is whoever ran this build session.
   */
  authorUserId: string | null;
  authorName: string | null;
  /** std-32 WHO columns, stamped at write time — the IMPLEMENTER of this session. */
  actorUserId: string | null;
  actorName: string | null;
  actorKind: "human" | "mcp_agent" | "in_app_agent" | "system";
  channel: string | null;
  /** The owning Spec's tags — feeds the rail filter chips (spec-286). */
  tags: QaReportTagRef[];
  createdAt: Date;
}

export interface ListQaReportsOptions {
  memexId: string;
  /** Page size — default 50, capped at 200 (the listActivity convention). */
  limit?: number;
  /** Keyset boundary: return rows strictly OLDER than this timestamp. */
  since?: Date;
  /** spec-286: restrict to reports whose owning Spec carries this tag (by id). */
  tagId?: string;
  /** spec-286: restrict to reports generated at/after this instant (date filter). */
  from?: Date;
  /** spec-286: restrict to reports generated at/before this instant (date filter). */
  to?: Date;
}

// The conditions shared by the feed, the unread counter, and the facets: a
// qa_report* section on a non-demo Spec in this memex, not soft-deleted. Factored
// out (spec-286) so the feed query, the facet counts, and the total all scope an
// identical corpus — the rail counts can't drift from what the feed actually lists.
function feedBaseConditions(memexId: string) {
  return [
    eq(documents.memexId, memexId),
    eq(documents.docType, "spec"),
    ne(documents.isDemo, true),
    ne(docSections.status, "deleted"),
    qaReportSectionPredicate(),
  ];
}

export async function listQaReports(opts: ListQaReportsOptions): Promise<QaReportFeedRow[]> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT)));

  const conditions = feedBaseConditions(opts.memexId);
  // Keyset boundary ("Load More") + the spec-286 filters, all ANDed so a filtered
  // page is itself keyset-paginated correctly (the cursor composes with the filters).
  if (opts.since !== undefined) conditions.push(lt(docSections.createdAt, opts.since));
  if (opts.from !== undefined) conditions.push(gte(docSections.createdAt, opts.from));
  if (opts.to !== undefined) conditions.push(lte(docSections.createdAt, opts.to));
  if (opts.tagId !== undefined) {
    // Restrict to reports whose owning Spec carries the tag — an EXISTS-style
    // subquery on the bridge, tenant-scoped. A semijoin (not an inner join on
    // documentTags) so a Spec with the tag still yields exactly one row per report.
    const taggedDocIds = db
      .select({ id: documentTags.docId })
      .from(documentTags)
      .where(
        and(eq(documentTags.memexId, opts.memexId), eq(documentTags.tagId, opts.tagId)),
      );
    conditions.push(inArray(documents.id, taggedDocIds));
  }

  const rows = await db
    .select({
      id: docSections.id,
      docId: docSections.docId,
      docHandle: documents.handle,
      docTitle: documents.title,
      phase: documents.status,
      sectionType: docSections.sectionType,
      title: docSections.title,
      content: docSections.content,
      // The Spec author (creator → seeded editor); LEFT-joined so a legacy Spec
      // with a null creator still lists (authorName just renders empty).
      authorUserId: documents.createdByUserId,
      authorName: users.name,
      actorUserId: docSections.actorUserId,
      actorName: docSections.actorName,
      channel: docSections.channel,
      createdAt: docSections.createdAt,
    })
    .from(docSections)
    .innerJoin(documents, eq(docSections.docId, documents.id))
    .leftJoin(users, eq(users.id, documents.createdByUserId))
    .where(and(...conditions))
    // Newest-first with a deterministic tiebreaker (the listActivity convention).
    .orderBy(desc(docSections.createdAt), desc(docSections.id))
    .limit(limit);

  // Attach each owning Spec's tags in one batched round-trip (no N+1), reusing the
  // same query the Specs board uses. Docs absent from the map carry no tags.
  const tagsByDoc = await listDocTagsForDocs(
    opts.memexId,
    [...new Set(rows.map((r) => r.docId))],
  );

  return rows.map((row) => ({
    ...row,
    version: qaReportVersion(row.sectionType) ?? 1,
    actorKind: CHANNEL_TO_ACTOR_KIND[row.channel ?? "server"] ?? "system",
    tags: (tagsByDoc.get(row.docId) ?? []).map(({ id, scope, value }) => ({
      id,
      scope,
      value,
    })),
  }));
}

// ── Tag facets for the filter rail (spec-286 dec-2) ────────────────────────────
//
// The rail's tag tree shows every tag carried by a Spec with at least one QA
// report, each with the COUNT of reports under it, plus an "All" total. Computed
// server-side across the WHOLE corpus (not the loaded page) so the counts are
// correct regardless of how far the client has paged. Honours the date window so
// the counts stay consistent with an active date filter (AND semantics, dec-3).

export interface QaReportTagFacet extends QaReportTagRef {
  /** Number of qa_report* sections whose owning Spec carries this tag. */
  count: number;
}

export interface QaReportFacets {
  /** Total qa_report* sections in the corpus (the "All" node count). */
  total: number;
  tags: QaReportTagFacet[];
}

export interface QaReportFacetsOptions {
  memexId: string;
  from?: Date;
  to?: Date;
}

export async function qaReportTagFacets(
  opts: QaReportFacetsOptions,
): Promise<QaReportFacets> {
  const conditions = feedBaseConditions(opts.memexId);
  if (opts.from !== undefined) conditions.push(gte(docSections.createdAt, opts.from));
  if (opts.to !== undefined) conditions.push(lte(docSections.createdAt, opts.to));

  // The "All" total: every matching report section, tag or not.
  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(docSections)
    .innerJoin(documents, eq(docSections.docId, documents.id))
    .where(and(...conditions));

  // Per-tag counts: one report can sit under several tags (its Spec's tags), so a
  // report is counted once per tag it carries — that's the intended "reports under
  // this tag" semantic, and the per-tag counts can sum to more than `total`.
  const tagRows = await db
    .select({
      id: tags.id,
      scope: tags.scope,
      value: tags.value,
      count: sql<number>`count(*)::int`,
    })
    .from(docSections)
    .innerJoin(documents, eq(docSections.docId, documents.id))
    .innerJoin(
      documentTags,
      and(eq(documentTags.docId, documents.id), eq(documentTags.memexId, opts.memexId)),
    )
    .innerJoin(tags, eq(tags.id, documentTags.tagId))
    .where(and(...conditions))
    .groupBy(tags.id, tags.scope, tags.value)
    .orderBy(desc(sql`count(*)`), asc(tags.scope), asc(tags.value));

  return { total: totalRow?.count ?? 0, tags: tagRows };
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

export interface QaReportsViewReceipt {
  /** The marker just written — "now". */
  lastViewedAt: Date;
  /**
   * The marker BEFORE this view, or null on first-ever view. This is the
   * unread boundary the badge was counting against, returned so the feed page
   * can render unread rows expanded (ac-24) even though opening the page is
   * exactly what resets the marker.
   */
  previousLastViewedAt: Date | null;
}

/**
 * Record that `userId` viewed the memex's QA Reports feed NOW — upserts the
 * (user, memex) marker, zeroing the unread badge — and returns the PREVIOUS
 * marker alongside, so the caller can still classify what was unread.
 *
 * Goes through mutate() per std-8, but SILENT: the marker is per-user
 * read-state (an idempotent re-write of "when did I last look"), not
 * collaborative content — broadcasting every view would be bus noise, and the
 * badge's own zeroing is client-local (the page that posted the view already
 * knows). std-32's activity columns don't apply to this table by design.
 */
export async function recordQaReportsView(
  memexId: string,
  userId: string,
): Promise<QaReportsViewReceipt> {
  const now = new Date();
  const [prior] = await db
    .select({ lastViewedAt: qaReportViews.lastViewedAt })
    .from(qaReportViews)
    .where(and(eq(qaReportViews.userId, userId), eq(qaReportViews.memexId, memexId)));
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
  return { lastViewedAt: now, previousLastViewedAt: prior?.lastViewedAt ?? null };
}
