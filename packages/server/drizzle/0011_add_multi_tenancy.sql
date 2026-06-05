-- Multi-tenancy foundation: accounts, users, memberships, invites, share links, verified domains.
-- Establishes the data model for subdomain-routed accounts with multi-account user membership.
-- Existing tables (documents, etc.) are NOT modified here — account scoping is a separate task (t-9).
-- Reversibility: drop in reverse order. share_tokens → verified_domains → invite_tokens →
--   account_memberships → users → accounts (no other tables depend on these).

CREATE TABLE "accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "subdomain" text NOT NULL,
  "email_domains" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "auto_grouping_enabled" boolean NOT NULL DEFAULT false,
  "domain_verified" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "accounts_subdomain_unique" UNIQUE ("subdomain"),
  -- 3-63 chars, lowercase alphanumeric + hyphens, cannot start or end with a hyphen
  CONSTRAINT "accounts_subdomain_format" CHECK ("subdomain" ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$')
);
--> statement-breakpoint

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "users_email_unique" UNIQUE ("email"),
  CONSTRAINT "users_status_valid" CHECK ("status" IN ('active', 'disabled'))
);
--> statement-breakpoint

CREATE TABLE "account_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "role" text NOT NULL,
  "joined_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "account_memberships_user_account_unique" UNIQUE ("user_id", "account_id"),
  CONSTRAINT "account_memberships_role_valid" CHECK ("role" IN ('user', 'administrator')),
  CONSTRAINT "account_memberships_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "account_memberships_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "account_memberships_user_id_idx" ON "account_memberships" ("user_id");
--> statement-breakpoint
CREATE INDEX "account_memberships_account_id_idx" ON "account_memberships" ("account_id");
--> statement-breakpoint

CREATE TABLE "invite_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "token" text NOT NULL,
  "used" boolean NOT NULL DEFAULT false,
  -- Token is invalid after first use OR expires_at, whichever comes first (dec-2)
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "invite_tokens_token_unique" UNIQUE ("token"),
  CONSTRAINT "invite_tokens_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

CREATE TABLE "share_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" uuid NOT NULL,
  "token" text NOT NULL,
  "revoked" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "share_tokens_token_unique" UNIQUE ("token"),
  CONSTRAINT "share_tokens_document_id_documents_id_fk"
    FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

CREATE TABLE "verified_domains" (
  -- Domain is the natural primary key — only one account can claim a given domain (dec-5)
  "domain" text PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "verification_method" text NOT NULL,
  "verified_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "verified_domains_method_valid" CHECK ("verification_method" IN ('sso', 'email')),
  CONSTRAINT "verified_domains_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action
);
