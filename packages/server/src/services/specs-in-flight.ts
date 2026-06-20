// spec-315 t-1 — "Your specs in flight": the specs a user has recently worked on,
// derived (no stored cursor), CROSS-MEMEX, capped and recency-windowed.
//
// SOURCE (dec-2): the std-32 `activity_view` (services/activity-view.ts), NOT raw
// `activity_log` — the view UNIONs every activity-bearing arm (section edits,
// comments, decisions, AC work, …), so "worked on" via `actor_user_id = me`
// captures the full picture; raw activity_log holds only sourceless events and
// would undercount. The documents arm carries actor NULL (a doc's own creation
// row attributes no actor), so creation is added explicitly via
// `documents.created_by_user_id` — creating a spec IS working on it.
//
// SCOPE (dec-2, Wic's owner-OR-membership principle): Home is a single user-level
// surface, so this spans EVERY Memex the user belongs to. We iterate the user's
// memberships and read each Memex under its own RLS context (runWithMemexId), then
// merge and take the most-recent N. Tenancy is structural — we only ever look in
// Memexes the user is a member of — and each query also carries an explicit
// `memex_id` filter so it is correct even where the test role bypasses RLS
// (ENABLE + NO FORCE, std-36). When the membership-visibility RLS re-key lands
// (issue-1 → std-36), this collapses to one cross-memex query; the behaviour is
// identical.

import { sql } from "drizzle-orm";
import { db, runWithMemexId } from "../db/connection.js";
import { listMemberships } from "./users.js";

export interface SpecInFlight {
  /** The owning spec document id. */
  docId: string;
  /** The per-memex handle, e.g. `spec-12`. */
  handle: string;
  title: string;
  /** Owning Memex — for the provenance pill and click-through routing. */
  memexId: string;
  namespaceSlug: string;
  memexSlug: string;
  memexName: string;
  /** Canonical route to the spec (std-10): `/<ns>/<memex>/specs/<handle>`. */
  path: string;
  /** Most recent activity timestamp the user authored on this spec. */
  lastActivityAt: Date;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_DAYS = 30;

interface MemexProvenance {
  namespaceSlug: string;
  memexSlug: string;
  memexName: string;
}

/**
 * The specs this user has recently worked on, across every Memex they belong to,
 * most-recent first. Capped at `limit` (default 5) within the last `windowDays`
 * (default 30). Each card carries its owning Memex for the provenance pill + route.
 */
export async function listSpecsInFlightForUser(
  userId: string,
  opts: { limit?: number; windowDays?: number } = {},
): Promise<SpecInFlight[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;

  // One row per (memexId); a membership list can repeat a Memex across sources.
  // The namespace/memex slugs + memex name give us the pill + route without a
  // further RLS-restricted join. Exclude `visited` rows: those are read-only pins
  // on public Memexes the user is NOT a member of (spec-111) — "specs in flight"
  // is scoped to Memexes the user belongs to (the membership half of the principle).
  const provByMemex = new Map<string, MemexProvenance>();
  for (const m of await listMemberships(userId)) {
    if (m.source === "visited") continue;
    if (!provByMemex.has(m.memexId)) {
      provByMemex.set(m.memexId, {
        namespaceSlug: m.slug,
        memexSlug: m.memexSlug,
        memexName: m.memexName,
      });
    }
  }

  const all: SpecInFlight[] = [];
  for (const [memexId, prov] of provByMemex) {
    const rows = (await runWithMemexId(memexId, () =>
      db.execute(sql`
        WITH touched AS (
          -- any arm the user authored on this spec (edits, comments, decisions, ACs, …)
          SELECT av.spec_ref AS doc_id, av.at AS at
          FROM activity_view av
          WHERE av.actor_user_id = ${userId}
            AND av.spec_ref IS NOT NULL
            AND av.memex_id = ${memexId}
            AND av.at >= now() - make_interval(days => ${windowDays})
          UNION ALL
          -- creation: the documents arm attributes no actor, so add it explicitly
          SELECT d.id AS doc_id, d.created_at AS at
          FROM documents d
          WHERE d.created_by_user_id = ${userId}
            AND d.memex_id = ${memexId}
            AND d.created_at >= now() - make_interval(days => ${windowDays})
        )
        SELECT d.id AS "docId", d.handle AS "handle", d.title AS "title",
               MAX(t.at) AS "lastActivityAt"
        FROM touched t
        JOIN documents d ON d.id = t.doc_id
        WHERE d.memex_id = ${memexId}
          AND d.doc_type = 'spec'
          AND d.is_demo = false
        GROUP BY d.id, d.handle, d.title
        ORDER BY "lastActivityAt" DESC
        LIMIT ${limit}
      `),
    )) as unknown as Array<{ docId: string; handle: string; title: string; lastActivityAt: Date | string }>;

    for (const r of rows) {
      all.push({
        docId: r.docId,
        handle: r.handle,
        title: r.title,
        memexId,
        namespaceSlug: prov.namespaceSlug,
        memexSlug: prov.memexSlug,
        memexName: prov.memexName,
        path: `/${prov.namespaceSlug}/${prov.memexSlug}/specs/${r.handle}`,
        lastActivityAt: r.lastActivityAt instanceof Date ? r.lastActivityAt : new Date(r.lastActivityAt),
      });
    }
  }

  // Merge across Memexes, newest first, then the global cap.
  all.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  return all.slice(0, limit);
}
