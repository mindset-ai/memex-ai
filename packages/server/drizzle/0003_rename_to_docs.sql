-- Rename tables: strategies -> documents, strategy_sections -> doc_sections, strategy_comments -> doc_comments
ALTER TABLE "strategies" RENAME TO "documents";
ALTER TABLE "strategy_sections" RENAME TO "doc_sections";
ALTER TABLE "strategy_comments" RENAME TO "doc_comments";

-- Rename foreign key columns
ALTER TABLE "doc_sections" RENAME COLUMN "strategy_id" TO "doc_id";

-- Add doc_type column with default 'strategy' for existing rows
ALTER TABLE "documents" ADD COLUMN "doc_type" text NOT NULL DEFAULT 'strategy';

-- Rename constraints to match new table names
ALTER TABLE "documents" RENAME CONSTRAINT "strategies_pkey" TO "documents_pkey";
ALTER TABLE "documents" RENAME CONSTRAINT "strategies_handle_unique" TO "documents_handle_unique";
ALTER TABLE "doc_sections" RENAME CONSTRAINT "strategy_sections_pkey" TO "doc_sections_pkey";
ALTER TABLE "doc_sections" RENAME CONSTRAINT "strategy_sections_strategy_id_seq_unique" TO "doc_sections_doc_id_seq_unique";
ALTER TABLE "doc_sections" RENAME CONSTRAINT "strategy_sections_strategy_id_section_type_unique" TO "doc_sections_doc_id_section_type_unique";
ALTER TABLE "doc_sections" RENAME CONSTRAINT "strategy_sections_strategy_id_strategies_id_fk" TO "doc_sections_doc_id_documents_id_fk";
ALTER TABLE "doc_comments" RENAME CONSTRAINT "strategy_comments_pkey" TO "doc_comments_pkey";
ALTER TABLE "doc_comments" RENAME CONSTRAINT "strategy_comments_section_id_strategy_sections_id_fk" TO "doc_comments_section_id_doc_sections_id_fk";
