-- One-off cleanup: collapse the cross-instance triplicate rows in activity_log
-- (spec-122 / PR #133 follow-up).
--
-- WHY THESE ROWS EXIST
-- Until PR #133, prod ran --max-instances 3 and the spec-156 bus relay re-emitted
-- every event onto the OTHER instances' local buses. The activity-log sink fired
-- on those relayed events too, so each logical mutation was persisted ONCE PER
-- INSTANCE — up to 3 byte-identical activity_log rows, differing only in `id` and
-- a few milliseconds of `created_at` (the relay round-trip skew). PR #133 stops
-- new duplicates; this script removes the ones already written.
--
-- HOW IT FINDS THEM (gaps-and-islands, NOT a fixed time bucket)
-- Within each group of content-identical rows, we order by created_at and start a
-- new "island" whenever the gap from the previous identical row exceeds
-- :window_seconds. A relay triplet lands within a few ms, so all 3 copies share one
-- island; we KEEP the earliest (the origin write) and delete the rest. Two events
-- that are genuinely distinct (different narrative/actor/etc.) never share a
-- content group, and identical events more than :window_seconds apart fall into
-- separate islands and are both kept. Islands (not a clock bucket) are used so a
-- triplet that happens to straddle a whole-second boundary still collapses.
--
-- SAFETY
--   • Run the PREVIEW (Step 1 / Step 2) first and eyeball the counts.
--   • The whole thing is wrapped in a transaction — COMMIT only when satisfied.
--   • Self-limiting: pre-relay-era rows have no content-identical neighbour within
--     the window, so they are never touched even though the scope is global.
--
-- BLAST-RADIUS CAP (the key safety property)
-- There is NO time-based way to tell a relay triplet apart from a legitimate
-- batch of byte-identical events: created_at defaults to now(), but every mutate()
-- is its own transaction, so a batch (e.g. clearing a 16-message conversation, or
-- a seed creating 8 ACs whose narrative has no per-row id) inserts ms-apart — the
-- SAME signature as the relay. The ONE thing we know: the relay fans out to at
-- most :max_copies instances (prod = --max-instances 3), so a relay island can
-- never exceed :max_copies rows. This script therefore ONLY collapses islands of
-- size 2..:max_copies and LEAVES LARGER ISLANDS UNTOUCHED (they must contain real
-- repeats). Step 2b lists the spared islands so you can eyeball them.
--
-- RESIDUAL CAVEAT (accept before running)
--   • A genuine batch of 2..:max_copies byte-identical events within the window is
--     indistinguishable from a relay dup and WILL collapse to one row. In practice
--     this only hits low-value rows whose narrative lacks an identifier
--     (conversation_message/deleted batches, fallback-narrative creates) — for a
--     Pulse feed that is harmless noise reduction. The high-value rows in the bug
--     report (doc_member / doc_assignee / document / tag) carry a spec handle in
--     the narrative and don't come in byte-identical batches, so they are
--     unaffected except for the genuine relay duplication we want gone.
--   • Oversize events the relay TRIMMED (narrative/payload dropped, ac-10) produce
--     a non-identical copy and so are NOT deduped here. Rare; handle separately.
--
-- USAGE
--   psql "$DATABASE_URL" -v window_seconds=3 -v max_copies=3 -f scripts/dedup-activity-log.sql
-- (window_seconds defaults to 3, max_copies to 3, if -v is omitted.)

\set ON_ERROR_STOP on
-- Defaults when the caller didn't pass -v.
\if :{?window_seconds}
\else
  \set window_seconds 3
\endif
\if :{?max_copies}
\else
  \set max_copies 3
\endif

BEGIN;

-- The reusable detector: every row tagged with the island it belongs to, plus its
-- rank within that island (rn = 1 is the keeper, the earliest/origin row).
CREATE TEMP TABLE _dedup_ranked ON COMMIT DROP AS
WITH content AS (
  SELECT
    id,
    created_at,
    -- Content fingerprint: everything the sink writes EXCEPT id + created_at.
    -- NULLs are coalesced so two NULLs match (md5 of identical text).
    md5(
      memex_id::text                || E'\x1f' ||
      COALESCE(brief_id::text, '')   || E'\x1f' ||
      COALESCE(actor_user_id::text,'')|| E'\x1f' ||
      COALESCE(actor_name, '')       || E'\x1f' ||
      actor_kind::text               || E'\x1f' ||
      channel::text                  || E'\x1f' ||
      COALESCE(client_id, '')        || E'\x1f' ||
      entity::text                   || E'\x1f' ||
      action::text                   || E'\x1f' ||
      narrative                      || E'\x1f' ||
      COALESCE(payload::text, '')
    ) AS content_key
  FROM activity_log
),
flagged AS (
  SELECT
    id, created_at, content_key,
    -- New island when the gap to the previous identical row exceeds the window
    -- (or there is no previous identical row → first row of the group).
    CASE
      WHEN created_at - LAG(created_at) OVER w <= make_interval(secs => :window_seconds)
      THEN 0 ELSE 1
    END AS is_new_island
  FROM content
  WINDOW w AS (PARTITION BY content_key ORDER BY created_at, id)
),
islands AS (
  SELECT
    id, content_key, created_at,
    SUM(is_new_island) OVER (
      PARTITION BY content_key ORDER BY created_at, id
      ROWS UNBOUNDED PRECEDING
    ) AS island
  FROM flagged
)
SELECT
  id,
  content_key,
  island,
  ROW_NUMBER() OVER (PARTITION BY content_key, island ORDER BY created_at, id) AS rn,
  COUNT(*)     OVER (PARTITION BY content_key, island)                          AS island_size
FROM islands;

-- A row is a DELETABLE duplicate only when it is beyond the first in its island
-- (rn > 1) AND its island is small enough to be a plausible relay fan-out
-- (island_size <= :max_copies). Larger islands are spared entirely.
-- Helper view kept inline below; we just reuse the WHERE clause everywhere.

-- ── Step 1: PREVIEW — what WOULD be deleted (capped at :max_copies) ─────────
\echo '== Rows that WOULD be deleted: rn>1 AND island_size<=:max_copies =='
SELECT
  count(*) FILTER (WHERE rn > 1 AND island_size <= :max_copies)         AS rows_to_delete,
  count(*)                                                              AS total_rows,
  count(DISTINCT content_key || ':' || island)
    FILTER (WHERE rn > 1 AND island_size <= :max_copies)                AS affected_events,
  round(100.0 * count(*) FILTER (WHERE rn > 1 AND island_size <= :max_copies)
        / NULLIF(count(*),0), 1)                                        AS pct_of_table
FROM _dedup_ranked;

-- ── Step 2: PREVIEW — island-size distribution (deleted vs spared) ──────────
-- Sizes 2..:max_copies collapse (relay fan-out). Sizes > :max_copies are SPARED
-- (can't be pure relay dups — they hold real repeats).
\echo '== Island-size distribution (action = collapse vs SPARE) =='
SELECT
  island_size,
  count(*) AS num_events,
  CASE WHEN island_size <= :max_copies THEN 'collapse' ELSE 'SPARE (too big for relay)' END AS action
FROM (
  SELECT content_key, island, count(*) AS island_size
  FROM _dedup_ranked
  GROUP BY content_key, island
  HAVING count(*) > 1
) s
GROUP BY island_size
ORDER BY island_size;

-- ── Step 2b: PREVIEW — the SPARED large islands, by kind ────────────────────
-- Eyeball these: they are the events the cap protects from a wrong delete.
\echo '== Spared large islands (size > :max_copies), grouped by entity/action =='
SELECT entity, action, count(*) AS spared_islands
FROM (
  SELECT r.content_key, r.island, al.entity, al.action
  FROM _dedup_ranked r
  JOIN activity_log al ON al.id = r.id
  WHERE r.island_size > :max_copies
  GROUP BY r.content_key, r.island, al.entity, al.action
) s
GROUP BY entity, action
ORDER BY spared_islands DESC;

-- ── Step 3: DELETE the capped duplicates (keepers — rn = 1 — untouched) ─────
-- Commented out by default. Review Steps 1-2b, then uncomment and switch the
-- final ROLLBACK to COMMIT.
--
-- DELETE FROM activity_log
-- WHERE id IN (
--   SELECT id FROM _dedup_ranked
--   WHERE rn > 1 AND island_size <= :max_copies
-- );
--
-- \echo '== Deleted. Re-run Step 1 to confirm rows_to_delete is now 0. =='

-- Default posture: ROLL BACK so a bare run is pure preview and changes nothing.
-- Switch to COMMIT (and uncomment the DELETE above) to apply.
ROLLBACK;
