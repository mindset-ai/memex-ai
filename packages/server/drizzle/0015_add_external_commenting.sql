-- External commenting and viral attribution (t-11).
--   * doc_comments gains author_user_id + author_account_id columns. These attribute the
--     commenter; `account_id` stays pinned to the doc's account (for scoping). External
--     is computed at render time as `author_account_id != account_id`.
--   * accounts gains referral_share_token_id. Tracks viral attribution: which share link
--     led to this account's creation.
-- Existing rows stay with NULL author fields (pre-t-11 comments used only author_name).

ALTER TABLE "doc_comments" ADD COLUMN "author_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_author_user_id_users_id_fk"
  FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "doc_comments" ADD COLUMN "author_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_author_account_id_accounts_id_fk"
  FOREIGN KEY ("author_account_id") REFERENCES "public"."accounts"("id") ON DELETE SET NULL ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "accounts" ADD COLUMN "referral_share_token_id" uuid;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_referral_share_token_id_share_tokens_id_fk"
  FOREIGN KEY ("referral_share_token_id") REFERENCES "public"."share_tokens"("id") ON DELETE SET NULL ON UPDATE no action;
