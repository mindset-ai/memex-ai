-- spec-122 t-6 (dec-1) — the activity VIEW. One read-only SQL view that UNION ALLs
-- every kind of activity source into ONE uniform shape, so a single query returns
-- every activity without a second materialised ledger. The activity-contract
-- columns this projects already exist on the source tables (t-1/t-2, 0085/0086):
-- acs/tasks/decisions/doc_sections carry actor_user_id/actor_name/channel;
-- doc_comments carries channel (+ author_user_id/author_name); activity_log carries
-- actor_user_id/actor_name/actor_kind/channel; test_events carries a TOP-LEVEL
-- `actor` text column.
--
-- Uniform projection (every arm):
--   at            timestamptz   WHEN — each arm projects its OWN timestamp so a
--                               source row and its view line never disagree (ac-8).
--   actor_user_id uuid          WHO (resolved user), NULL on the test_events arm.
--   actor_name    text          WHO (denormalised display snapshot), NULL on test_events.
--   actor_raw     text          the free-form actor string — test_events arm ONLY
--                               (read at the read path by who-resolver.ts); NULL elsewhere.
--   channel       text          HOW.
--   spec_ref      uuid          the OWNING spec/doc id — the join key.
--   kind          text          a literal provenance constant per arm.
--   entity_id     uuid          the source row id.
--   action        text          WHAT happened.
--   narrative     text          free-form description (nullable).
--   memex_id      uuid          tenancy — every read scopes by this.
--
-- Provenance (ac-3): this is a derived VIEW, not a second materialised ledger.
-- activity_log + services/activity-log-sweep.ts are RETAINED (ac-7) — the
-- activity_log arm UNIONs the sourceless events (checkpoint beats, spec-179
-- status_changed phase moves) that have no source-table row.
--
-- Idempotent: CREATE OR REPLACE VIEW. The hand-migration runner wraps this file in
-- a single transaction tracked in manual_migrations.
--
-- security_invoker = true (spec-199 RLS, PG15+): the view evaluates the
-- underlying tables' RLS policies as the QUERYING role, not the view owner, so
-- tenant isolation is enforced at the DB for every arm — not left to the
-- caller's app-level WHERE. Under the restricted runtime role `memex_app` with
-- app.memex_id set, the RLS-bearing arms (documents/acs/tasks/decisions/
-- doc_comments, and the test_events arm's documents JOIN) return only the
-- current tenant's rows — which also closes the test_events handle-join across
-- memexes that share a spec handle. The superuser (migrations, local dev, tests)
-- bypasses RLS, so this is inert there; the listActivityView WHERE memex_id = $1
-- predicate remains as belt-and-braces and as the scope for the non-RLS arms
-- (activity_log, doc_sections).
CREATE OR REPLACE VIEW activity_view WITH (security_invoker = true) AS

-- ── Arm 1: source tables ─────────────────────────────────────────────────────
-- Each projects its OWN timestamp (COALESCE(updated_at, created_at) where an
-- updated_at exists, else created_at) and its OWN actor columns (ac-8). spec_ref
-- is the owning doc id; kind is a per-table literal.

-- documents (the spec/doc itself). No updated_at → created_at.
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

-- acs
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

-- tasks (no updated_at column → created_at)
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

-- decisions (no updated_at column → created_at)
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

-- doc_sections
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
  -- doc_sections has no memex_id; derive it from the owning document.
  (SELECT pd.memex_id FROM documents pd WHERE pd.id = s.doc_id) AS memex_id
FROM doc_sections s

UNION ALL

-- doc_comments — WHO is author_user_id / author_name (no actor_* columns here).
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

-- ── Arm 2: test_events — verification flips ──────────────────────────────────
-- The free-form actor rides the TOP-LEVEL test_events.actor column → actor_raw
-- (ac-22; a legacy metadata->>'actor' key is IGNORED). actor_user_id/actor_name
-- are NULL — the string is resolved at read-time by services/who-resolver.ts.
-- spec_ref: parse the spec handle from ac_uid (.../specs/spec-N/acs/ac-M) and join
-- documents on (handle, memex_id) to recover the spec uuid. The join also supplies
-- memex_id, which test_events does not carry.
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
  spec_doc.memex_id                     AS memex_id
FROM test_events te
JOIN documents spec_doc
  ON spec_doc.handle = substring(te.ac_uid from 'specs/([^/]+)/')
 AND spec_doc.doc_type = 'spec'

UNION ALL

-- ── Arm 3: activity_log — the SOURCELESS events ──────────────────────────────
-- Checkpoint beats + spec-179 status_changed phase moves. These have NO
-- source-table row, so the view UNIONs them straight from activity_log. RETAINED
-- (ac-7) — never dropped in favour of the view.
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
