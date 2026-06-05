-- Pending email-verification tokens for domain claims (t-6).
-- Created when an admin initiates verification; consumed when the recipient clicks the link.
-- Distinct from invite_tokens (which are user-seat invitations).

CREATE TABLE "domain_verification_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "domain" text NOT NULL,
  "token" text NOT NULL,
  "used" boolean NOT NULL DEFAULT false,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "domain_verification_tokens_token_unique" UNIQUE ("token"),
  CONSTRAINT "domain_verification_tokens_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action
);
