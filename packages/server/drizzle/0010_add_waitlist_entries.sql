-- Waitlist signups captured from the public memex.ai marketing site.
-- Standalone table, no FKs. Email is unique to prevent duplicate signups.

CREATE TABLE "waitlist_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "company" text NOT NULL,
  "email" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "waitlist_entries_email_unique" UNIQUE ("email")
);
