-- Rename docType 'strategy' → 'mission' (t-1, dec-2 of doc-6).
--
-- Background: the user-facing noun "Strategy" is being renamed to "Mission" as a
-- coordinated product rename. The internal docType enum value follows. The table
-- itself, the doc-N handle scheme, /api/docs/* URLs, and every other internal
-- "doc"/"document" identifier all stay generic per the doc-6 plan — only the
-- single docType value migrates.
--
-- Per dec-2, only 'strategy' migrates. Other doc_type values
-- ('blueprint', 'spec', 'document', 'adr', 'runbook', 'execution_plan', etc.)
-- are unchanged.
--
-- Schema shape: doc_type is a free-text column with no Postgres enum and no
-- CHECK constraint, so this migration is a pure data update — no type alter,
-- no constraint rebuild, no enum-value drop to deal with. The Drizzle schema
-- likewise has no zod literal union on docType, so no schema.ts diff is needed.

UPDATE "documents" SET "doc_type" = 'mission' WHERE "doc_type" = 'strategy';
