-- spec-151 dec-3 (t-2 / ac-9) — rename the verifiable-subject column ac_uid →
-- subject_ref on ALL THREE tables that carry it. Under dec-1's "verifiable
-- subject" model the column holds an AC ref OR a standard-clause ref, so the
-- ac_uid name was an AC-specific misnomer (a std-1-style partial-rename seam).
--
-- SCOPE: test_events (the append-only log), test_event_latest (PK component:
-- (ac_uid, test_identifier)), and ac_first_verified (PK: ac_uid). Renaming a PK
-- column is fine — the PK follows the column. The activity_view depends on
-- test_events.ac_uid / test_event_latest.ac_uid; Postgres rewrites a view's
-- stored definition automatically on RENAME COLUMN (the dependency is tracked by
-- column identity, not name), and the view derives `spec_ref` via
-- split_part(...) rather than exporting ac_uid, so no view output column changes.
--
-- COST/LOCKS (std-39): RENAME COLUMN is a catalog-only change — no table rewrite,
-- no data movement. It takes a brief ACCESS EXCLUSIVE lock to update the catalog
-- (and the dependent view), then releases; it does NOT hold a long lock like the
-- spec-398 rewrite-and-swap did. No lock-ordering hazard: a single DDL statement
-- per table, no interleaving with the live emission path's
-- test_events→test_event_latest order.
--
-- WIRE CONTRACT: the POST /api/test-events `ac_uid` field is a SEPARATE concern
-- (a published wire contract). It is unchanged here; t-3 adds dual-accept
-- (ac_uid + subject_ref) at the route boundary. This migration is the column only.
--
-- Idempotent: each rename runs only if ac_uid still exists, so re-applying on a
-- partially/fully migrated DB is a no-op.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_events' AND column_name = 'ac_uid'
  ) THEN
    ALTER TABLE test_events RENAME COLUMN ac_uid TO subject_ref;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_event_latest' AND column_name = 'ac_uid'
  ) THEN
    ALTER TABLE test_event_latest RENAME COLUMN ac_uid TO subject_ref;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ac_first_verified' AND column_name = 'ac_uid'
  ) THEN
    ALTER TABLE ac_first_verified RENAME COLUMN ac_uid TO subject_ref;
  END IF;
END $$;
