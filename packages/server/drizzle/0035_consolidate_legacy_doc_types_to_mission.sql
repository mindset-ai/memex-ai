-- Consolidate every legacy doc_type into 'mission'.
--
-- Background: int still carries pre-rename rows with doc_type values that fell
-- out of the active enum during the strategy → mission and blueprint → standard
-- renames (whitepaper, spec, plan, rfc, etc.). The active enum is
-- ('mission', 'standard', 'document', 'execution_plan'); anything else is
-- legacy and should be folded into 'mission' so the UI / agent / MCP tools
-- only ever see live types.
--
-- Why "NOT IN (active enum)" instead of an explicit allowlist of legacy types:
--   forward-only and idempotent. Any future legacy stragglers get caught on
--   the next deploy without another migration. doc_type has no Postgres enum
--   or CHECK constraint, so this is a pure data UPDATE.
--
-- 'standard' is preserved deliberately — standards are a distinct active type
-- with their own handle scheme (std-N) and search/embeddings stack.
-- 'execution_plan' is also preserved (per dec-6 of doc-8 they're real
-- documents). 'document' is the generic free-text type.
--
-- Note: 0028_rename_strategy_to_mission already handles the strategy rows;
-- this migration is a no-op for them on environments where 0028 has run, and
-- a backstop on any environment where strategy rows somehow re-appear.

UPDATE "documents"
   SET "doc_type" = 'mission'
 WHERE "doc_type" NOT IN ('mission', 'standard', 'document', 'execution_plan');
