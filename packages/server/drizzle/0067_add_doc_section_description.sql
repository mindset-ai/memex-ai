-- spec-106 t-1: add a nullable `description` column to doc_sections.
--
-- Section metadata (the existing free-text `section_type` plus this new
-- `description`) travels everywhere section data does — readable in
-- get_doc/list_docs/section responses and writable via update_section
-- (ac-9: section_type writable; ac-10: new description column).
--
-- Additive + reversible: a single nullable text column with no backfill. Every
-- existing row gets NULL, which is the correct "no description" sentinel. The
-- revert (drizzle/reverts/) simply drops the column.
--
-- Idempotent (IF NOT EXISTS): some environments may already carry this column
-- from an earlier touch not recorded in `manual_migrations`, so the step is
-- guarded to let the hand-migration runner re-apply cleanly.

ALTER TABLE doc_sections
  ADD COLUMN IF NOT EXISTS description text;
