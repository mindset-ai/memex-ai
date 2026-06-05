-- Add support for comments on decisions and tasks (previously sections only)
-- Safe for production: purely additive, all existing rows satisfy the CHECK constraint

ALTER TABLE "doc_comments" ADD COLUMN "decision_id" uuid;
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD COLUMN "task_id" uuid;
--> statement-breakpoint
ALTER TABLE "doc_comments" ALTER COLUMN "section_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_decision_id_decisions_id_fk"
  FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_task_id_tasks_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_exactly_one_target"
  CHECK (
    (CASE WHEN section_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN decision_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN task_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  );
