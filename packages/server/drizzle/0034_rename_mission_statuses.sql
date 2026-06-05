-- Rename Mission lifecycle: review→plan, implementation→build, plus new verify state.
--
-- Per dec-3 of doc-10 the rename applies to docType='mission' rows only. Standards,
-- Documents, and Execution plans keep their existing values (Execution plan still
-- uses 'approved' as its terminal). The CHECK therefore becomes the union of old +
-- new values and stays as the union — no follow-up migration to shrink it. Per
-- dec-1 this is a single forward-only deploy; the React UI ships in the same
-- release so the kanban + dropdown speak the new vocabulary as the rows flip.
--
-- Mapping for Mission rows:
--   review         → plan
--   implementation → build
--   draft / done   — unchanged
--   verify         — no historical equivalent, no rows backfilled
--
-- Rollback (only if regression): inverse UPDATEs (plan→review, build→implementation,
-- verify→done or build per stakeholder call); leave the CHECK as the union.

ALTER TABLE "documents" DROP CONSTRAINT "documents_status_valid";

ALTER TABLE "documents" ADD CONSTRAINT "documents_status_valid"
  CHECK (status IN ('draft', 'review', 'implementation', 'done', 'approved', 'plan', 'build', 'verify'));

UPDATE "documents" SET status = 'plan'  WHERE doc_type = 'mission' AND status = 'review';
UPDATE "documents" SET status = 'build' WHERE doc_type = 'mission' AND status = 'implementation';
