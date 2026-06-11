// spec-122 t-6 (dec-1) — the read side of the activity VIEW. `activity_view` is a
// derived SQL view (drizzle/0089_activity_view.sql) that UNION ALLs every activity
// source into one uniform shape, so a single query returns every kind of activity
// without a second materialised ledger. The view is NOT a drizzle table, so this
// selects from it with raw `sql` and a typed result interface.
//
// The free-form `actor_raw` (test_events arm) is resolved to a display WHO at the
// read path by services/who-resolver.ts — NOT here and NOT in SQL.

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";

/** One uniform activity line — the projected shape of every UNION arm. */
export interface ActivityViewRow {
  /** WHEN — the arm's own timestamp (source rows never disagree with the view). */
  at: Date;
  /** WHO (resolved user); NULL on the test_events arm. */
  actorUserId: string | null;
  /** WHO (denormalised display snapshot); NULL on the test_events arm. */
  actorName: string | null;
  /** The free-form actor string — test_events arm ONLY; NULL elsewhere. */
  actorRaw: string | null;
  /** HOW. */
  channel: string | null;
  /** The OWNING spec/doc id — the join key. */
  specRef: string | null;
  /** Per-arm provenance literal: ac|task|decision|section|comment|document|test_event|activity_log. */
  kind: string;
  /** The source row id. */
  entityId: string | null;
  /** WHAT happened. */
  action: string | null;
  /** Free-form description (nullable). */
  narrative: string | null;
  /** Tenancy. */
  memexId: string | null;
}

export interface ListActivityViewOptions {
  /** Filter to one spec/doc by its owning id (the view's spec_ref join key). */
  specRef?: string;
  /** Cap the row count (default 200). */
  limit?: number;
}

/**
 * Read the activity view for one memex, newest first. Optionally narrow to a
 * single spec via `specRef`. Returns the uniform {WHEN, WHO, HOW, WHAT} rows
 * across every arm — source creates, verification flips, sourceless events — in
 * one query.
 */
export async function listActivityView(
  memexId: string,
  opts: ListActivityViewOptions = {},
): Promise<ActivityViewRow[]> {
  const limit = opts.limit ?? 200;
  const specFilter = opts.specRef
    ? sql`AND spec_ref = ${opts.specRef}`
    : sql``;

  const rows = (await db.execute(sql`
    SELECT
      at,
      actor_user_id  AS "actorUserId",
      actor_name     AS "actorName",
      actor_raw      AS "actorRaw",
      channel,
      spec_ref       AS "specRef",
      kind,
      entity_id      AS "entityId",
      action,
      narrative,
      memex_id       AS "memexId"
    FROM activity_view
    WHERE memex_id = ${memexId}
    ${specFilter}
    ORDER BY at DESC
    LIMIT ${limit}
  `)) as unknown as ActivityViewRow[];

  // db.execute returns raw driver rows: a timestamptz comes back as a STRING, not
  // a Date. Coerce to honour the `at: Date` contract so callers can do date math
  // (e.g. the get_doc ACTIVITY block's recency window) without a runtime throw.
  return rows.map((r) => ({
    ...r,
    at: r.at instanceof Date ? r.at : new Date(r.at as unknown as string),
  }));
}
