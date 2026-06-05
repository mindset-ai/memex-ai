-- Revert spec-106 t-1: drop the nullable doc_sections.description column.
--
-- Additive forward migration → trivial reverse. No data preservation needed:
-- description is metadata with no downstream dependency, so dropping it returns
-- doc_sections to its pre-spec-106 shape.

ALTER TABLE doc_sections
  DROP COLUMN IF EXISTS description;
