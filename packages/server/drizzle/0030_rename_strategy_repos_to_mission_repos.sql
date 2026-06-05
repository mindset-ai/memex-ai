-- Rename strategy_repos → mission_repos to align with the Strategy → Mission
-- product rename (follow-up to 0028/0029). The table maps a Mission document
-- (docType='mission' — was 'strategy' before 0028) to the repos it involves,
-- as the entry point for codebase-intelligence MCP tools.
--
-- Idempotent: each step uses IF EXISTS / IF NOT EXISTS so replays are safe.
--
-- Steps:
--   1. Rename the table.
--   2. Rename the column.
--   3. Rename the primary-key and FK constraints to match the new names so
--      pg_dump output stays clean. The renames are cosmetic — leaving the
--      old names would still function — but we follow the 0007 precedent
--      (rename_work_items_to_tasks) for consistency.

ALTER TABLE IF EXISTS "strategy_repos" RENAME TO "mission_repos";

ALTER TABLE IF EXISTS "mission_repos" RENAME COLUMN "strategy_id" TO "mission_id";

ALTER TABLE IF EXISTS "mission_repos"
  RENAME CONSTRAINT "strategy_repos_pkey" TO "mission_repos_pkey";

ALTER TABLE IF EXISTS "mission_repos"
  RENAME CONSTRAINT "strategy_repos_strategy_id_fkey" TO "mission_repos_mission_id_fkey";

ALTER TABLE IF EXISTS "mission_repos"
  RENAME CONSTRAINT "strategy_repos_repo_id_fkey" TO "mission_repos_repo_id_fkey";
