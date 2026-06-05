-- Per-account membership status (t-8).
-- Distinct from users.status (which is a global SSO-level lockout). Disabled memberships
-- keep their row so past contributions stay attributed to the user.

ALTER TABLE "account_memberships" ADD COLUMN "status" text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "account_memberships" ADD CONSTRAINT "account_memberships_status_valid"
  CHECK ("status" IN ('active', 'disabled'));
