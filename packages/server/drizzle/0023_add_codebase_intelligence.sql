-- Codebase Intelligence: deterministic distillation of customer repos into
-- structured Postgres tables. Written by the @memex/extractor worker, read
-- by agent-facing MCP tools and the admin UI.
--
-- Fifteen new tables plus a bridge (decision_file_coverage) into the existing
-- decisions table. Top-level entity is `repos`, which carries account_id per
-- the t-9 denormalisation pattern. Everything else cascades from repos.
--
-- Also enables the pgvector extension for the embeddings table (1536-dim
-- vectors matching OpenAI text-embedding-3-small).

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint

-- ── repos: top-level entity, account-scoped ──
CREATE TABLE "repos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "default_branch" text NOT NULL DEFAULT 'main',
  "last_synced_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "repos_account_id_url_unique" UNIQUE ("account_id", "url")
);
--> statement-breakpoint
CREATE INDEX "repos_account_id_idx" ON "repos" ("account_id");
--> statement-breakpoint

-- ── repo_scope: which folders are in scope for ingestion ──
CREATE TABLE "repo_scope" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "include_path" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "repo_scope_repo_id_idx" ON "repo_scope" ("repo_id");
--> statement-breakpoint

-- ── files: one row per source file, with a generated tsvector for FTS ──
CREATE TABLE "files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "language" text,
  "content" text,
  "content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE("content", ''::text))) STORED,
  "size_bytes" integer,
  "git_hash" text,
  "is_test" boolean NOT NULL DEFAULT false,
  "last_updated_at" timestamptz,
  CONSTRAINT "files_repo_id_path_unique" UNIQUE ("repo_id", "path")
);
--> statement-breakpoint
CREATE INDEX "files_repo_id_idx" ON "files" ("repo_id");
--> statement-breakpoint
CREATE INDEX "files_repo_id_language_idx" ON "files" ("repo_id", "language");
--> statement-breakpoint
CREATE INDEX "files_content_tsv_idx" ON "files" USING gin ("content_tsv");
--> statement-breakpoint

-- ── symbols: functions, classes, methods, interfaces, types, fields, constants ──
CREATE TABLE "symbols" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "parent_name" text,
  "signature" text,
  "line_start" integer,
  "line_end" integer,
  "is_exported" boolean NOT NULL DEFAULT false,
  "is_async" boolean NOT NULL DEFAULT false,
  "language" text,
  "doc_comment" text,
  CONSTRAINT "symbols_file_name_kind_line_unique" UNIQUE ("file_id", "name", "kind", "line_start"),
  CONSTRAINT "symbols_kind_valid" CHECK ("kind" IN ('function', 'class', 'method', 'interface', 'type', 'enum', 'constant', 'field'))
);
--> statement-breakpoint
CREATE INDEX "symbols_repo_id_idx" ON "symbols" ("repo_id");
--> statement-breakpoint
CREATE INDEX "symbols_file_id_idx" ON "symbols" ("file_id");
--> statement-breakpoint
CREATE INDEX "symbols_repo_id_name_idx" ON "symbols" ("repo_id", "name");
--> statement-breakpoint
CREATE INDEX "symbols_repo_id_kind_idx" ON "symbols" ("repo_id", "kind");
--> statement-breakpoint

-- ── dependencies: import graph ──
CREATE TABLE "dependencies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "from_file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
  "to_file_id" uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "to_package" text,
  "imported_symbols" text[],
  "kind" text NOT NULL,
  CONSTRAINT "dependencies_kind_valid" CHECK ("kind" IN ('internal', 'external'))
);
--> statement-breakpoint
CREATE INDEX "dependencies_repo_id_idx" ON "dependencies" ("repo_id");
--> statement-breakpoint
CREATE INDEX "dependencies_from_file_id_idx" ON "dependencies" ("from_file_id");
--> statement-breakpoint
CREATE INDEX "dependencies_to_file_id_idx" ON "dependencies" ("to_file_id");
--> statement-breakpoint

-- ── calls: call graph with noise annotation + resolution kind ──
CREATE TABLE "calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "from_symbol_id" uuid NOT NULL REFERENCES "symbols"("id") ON DELETE CASCADE,
  "to_name" text NOT NULL,
  "to_symbol_id" uuid REFERENCES "symbols"("id") ON DELETE SET NULL,
  "line_number" integer,
  "resolution_kind" text,
  "is_noise" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE INDEX "calls_from_symbol_id_idx" ON "calls" ("from_symbol_id");
--> statement-breakpoint
CREATE INDEX "calls_to_symbol_id_idx" ON "calls" ("to_symbol_id");
--> statement-breakpoint
CREATE INDEX "calls_repo_id_idx" ON "calls" ("repo_id");
--> statement-breakpoint

-- ── embeddings: pgvector, 1536-dim (OpenAI text-embedding-3-small) ──
CREATE TABLE "embeddings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "file_id" uuid REFERENCES "files"("id") ON DELETE CASCADE,
  "symbol_id" uuid REFERENCES "symbols"("id") ON DELETE CASCADE,
  "chunk_text" text NOT NULL,
  "chunk_kind" text,
  "embedding" vector(1536),
  "last_updated_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "embeddings_repo_id_idx" ON "embeddings" ("repo_id");
--> statement-breakpoint
CREATE INDEX "embeddings_file_id_idx" ON "embeddings" ("file_id");
--> statement-breakpoint

-- ── repo_endpoints: HTTP route registrations with handler linking ──
CREATE TABLE "repo_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
  "handler_symbol_id" uuid REFERENCES "symbols"("id") ON DELETE SET NULL,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "handler_name" text,
  "line_number" integer,
  "framework" text
);
--> statement-breakpoint
CREATE INDEX "repo_endpoints_repo_id_idx" ON "repo_endpoints" ("repo_id");
--> statement-breakpoint
CREATE INDEX "repo_endpoints_repo_id_path_idx" ON "repo_endpoints" ("repo_id", "path");
--> statement-breakpoint

-- ── Meta layer: structure, patterns, domains, tech stack ──
CREATE TABLE "repo_structure" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "path_pattern" text NOT NULL,
  "file_count" integer,
  "confidence" double precision,
  "detected_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "repo_structure_repo_id_idx" ON "repo_structure" ("repo_id");
--> statement-breakpoint

CREATE TABLE "repo_patterns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "pattern" text NOT NULL,
  "evidence" text[],
  "confidence" double precision,
  "detected_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "repo_patterns_repo_id_idx" ON "repo_patterns" ("repo_id");
--> statement-breakpoint

CREATE TABLE "repo_domains" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "root_paths" text[],
  "file_count" integer,
  "symbol_count" integer,
  "key_symbols" text[],
  "aliases" text[],
  "description" text,
  "detected_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "repo_domains_repo_id_idx" ON "repo_domains" ("repo_id");
--> statement-breakpoint

CREATE TABLE "repo_tech_stack" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "layer" text NOT NULL,
  "name" text NOT NULL,
  "version" text,
  "evidence" text[],
  "detected_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "repo_tech_stack_repo_id_idx" ON "repo_tech_stack" ("repo_id");
--> statement-breakpoint

-- ── test_coverage: how tests link to production symbols ──
CREATE TABLE "test_coverage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "test_symbol_id" uuid NOT NULL REFERENCES "symbols"("id") ON DELETE CASCADE,
  "subject_symbol_id" uuid REFERENCES "symbols"("id") ON DELETE CASCADE,
  "subject_file_id" uuid REFERENCES "files"("id") ON DELETE CASCADE,
  "link_method" text NOT NULL,
  "confidence" double precision,
  CONSTRAINT "test_coverage_link_method_valid" CHECK ("link_method" IN ('import', 'call_graph', 'path_mirror', 'name_match'))
);
--> statement-breakpoint
CREATE INDEX "test_coverage_repo_id_idx" ON "test_coverage" ("repo_id");
--> statement-breakpoint
CREATE INDEX "test_coverage_subject_symbol_id_idx" ON "test_coverage" ("subject_symbol_id");
--> statement-breakpoint

-- ── decision_file_coverage: the bridge ──
-- Links a Memex decision to the files it governs. This is where the two
-- halves of Memex (docs/decisions/tasks ↔ codebase intelligence) meet.
CREATE TABLE "decision_file_coverage" (
  "decision_id" uuid NOT NULL REFERENCES "decisions"("id") ON DELETE CASCADE,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
  "reason" text,
  "last_verified_at" timestamptz,
  PRIMARY KEY ("decision_id", "file_id")
);
--> statement-breakpoint

-- ── drift_signals: instances of code diverging from a decision ──
CREATE TABLE "drift_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "decision_id" uuid NOT NULL REFERENCES "decisions"("id") ON DELETE CASCADE,
  "file_id" uuid REFERENCES "files"("id") ON DELETE CASCADE,
  "symbol_id" uuid REFERENCES "symbols"("id") ON DELETE CASCADE,
  "signal" text NOT NULL,
  "severity" text,
  "resolved" boolean NOT NULL DEFAULT false,
  "detected_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "drift_signals_decision_id_idx" ON "drift_signals" ("decision_id");
--> statement-breakpoint
CREATE INDEX "drift_signals_file_id_idx" ON "drift_signals" ("file_id");
--> statement-breakpoint

-- ── strategy_repos: which repos a strategy document (doc_type='strategy') involves ──
CREATE TABLE "strategy_repos" (
  "strategy_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "is_primary" boolean NOT NULL DEFAULT true,
  PRIMARY KEY ("strategy_id", "repo_id")
);
