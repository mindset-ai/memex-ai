-- Revert for 0132_spec522_decisions_issues_content_tsv.sql (spec-522 t-1).
--
-- Drops the materialised FTS columns and their GIN indexes from `decisions` and
-- `issues`. Safe and lossless in the data sense: `content_tsv` is a GENERATED
-- column derived entirely from `title`/`context`/`resolution` (decisions) and
-- `title`/`body` (issues), so nothing is stored here that cannot be recomputed
-- from columns that remain.
--
-- WHAT REVERTING COSTS. It restores the sequential scan this migration removed —
-- the decisions FTS arm goes back to ~390 ms per ⌘K search, measured (spec-522
-- s-2). The application code in services/memex-search/retrieval.ts must be
-- reverted in the SAME change, because after this file runs the arms would
-- reference a column that no longer exists and every decision/issue FTS query
-- would error. Code first, or code and schema together — never schema alone.
--
-- DROP COLUMN on a generated column is a catalogue-only operation (no rewrite),
-- and dropping the column drops its dependent index automatically; the explicit
-- DROP INDEX statements are belt-and-braces for the case where a column drop was
-- already applied by hand.

DROP INDEX IF EXISTS "decisions_content_tsv_idx";
ALTER TABLE "decisions" DROP COLUMN IF EXISTS "content_tsv";

DROP INDEX IF EXISTS "issues_content_tsv_idx";
ALTER TABLE "issues" DROP COLUMN IF EXISTS "content_tsv";
