-- Make document status a first-class concept.
--   * Drop publishedAt. The "publish" flow is retired; `status` is now the single
--     source of truth for document lifecycle.
--   * Add status_changed_at. Stamped every time updateDocStatus runs so we can see
--     when a doc last transitioned.
--   * Reset every existing document to 'draft'. Historical statuses (including the
--     legacy "active") are discarded per product decision — clean slate on the new
--     four-state model (draft / review / implementation / done).
--   * Add a check constraint so the DB rejects any status outside the four values.

ALTER TABLE "documents" ADD COLUMN "status_changed_at" timestamptz;
--> statement-breakpoint
UPDATE "documents" SET "status" = 'draft', "status_changed_at" = now();
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "status_changed_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "status_changed_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "published_at";
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_status_valid"
  CHECK ("status" IN ('draft', 'review', 'implementation', 'done'));
