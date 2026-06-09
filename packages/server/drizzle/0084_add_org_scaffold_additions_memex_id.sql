-- spec-193 t-5 (dec-6 grain / ac-19): add an optional per-memex scope to
-- org_scaffold_additions.
--
-- Today the overlay is keyed per-Org only (org_id → orgs, one namespace holds
-- many memexes), so an addition authored under a namespace reaches EVERY memex
-- in it. This adds memex_id: NULL = account-wide (existing behaviour, preserved
-- for every existing row — the default for security / house-style blocks); a
-- memex UUID = scoped to that one memex (the override). Query-time resolution
-- merges account-wide ∪ this-memex. Rationale: you can aggregate account-wide
-- items up, you cannot disaggregate a shared list back down per memex.
--
-- Additive + reversible: a single NULLABLE uuid FK with ON DELETE CASCADE (so
-- deleting a memex drops its scoped overrides; account-wide rows are untouched)
-- plus a covering index for the merge read. Every existing row gets NULL, which
-- is exactly "account-wide" — behaviour is unchanged until a row is scoped.
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner wraps each file in a
-- transaction and tracks it in manual_migrations; the guard lets a retry
-- re-apply cleanly if a prior run committed the DDL but not the tracking row.

ALTER TABLE org_scaffold_additions
  ADD COLUMN IF NOT EXISTS memex_id uuid REFERENCES memexes(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS org_scaffold_additions_org_id_memex_id_idx
  ON org_scaffold_additions (org_id, memex_id);
