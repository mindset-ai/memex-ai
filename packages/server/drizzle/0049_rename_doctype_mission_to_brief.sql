-- doc-26 t-12 (Mission → Brief, part 2): rewrite documents.doc_type
-- 'mission' → 'brief'. Eager rename per dec-9 of doc-26 — no read-time
-- translation. Source code in t-13 follows: every `docType: 'mission'`
-- check / filter / insert flips to `'brief'`.
--
-- No CHECK constraint on doc_type to update; allowed values are policed by
-- the application layer.

UPDATE "documents" SET "doc_type" = 'brief' WHERE "doc_type" = 'mission';
