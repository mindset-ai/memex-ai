-- spec-398 t-6 (dec-1 caveat / spec-125): durable first-verified snapshot.
--
-- WHY: analytics.acsOverTime derives the "alignment over time" curve from
--   first_pass := min(created_at) per ac_uid over the FULL test_events history
--   (WHERE status='pass'). spec-398's keep-last-10 retention (migration 0111)
--   deletes the OLDEST passing emission, which is exactly that first-pass row —
--   so after retention the curve would silently shift/erase. This is the spec-125
--   operational-vs-analytical tier split: test_events becomes the OPERATIONAL
--   tier (bounded), and the long-history "when did this AC first go green" fact
--   moves to a durable analytical store that retention never touches.
--
-- WHAT: a tiny append-once table keyed by ac_uid holding the earliest passing
--   emission time. The write path upserts it on every passing emission with
--   LEAST() so the earliest wins regardless of arrival order; analytics reads it
--   instead of scanning test_events history (see analytics.ts).
--
-- ORDER: this migration is numbered BEFORE the retention rewrite-and-swap (0111)
--   so the backfill below reads the still-complete history before any pruning.
--
-- Idempotent (IF NOT EXISTS + ON CONFLICT DO NOTHING): the hand-migration runner
-- wraps the file in one transaction and tracks it in manual_migrations.

CREATE TABLE IF NOT EXISTS ac_first_verified (
  ac_uid            text PRIMARY KEY,
  first_verified_at timestamptz NOT NULL
);
--> statement-breakpoint

-- Backfill from the complete (pre-retention) history. hidden rows are excluded,
-- matching the analytics first_pass CTE (status='pass' AND hidden=false).
INSERT INTO ac_first_verified (ac_uid, first_verified_at)
SELECT ac_uid, min(created_at)
FROM test_events
WHERE status = 'pass' AND hidden = false
GROUP BY ac_uid
ON CONFLICT (ac_uid) DO UPDATE
  SET first_verified_at = LEAST(ac_first_verified.first_verified_at, EXCLUDED.first_verified_at);
