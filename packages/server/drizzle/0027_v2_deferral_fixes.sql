-- v2 deferral fixes (t-20) — second coordinated schema migration that closes the
-- three permanent schema deferrals from the v2-graph audit on doc-10:
--   B  documents.status CHECK gains 'approved' (separate from 'done')
--   C  decisions.source NOT NULL DEFAULT 'human' + CHECK source IN ('human','agent')
--   D  doc_sections.content_tsv generated tsvector + GIN index
--
-- This is the SECOND v2 migration window. The user authorised it because nothing
-- has shipped to int/prod yet — every v2 migration is still local-only, so
-- consolidating now costs the same as the first one (per the t-1 / dec-7 spirit
-- of "one minimal schema pass" — the v2 effort got two passes total, not many).
-- Per the t-1 hard constraint, no third migration follows.

-- ── B. documents.status: add 'approved' value ─────────────────────────────
-- Drop and recreate the CHECK so the new value is allowed. Existing rows are
-- unaffected ('approved' wasn't possible before so nothing back-fills).
-- The t-17 ExecutionPlanModal "Approve" flow flipped plan docs to 'done' as a
-- substitute; it's now updated to set 'approved' so plan-approved is
-- distinguishable from generic strategy-done.

ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_status_valid";
--> statement-breakpoint

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_status_valid"
  CHECK ("status" IN ('draft', 'review', 'implementation', 'done', 'approved'));
--> statement-breakpoint

-- ── C. decisions.source NOT NULL DEFAULT 'human' + CHECK ──────────────────
-- Backfill: NOT NULL + DEFAULT means every existing row transparently becomes
-- source='human', which is the correct interpretation of pre-v2 decisions —
-- they were all human-authored before per-turn extraction shipped (t-9 / t-12).
-- Agent-proposed candidates from `proposeDecision` going forward will write
-- source='agent' and surface that in MCP / REST output.

ALTER TABLE "decisions"
  ADD COLUMN "source" text NOT NULL DEFAULT 'human';
--> statement-breakpoint

ALTER TABLE "decisions"
  ADD CONSTRAINT "decisions_source_valid"
  CHECK ("source" IN ('human', 'agent'));
--> statement-breakpoint

-- ── D. doc_sections.content_tsv generated column + GIN index ──────────────
-- Per the t-10 / t-13 FTS pattern: scanForDecisionDrift queries blueprints'
-- doc_sections.content for `[per dec-N]` references via to_tsvector at query
-- time. Materialising the tsvector as a generated column lets us add a GIN
-- index so the FTS narrow goes from a sequential scan over every section to
-- an indexed bitmap scan.
--
-- COALESCE handles edge-case NULLs defensively even though content is declared
-- NOT NULL — matches the existing pattern on files.content_tsv (schema.ts ~677).
-- The `english` config is the same one t-10's plainto_tsquery call uses, so the
-- generated column tokens line up with the query tokens — no FTS query rewrite
-- needed beyond switching the WHERE predicate to reference the column.

ALTER TABLE "doc_sections"
  ADD COLUMN "content_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(content, ''::text))) STORED;
--> statement-breakpoint

CREATE INDEX "doc_sections_content_tsv_idx"
  ON "doc_sections" USING gin ("content_tsv");
