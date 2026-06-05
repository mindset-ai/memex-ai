ALTER TABLE "decisions" ADD COLUMN "context" text;
ALTER TABLE "work_items" ADD COLUMN "acceptance_criteria" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE "work_items" ADD COLUMN "section_ref" text;
