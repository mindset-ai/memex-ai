-- spec-396 — SECURITY: close the cross-org activity bleed in activity_view.
--
-- THE LEAK (fixed here): the test_events arm of activity_view (migration 0089)
-- joined test_events → documents on the SPEC HANDLE alone:
--
--     ON spec_doc.handle = substring(te.ac_uid from 'specs/([^/]+)/')
--    AND spec_doc.doc_type = 'spec'
--
-- `test_events` carries NO memex_id and NO RLS — every memex's events are
-- globally visible; tenancy lives only inside the `ac_uid` STRING
-- (<namespace>/<memex>/specs/spec-N/acs/ac-M). Spec handles ("spec-1", "spec-99")
-- are per-memex and collide across every memex, so one memex's test event matched
-- EVERY other memex's same-numbered spec and inherited that doc's memex_id — a
-- live cross-org bleed (markhadfield@agent-craft surfaced inside
-- mindset-prod/memex-building-itself; ~1.5M rows affected). RLS on `documents`
-- did NOT backstop it: it scopes which documents are visible, but the unprotected
-- test_events row is the bridge and has no tenancy to filter on. The 0089 header's
-- claim that security_invoker "closes the handle-join across memexes", and the
-- arm's claim of a "(handle, memex_id)" join, were both false.
--
-- THE FIX: resolve the owning memex from the FULL ac_uid prefix
-- (<namespace>/<memex>) via namespaces+memexes, and REQUIRE the spec doc to live
-- in that memex (spec_doc.memex_id = te_mx.id). Handle-only matching is gone, so a
-- test event can only ever attach to a spec in its OWN memex. Rows whose ac_uid
-- prefix doesn't resolve to a real namespace/memex (legacy/partial ac_uids) are
-- dropped rather than mis-attributed.
--
-- Every OTHER arm is reproduced verbatim from 0089 (CREATE OR REPLACE VIEW must
-- restate the whole view). security_invoker is retained. Idempotent.

CREATE OR REPLACE VIEW activity_view WITH (security_invoker = true) AS

-- ── Arm 1: source tables ─────────────────────────────────────────────────────

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

-- ── Arm 2: test_events — verification flips, TENANT-SCOPED (spec-396) ─────────
-- The free-form actor rides the TOP-LEVEL test_events.actor column → actor_raw
-- (resolved at the read path by services/who-resolver.ts). actor_user_id /
-- actor_name are NULL.
--
-- spec_ref / memex_id are recovered by resolving the FULL ac_uid prefix
-- (<namespace>/<memex>) to a memex and requiring the spec doc to live in it — NOT
-- by the spec handle alone (that was the cross-org leak this migration fixes). A
-- test event can therefore only attach to a spec in its OWN memex.
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
JOIN namespaces te_ns
  ON te_ns.slug = split_part(te.ac_uid, '/', 1)
JOIN memexes te_mx
  ON te_mx.namespace_id = te_ns.id
 AND te_mx.slug = split_part(te.ac_uid, '/', 2)
JOIN documents spec_doc
  ON spec_doc.memex_id = te_mx.id
 AND spec_doc.handle = substring(te.ac_uid from 'specs/([^/]+)/')
 AND spec_doc.doc_type = 'spec'

UNION ALL

-- ── Arm 3: activity_log — the SOURCELESS events ──────────────────────────────
-- Checkpoint beats + spec-179 status_changed phase moves. These have NO
-- source-table row, so the view UNIONs them straight from activity_log.
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
