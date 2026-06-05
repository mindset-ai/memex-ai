-- Data-integrity constraints missed in 0019.
--
--   * repos: UNIQUE (account_id, name) — two repos per account shouldn't
--     share a business name even if the URLs differ.
--   * calls.resolution_kind: CHECK the value is one of the four known kinds.
--     Silent insert of typos / new kinds is an integrity hazard when the
--     agent queries downstream.
--   * files.language and symbols.language: CHECK the value is a known
--     registered language. Adding a language means updating this constraint
--     AND registering an extractor — keeps them in lockstep.

ALTER TABLE "repos" ADD CONSTRAINT "repos_account_id_name_unique" UNIQUE ("account_id", "name");
--> statement-breakpoint

ALTER TABLE "calls" ADD CONSTRAINT "calls_resolution_kind_valid"
  CHECK ("resolution_kind" IS NULL OR "resolution_kind" IN ('local', 'cross_module', 'inheritance', 'external'));
--> statement-breakpoint

ALTER TABLE "files" ADD CONSTRAINT "files_language_valid"
  CHECK ("language" IS NULL OR "language" IN ('python', 'typescript', 'javascript', 'go', 'rust', 'dart'));
--> statement-breakpoint

ALTER TABLE "symbols" ADD CONSTRAINT "symbols_language_valid"
  CHECK ("language" IS NULL OR "language" IN ('python', 'typescript', 'javascript', 'go', 'rust', 'dart'));
