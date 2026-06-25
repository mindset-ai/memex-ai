-- spec-398 — bounded retention + durable tenancy for test_events.
--
-- Three things, one atomic migration (the hand-runner wraps the file in a single
-- transaction, so the swap + view recreate can't half-apply):
--
--   1. test_event_latest gains a NOT NULL memex_id (dec-4 / ac-8), backfilled from
--      the ac_uid prefix; rows whose prefix no longer resolves are dropped.
--   2. test_events is REWRITTEN-AND-SWAPPED (dec-1 / ac-4), NOT mass-DELETEd:
--        - keep only the latest 10 rows per (ac_uid, test_identifier) by count
--          (dec-2 / ac-2), independent of age;
--        - populate a NOT NULL memex_id resolved from the ac_uid prefix (ac-8);
--        - rows whose prefix doesn't resolve to a live namespace/memex are ORPHANS
--          (already invisible through activity_view's INNER JOINs, on spec-127's
--          self-heal path) and are DROPPED, keeping memex_id NOT NULL and clean.
--      A mass DELETE would leave ~1.9M dead tuples + force a VACUUM FULL; the new
--      table is born bloat-free.
--   3. activity_view is recreated with the test_events arm filtering te.memex_id
--      directly (dec-5 / ac-11, ac-12) instead of joining namespaces→memexes and
--      parsing ac_uid — the per-Spec feed predicate now pushes to an index scan.
--
-- NO RLS here (ac-9): ENABLE ROW LEVEL SECURITY + the memex_id policy are spec-399's
-- scope [per std-36], applied after this column exists. This migration adds the
-- column + backfill + indexes only.
--
-- Index builds are inline on the fresh table (no CREATE INDEX CONCURRENTLY — the
-- runner is transactional). first_verified_at was snapshotted in 0110, BEFORE this
-- prune deletes the oldest passing rows.

-- ── 0. Deadlock guard — take both table locks up front, in the APP's lock order ─
-- This migration mutates test_event_latest (§1 ALTER) before test_events (§2
-- swap). Live /api/test-events emissions take the SAME two locks in the OPPOSITE
-- order (INSERT test_events → UPSERT test_event_latest, routes/test-events.ts), so
-- the first prod release deadlocked (40P01) against traffic and rolled the whole
-- file back. Acquiring both locks here, up front, in the emission order (test_events
-- first), removes the lock-order cycle: the migration now either wins a clean
-- exclusive window or fails fast on lock_timeout and retries on the next deploy — it
-- can never deadlock. It does hold test_events ACCESS EXCLUSIVE for the ~80s the §2
-- row-copy takes, so emissions/feed reads pause for that deploy window — acceptable,
-- and far better than a failed deploy.
--
-- Why the LOCK is wrapped in a DO block rather than a bare `LOCK TABLE`: this file
-- is applied two ways. (1) Prod / the dev hand-runner (apply-hand-migrations.mjs)
-- wraps the whole file in ONE transaction — a bare LOCK would work there. (2) The
-- e2e-cold template build pipes each file through `psql -f` in AUTOCOMMIT, where a
-- bare `LOCK TABLE` errors ("can only be used in transaction blocks", Postgres 16).
-- A DO block runs its body inside an implicit transaction in BOTH paths, so the LOCK
-- is valid either way. The lock has transaction scope, so under the transactional
-- prod runner it is HELD for the rest of the migration (verified via pg_locks);
-- under autocommit it is released when the DO block returns — harmless, since the
-- cold template build has no concurrent traffic to deadlock against. lock_timeout is
-- set at session level first so it bounds the LOCK's wait inside the block.
SET lock_timeout = '15s';
--> statement-breakpoint
DO $$ BEGIN
  LOCK TABLE test_events, test_event_latest IN ACCESS EXCLUSIVE MODE;
END $$;
--> statement-breakpoint

-- ── 1. test_event_latest.memex_id ────────────────────────────────────────────
ALTER TABLE test_event_latest ADD COLUMN IF NOT EXISTS memex_id uuid;
--> statement-breakpoint

UPDATE test_event_latest tel
SET memex_id = te_mx.id
FROM namespaces te_ns
JOIN memexes te_mx ON te_mx.namespace_id = te_ns.id
WHERE te_ns.slug = split_part(tel.ac_uid, '/', 1)
  AND te_mx.slug = split_part(tel.ac_uid, '/', 2)
  AND tel.memex_id IS NULL;
--> statement-breakpoint

DELETE FROM test_event_latest WHERE memex_id IS NULL;
--> statement-breakpoint

ALTER TABLE test_event_latest ALTER COLUMN memex_id SET NOT NULL;
--> statement-breakpoint

-- ── 2. test_events rewrite-and-swap (keep last 10 + memex_id) ─────────────────
CREATE TABLE test_events_new (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ac_uid          text NOT NULL,
  memex_id        uuid NOT NULL,
  status          text NOT NULL,
  test_identifier text,
  duration_ms     integer,
  commit_sha      text,
  run_id          text,
  actor           text,
  hidden          boolean NOT NULL DEFAULT false,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_events_status_valid CHECK (status IN ('pass', 'fail', 'error'))
);
--> statement-breakpoint

-- Keep the latest 10 per (ac_uid, test_identifier) by created_at DESC (id DESC as
-- a deterministic tiebreak), resolving memex_id from the ac_uid prefix. The INNER
-- JOINs drop orphan rows whose prefix doesn't resolve — same set activity_view
-- already hides today.
INSERT INTO test_events_new
  (id, ac_uid, memex_id, status, test_identifier, duration_ms, commit_sha, run_id, actor, hidden, metadata, created_at)
SELECT
  te.id, te.ac_uid, te_mx.id, te.status, te.test_identifier, te.duration_ms,
  te.commit_sha, te.run_id, te.actor, te.hidden, te.metadata, te.created_at
FROM (
  SELECT
    t.*,
    row_number() OVER (
      PARTITION BY t.ac_uid, COALESCE(t.test_identifier, '')
      ORDER BY t.created_at DESC, t.id DESC
    ) AS rn
  FROM test_events t
) te
JOIN namespaces te_ns ON te_ns.slug = split_part(te.ac_uid, '/', 1)
JOIN memexes te_mx
  ON te_mx.namespace_id = te_ns.id
 AND te_mx.slug = split_part(te.ac_uid, '/', 2)
WHERE te.rn <= 10;
--> statement-breakpoint

-- activity_view depends on test_events; drop it before the table, recreate after.
DROP VIEW IF EXISTS activity_view;
--> statement-breakpoint

DROP TABLE test_events;
--> statement-breakpoint

ALTER TABLE test_events_new RENAME TO test_events;
--> statement-breakpoint

-- Recreate indexes with their canonical names (free now the old table is gone),
-- matching db/schema.ts exactly so the drift gate stays green.
CREATE INDEX test_events_ac_uid_created_at_idx ON test_events (ac_uid, created_at);
--> statement-breakpoint
CREATE INDEX test_events_test_identifier_idx ON test_events (test_identifier, created_at);
--> statement-breakpoint
CREATE INDEX test_events_created_at_idx ON test_events (created_at);
--> statement-breakpoint
CREATE INDEX test_events_retention_idx ON test_events (ac_uid, test_identifier, created_at);
--> statement-breakpoint
CREATE INDEX test_events_memex_id_created_at_idx ON test_events (memex_id, created_at);
--> statement-breakpoint

-- ── 3. activity_view: test_events arm now filters the stored memex_id ─────────
-- Reproduced from migration 0109 verbatim EXCEPT the test_events arm (Arm 2),
-- which drops the namespaces→memexes join + ac_uid tenancy parse in favour of the
-- stored te.memex_id. spec_ref still resolves to the spec doc by (memex_id, handle)
-- so the output is identical (ac-12), but the per-Spec predicate `WHERE memex_id=?`
-- now pushes to test_events_memex_id_created_at_idx instead of a full Seq Scan
-- (ac-11). security_invoker retained.
CREATE OR REPLACE VIEW activity_view WITH (security_invoker = true) AS

SELECT
  d.created_at                          AS at,
  NULL::uuid                            AS actor_user_id,
  NULL::text                            AS actor_name,
  NULL::text                            AS actor_raw,
  NULL::text                            AS channel,
  d.id                                  AS spec_ref,
  'document'::text                      AS kind,
  d.id                                  AS entity_id,
  'created'::text                       AS action,
  NULL::text                            AS narrative,
  d.memex_id                            AS memex_id
FROM documents d

UNION ALL

SELECT
  COALESCE(a.updated_at, a.created_at)  AS at,
  a.actor_user_id                       AS actor_user_id,
  a.actor_name                          AS actor_name,
  NULL::text                            AS actor_raw,
  a.channel                             AS channel,
  a.brief_id                            AS spec_ref,
  'ac'::text                            AS kind,
  a.id                                  AS entity_id,
  'created'::text                       AS action,
  a.statement                           AS narrative,
  a.memex_id                            AS memex_id
FROM acs a

UNION ALL

SELECT
  t.created_at                          AS at,
  t.actor_user_id                       AS actor_user_id,
  t.actor_name                          AS actor_name,
  NULL::text                            AS actor_raw,
  t.channel                             AS channel,
  t.doc_id                              AS spec_ref,
  'task'::text                          AS kind,
  t.id                                  AS entity_id,
  'created'::text                       AS action,
  t.title                               AS narrative,
  t.memex_id                            AS memex_id
FROM tasks t

UNION ALL

SELECT
  dec.created_at                        AS at,
  dec.actor_user_id                     AS actor_user_id,
  dec.actor_name                        AS actor_name,
  NULL::text                            AS actor_raw,
  dec.channel                           AS channel,
  dec.doc_id                            AS spec_ref,
  'decision'::text                      AS kind,
  dec.id                                AS entity_id,
  'created'::text                       AS action,
  dec.title                             AS narrative,
  dec.memex_id                          AS memex_id
FROM decisions dec

UNION ALL

SELECT
  COALESCE(s.updated_at, s.created_at)  AS at,
  s.actor_user_id                       AS actor_user_id,
  s.actor_name                          AS actor_name,
  NULL::text                            AS actor_raw,
  s.channel                             AS channel,
  s.doc_id                              AS spec_ref,
  'section'::text                       AS kind,
  s.id                                  AS entity_id,
  'created'::text                       AS action,
  s.title                               AS narrative,
  (SELECT pd.memex_id FROM documents pd WHERE pd.id = s.doc_id) AS memex_id
FROM doc_sections s

UNION ALL

SELECT
  c.created_at                          AS at,
  c.author_user_id                      AS actor_user_id,
  c.author_name                         AS actor_name,
  NULL::text                            AS actor_raw,
  c.channel                             AS channel,
  c.doc_id                              AS spec_ref,
  'comment'::text                       AS kind,
  c.id                                  AS entity_id,
  'created'::text                       AS action,
  c.content                             AS narrative,
  c.memex_id                            AS memex_id
FROM doc_comments c

UNION ALL

-- ── Arm 2: test_events — TENANT-SCOPED via the stored memex_id (spec-398) ─────
SELECT
  te.created_at                         AS at,
  NULL::uuid                            AS actor_user_id,
  NULL::text                            AS actor_name,
  te.actor                              AS actor_raw,
  NULL::text                            AS channel,
  spec_doc.id                           AS spec_ref,
  'test_event'::text                    AS kind,
  te.id                                 AS entity_id,
  CASE
    WHEN te.status = 'pass' THEN 'verified'
    WHEN te.status IN ('fail', 'error') THEN 'regressed'
    ELSE te.status
  END                                   AS action,
  NULL::text                            AS narrative,
  te.memex_id                           AS memex_id
FROM test_events te
JOIN documents spec_doc
  ON spec_doc.memex_id = te.memex_id
 AND spec_doc.handle = substring(te.ac_uid from 'specs/([^/]+)/')
 AND spec_doc.doc_type = 'spec'

UNION ALL

SELECT
  al.created_at                         AS at,
  al.actor_user_id                      AS actor_user_id,
  al.actor_name                         AS actor_name,
  NULL::text                            AS actor_raw,
  al.channel                            AS channel,
  al.brief_id                           AS spec_ref,
  'activity_log'::text                  AS kind,
  al.id                                 AS entity_id,
  al.action                             AS action,
  al.narrative                          AS narrative,
  al.memex_id                           AS memex_id
FROM activity_log al;
