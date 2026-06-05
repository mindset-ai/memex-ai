-- GitHub-style personal workspaces. Every user gets a personal account on signup; additional
-- team accounts are created explicitly. Personal accounts resolve via users.personal_account_id
-- (not subdomain) and live at the root URL; team accounts continue to resolve by subdomain.
--
-- No data backfill is required: this change lands before real users exist. Dev databases
-- that already have accounts will have them marked as 'team' (the default) — run `rake db:nuke`
-- if you want a clean slate with a personal workspace on first login.

-- accounts.kind: discriminator between personal and team workspaces.
ALTER TABLE "accounts" ADD COLUMN "kind" text NOT NULL DEFAULT 'team';
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_kind_valid" CHECK ("kind" IN ('personal', 'team'));
--> statement-breakpoint

-- users.personal_account_id: FK to the user's one-and-only personal account. Nullable because
-- the user row is inserted before the account row (we update it immediately after). Unique so
-- a user can never own two personal accounts. ON DELETE SET NULL because users.id cascades
-- into account_memberships already — if the account is dropped, the user row stays.
ALTER TABLE "users" ADD COLUMN "personal_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_personal_account_id_accounts_id_fk"
  FOREIGN KEY ("personal_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_personal_account_id_unique" UNIQUE ("personal_account_id");
