-- Account scoping for resource tables (t-9). Three-phase migration:
--   1. Ensure at least one account exists (create Legacy account if none)
--   2. Add nullable account_id columns and backfill
--   3. SET NOT NULL + add FK constraints + indexes
--
-- Cleanup: drop existing rows in conversations + messages because they're keyed by Google
-- `sub` IDs (legacy authMiddleware) and won't match the new Memex User UUIDs going forward.
-- These are dev-only test data; production hasn't shipped the agent flow yet at this point.

-- ── Step 1: Ensure a fallback account exists for backfill ──
INSERT INTO accounts (name, subdomain)
SELECT 'Legacy', 'legacy'
WHERE NOT EXISTS (SELECT 1 FROM accounts);
--> statement-breakpoint

-- ── Step 2: Add nullable columns ──
ALTER TABLE "documents" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD COLUMN "account_id" uuid;
--> statement-breakpoint

-- ── Step 3: Backfill ──
-- Documents → oldest account (deterministic; one tenant in dev/int)
UPDATE "documents" SET "account_id" = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
WHERE "account_id" IS NULL;
--> statement-breakpoint

-- Tasks/decisions/comments → inherit from parent document
UPDATE "tasks" SET "account_id" = d.account_id
FROM "documents" d WHERE "tasks".doc_id = d.id;
--> statement-breakpoint
UPDATE "decisions" SET "account_id" = d.account_id
FROM "documents" d WHERE "decisions".doc_id = d.id;
--> statement-breakpoint

-- doc_comments use a per-row CASE: target may be section/decision/task; chain back to doc
UPDATE "doc_comments" SET "account_id" = subq.account_id
FROM (
  SELECT c.id AS comment_id, COALESCE(d_via_section.account_id, d_via_decision.account_id, d_via_task.account_id) AS account_id
  FROM doc_comments c
  LEFT JOIN doc_sections s ON c.section_id = s.id
  LEFT JOIN documents d_via_section ON s.doc_id = d_via_section.id
  LEFT JOIN decisions dec ON c.decision_id = dec.id
  LEFT JOIN documents d_via_decision ON dec.doc_id = d_via_decision.id
  LEFT JOIN tasks t ON c.task_id = t.id
  LEFT JOIN documents d_via_task ON t.doc_id = d_via_task.id
) AS subq
WHERE "doc_comments".id = subq.comment_id;
--> statement-breakpoint

-- ── Step 4: Clear conversations + messages (legacy Google-sub user_ids) ──
DELETE FROM "messages";
--> statement-breakpoint
DELETE FROM "conversations";
--> statement-breakpoint

-- ── Step 5: NOT NULL + FK + index ──
ALTER TABLE "documents" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "decisions" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "doc_comments" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "documents" ADD CONSTRAINT "documents_account_id_accounts_id_fk"
  FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_account_id_accounts_id_fk"
  FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_account_id_accounts_id_fk"
  FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_account_id_accounts_id_fk"
  FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "documents_account_id_idx" ON "documents" ("account_id");
--> statement-breakpoint
CREATE INDEX "tasks_account_id_idx" ON "tasks" ("account_id");
--> statement-breakpoint
CREATE INDEX "decisions_account_id_idx" ON "decisions" ("account_id");
--> statement-breakpoint
CREATE INDEX "doc_comments_account_id_idx" ON "doc_comments" ("account_id");
--> statement-breakpoint

-- ── Step 6: Convert documents.handle from globally unique to per-account unique ──
-- Each tenant should be able to have its own doc-1, doc-2, etc.
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_handle_unique";
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_account_id_handle_unique" UNIQUE ("account_id", "handle");
