-- spec-566 t-1 (ac-14, ac-15, ac-16, ac-17) — the Spec lifecycle journal.
--
-- WHAT THIS IS. One append-only table recording the acts that REMOVE or REVERSE
-- something: a test's evidence retired (t-4), an AC's status transitioned (t-6),
-- the done-gate overridden (t-7), a closed Spec reopened (t-8). dec-3 ruled the
-- journal is BUILT ONCE — four writers, one table, one `kind` discriminator.
--
-- ⚠ THIS IS NOT A REVIVAL OF `hidden`, AND THAT DISTINCTION IS THE WHOLE DESIGN.
-- spec-358 dec-1 removed a MUTABLE FLAG on the live rows whose purpose was
-- RESTORING them, and explicitly accepted losing "reversibility/audit-retention
-- of an orphan retirement". This table is the opposite object: a write-once
-- receipt, never read back to restore anything. The `test_events` rows still
-- hard-delete in `discontinueTestEventsForAc`. spec-358's outcome is untouched;
-- what survives here is the ACT, not the data.
--
-- WHY NOT activity_log — measured against develop on 2026-09-15, not assumed:
--
--   1. RETENTION. `services/activity-log-sweep.ts` runs
--        DELETE ... WHERE created_at < now() - (PULSE_RETENTION_DAYS * INTERVAL '1 day')
--      with DEFAULT_RETENTION_DAYS = 30. A tombstone that expires in 30 days is
--      not a tombstone.
--   2. ADVISORY WRITES. `persistEvent` (services/activity-log.ts) says in its own
--      docstring: "any failure is logged and swallowed so the originating emitter
--      is never affected." A store permitted to silently miss writes cannot be a
--      record of what happened.
--
--   The Spec's Overview originally claimed retirement "leaves nothing behind".
--   That was wrong and is corrected: a retirement DOES write an activity_log row
--   today — it just says "ac updated", names no test identifier, no reason and no
--   commit, expires at 30 days, and may silently not exist. Unnamed, expiring,
--   best-effort. That is the gap this table closes, and it is narrower than
--   "nothing is recorded".
--
-- STD-32 — load-bearing fields are COLUMNS. `reason` is filtered on by the
-- override and reopen counts; `kind` by every reader; `test_identifier` by the
-- retirement trace and by spec-554 if it consumes this. There is deliberately NO
-- payload/metadata bag: no bag means no place to hide a load-bearing field, and
-- ac-14 asserts the absence. `actor_name` is stamped at write (denormalised
-- snapshot) so a later rename cannot rewrite historical attribution.
--
-- STD-39 — LOCK PROFILE. This migration CREATEs one new table and its two
-- indexes. It takes no lock on any existing table: `test_events` and
-- `test_event_latest` are not referenced, and the three FKs point at `memexes`,
-- `documents`, `acs` and `users`, where ADD CONSTRAINT on the CHILD side takes a
-- SHARE ROW EXCLUSIVE on the parent only for the duration of the CREATE. That
-- matters here specifically: spec-398's retention migration on `test_event_latest`
-- aborted a production deploy, and this Spec's journal is the one place a careless
-- author would reach for that table.
--
-- GROWTH. Tens of rows per year per Memex. These are rare, deliberate acts, not
-- telemetry — which is exactly why they can afford to be durable when
-- `test_events` cannot.
--
-- STD-36 — RLS: ENABLE, never FORCE. `memex_id` is the tenant key, set by
-- `runWithMemexId`. The runtime role is a non-owner and is subject to the policy;
-- migrations run as the owner and bypass it.

CREATE TABLE IF NOT EXISTS "spec_lifecycle_events" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "memex_id"         uuid NOT NULL REFERENCES "memexes"("id") ON DELETE CASCADE,
  -- SET NULL, not CASCADE: deleting a Spec or a user must not erase the record of
  -- what was removed from it. The row loses its live link and keeps its meaning —
  -- the same choice activity_log made, for the same reason.
  "brief_id"         uuid REFERENCES "documents"("id") ON DELETE SET NULL,
  "ac_id"            uuid REFERENCES "acs"("id") ON DELETE SET NULL,
  "kind"             text NOT NULL,
  "reason"           text NOT NULL,
  "commit_sha"       text,
  "test_identifier"  text,
  "from_status"      text,
  "to_status"        text,
  "actor_user_id"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_name"       text,
  "channel"          text NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "spec_lifecycle_events_kind_valid"
    CHECK ("kind" IN ('test_retired', 'ac_status_changed', 'gate_overridden', 'spec_reopened')),

  -- Every one of the four acts is a judgement. A judgement with no stated reason
  -- is the quiet path this Spec exists to close, so the database refuses it
  -- rather than trusting four call sites to remember.
  CONSTRAINT "spec_lifecycle_events_reason_present"
    CHECK (length(btrim("reason")) > 0),

  -- A retirement that cannot name what it retired answers none of its three
  -- consumers.
  CONSTRAINT "spec_lifecycle_events_retirement_names_its_test"
    CHECK ("kind" <> 'test_retired' OR "test_identifier" IS NOT NULL),

  CONSTRAINT "spec_lifecycle_events_channel_valid"
    CHECK ("channel" IN ('rest_ui', 'mcp', 'in_app_agent', 'server'))
);

-- Reads are "this Memex's recent lifecycle acts" (the counts beside coverage) and
-- "this Spec's" (the Spec page). DESC because every reader wants the newest.
CREATE INDEX IF NOT EXISTS "spec_lifecycle_events_memex_id_created_at_idx"
  ON "spec_lifecycle_events" ("memex_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "spec_lifecycle_events_brief_id_created_at_idx"
  ON "spec_lifecycle_events" ("brief_id", "created_at" DESC)
  WHERE "brief_id" IS NOT NULL;

-- std-36: ENABLE, never FORCE.
ALTER TABLE "spec_lifecycle_events" ENABLE ROW LEVEL SECURITY;

-- The `nullif(...) IS NOT NULL` guard is not decoration: with the GUC unset,
-- current_setting(..., true) yields '' and the bare `''::uuid` cast RAISES rather
-- than denying. The guard makes an unset tenant a clean deny, which is the
-- behaviour every other policy here already has (0081, 0100).
DROP POLICY IF EXISTS "spec_lifecycle_events_memex_isolation" ON "spec_lifecycle_events";
CREATE POLICY "spec_lifecycle_events_memex_isolation" ON "spec_lifecycle_events"
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND "memex_id" = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND "memex_id" = current_setting('app.memex_id', true)::uuid
  );
