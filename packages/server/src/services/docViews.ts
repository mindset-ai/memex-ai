// spec-448 t-5 — per-user "last-seen version" tracking + catch-up payload.
//
// `doc_views` (t-1 schema) is a per-(user, doc) read-state marker: the highest
// `documents.version` a given user has viewed. It carries NO memex_id (schema.ts
// comment on `docViews`) and its RLS policy (`doc_views_owner_isolation`,
// migration 0125) is a FOR ALL predicate scoped exclusively on the
// `app.user_id` GUC — every read AND write of this table MUST run with that
// GUC set to the acting user's id, or the row is invisible / the INSERT is
// rejected outright (std-36). Unlike `app.memex_id` (set once per-request by
// session middleware, connection.ts), `app.user_id` is opt-in per call
// (mirrors services/journey-state.ts, services/experiments.ts) — so every
// function here wraps its DB access in `runWithUserId`.
//
// Writes go through `mutate()` (std-8) but SILENT, mirroring
// services/qa-reports.ts `recordQaReportsView`: a view marker is per-user
// read-state, not collaborative content — broadcasting every doc open would
// be bus noise, and the badge/banner it feeds is client-local to the reader
// who just produced it.
//
// FILE OWNERSHIP: this is a NEW file, deliberately kept separate from
// services/documents.ts and services/versioning.ts (owned by other spec-448
// tasks) — only routes/documents.ts and agent/handlers/docs.ts call into it.

import { and, eq } from "drizzle-orm";
import { db, runWithUserId } from "../db/connection.js";
import { docViews } from "../db/schema.js";
import type { DocView } from "../db/schema.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";

/** The std-32 channel vocabulary, narrowed to what doc_views' CHECK allows. */
export type DocViewChannel = "rest_ui" | "mcp" | "in_app_agent" | "server";

export interface UpsertDocViewArgs {
  userId: string;
  docId: string;
  /**
   * The owning doc's memexId. doc_views itself carries no memex_id column
   * (schema.ts — it's keyed purely on user+doc), but `mutate()`'s ChangeKey
   * requires one to emit on the bus; callers already have this at hand (it's
   * how they resolved/authorized the doc in the first place), so no extra
   * lookup happens here.
   */
  memexId: string;
  /**
   * The doc's CURRENT `documents.version` at call time. Callers already hold
   * this (the GET /docs/:id projection, the resolved doc in an MCP handler),
   * so this function never re-queries `documents` — it simply writes what
   * it's told, which is what "advancing to the doc's current version" means
   * in practice (the caller is always looking at the current row).
   */
  version: number;
  channel: DocViewChannel;
}

/**
 * Upsert the (userId, docId) marker, advancing `lastViewedVersion` to `version`
 * and `lastViewedAt` to now. Idempotent re-write of "when/what did I last see" —
 * silent (per std-8 §6, mirrors qa_report_view): no SSE consumer needs to know a
 * marker moved, and the reader who moved it already knows.
 */
export async function upsertDocView(
  args: UpsertDocViewArgs,
  ctx: RequestCtx = {},
): Promise<Mutated<DocView>> {
  const { userId, docId, memexId, version, channel } = args;
  const now = new Date();

  return mutate(
    ctx,
    { memexId, docId, userId, entity: "doc_view", action: "updated" },
    () =>
      runWithUserId(userId, async () => {
        const [row] = await db
          .insert(docViews)
          .values({ userId, docId, lastViewedVersion: version, lastViewedAt: now, channel })
          .onConflictDoUpdate({
            target: [docViews.userId, docViews.docId],
            set: { lastViewedVersion: version, lastViewedAt: now, channel },
          })
          .returning();
        return row as DocView;
      }),
    { silent: true },
  );
}

/**
 * Read the caller's own (userId, docId) marker, or null if they've never been
 * stamped as viewing this doc. Wrapped in `runWithUserId` — the FOR ALL RLS
 * policy on doc_views hides every row when `app.user_id` isn't set, including
 * from a plain SELECT.
 */
export async function getDocView(userId: string, docId: string): Promise<DocView | null> {
  return runWithUserId(userId, async () => {
    const [row] = await db
      .select()
      .from(docViews)
      .where(and(eq(docViews.userId, userId), eq(docViews.docId, docId)));
    return row ?? null;
  });
}

export interface CatchUpInfo {
  /** True only when a marker row EXISTS and it's behind the doc's current version. */
  hasCatchUp: boolean;
  /** The version the viewer last saw, when hasCatchUp is true; null otherwise. */
  fromVersion: number | null;
  /** The raw marker value (independent of hasCatchUp), or null if never viewed. */
  lastViewedVersion: number | null;
}

const NO_CATCH_UP: CatchUpInfo = { hasCatchUp: false, fromVersion: null, lastViewedVersion: null };

/**
 * Derive "is this viewer behind on this doc" for a GET /docs/:id-style
 * response. `userId` undefined (anonymous reader) always resolves to
 * NO_CATCH_UP without touching the DB — there is no marker to be behind on.
 *
 * hasCatchUp = a marker row exists AND its lastViewedVersion < doc.version
 * (ac-39). A never-viewed doc (no row) is NOT "caught up behind" — it's simply
 * unmarked, matching doc_views' "read-state marker", not an audit trail.
 */
export async function computeCatchUp(
  doc: { id: string; version: number },
  userId: string | undefined,
): Promise<CatchUpInfo> {
  if (!userId) return NO_CATCH_UP;
  const view = await getDocView(userId, doc.id);
  if (!view) return NO_CATCH_UP;
  const hasCatchUp = view.lastViewedVersion < doc.version;
  return {
    hasCatchUp,
    fromVersion: hasCatchUp ? view.lastViewedVersion : null,
    lastViewedVersion: view.lastViewedVersion,
  };
}
