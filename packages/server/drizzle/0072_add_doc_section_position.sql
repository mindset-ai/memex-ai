-- spec-150 t-4 (dec-2): split a section's DISPLAY order from its IDENTITY.
--
-- Until now `doc_sections.seq` did double duty: it backed the `s-N` ref (identity)
-- AND it was resequenced on delete/insert to keep the rendered document numbered
-- 1, 2, 3 (display order). Conflating the two made refs fragile: deleting a section
-- renumbered the tail, so `s-3` could silently come to mean a different section.
--
-- Fix (dec-2): `seq` BECOMES the stable, allocate-once identity and is never
-- resequenced again — so every existing `s-N` URL keeps resolving forever, and the
-- ref-construction sites + resolver stay untouched (they already read `seq`). The
-- DISPLAY order moves to a new `position` column, backfilled to `seq` so the two
-- start identical and diverge afterwards (resequenced on delete, reorderable later).
--
-- Additive and reversible: ADD COLUMN + a backfill UPDATE; rollback is DROP COLUMN.
-- spec-107's resequencing logic moves from `seq` to `position` in the same change
-- set (services/sections.ts); the rendered numbering is unaffected.

ALTER TABLE doc_sections ADD COLUMN position INTEGER;

-- Start position identical to the current seq for every existing section, so the
-- rendered order is unchanged on day one.
UPDATE doc_sections SET position = seq WHERE position IS NULL;

ALTER TABLE doc_sections ALTER COLUMN position SET NOT NULL;
