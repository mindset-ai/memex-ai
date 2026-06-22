-- spec-171 t-2: enterprise schema — trial state + Stripe (hosted-only).
--
-- Adds trial/billing columns to orgs and the stripe_events idempotency log needed
-- by the hosted enterprise purchase & trial flow before any route or service code
-- can land. Self-hosted tables (org_llm_keys, self_hosted_licenses,
-- license_checkins) are deferred to spec-323.

-- ── 1. orgs: trial state + Stripe customer ──────────────────────────────────
ALTER TABLE "orgs" ADD COLUMN "trial_started_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "trial_status" text;
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "trial_converted_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "stripe_customer_id" text;
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "trial_emails_sent" jsonb NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_trial_status_valid"
  CHECK ("trial_status" IN ('active', 'expired'));
--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_stripe_customer_id_unique"
  UNIQUE ("stripe_customer_id");

--> statement-breakpoint

-- ── 2. stripe_events ──────────────────────────────────────────────────────────
-- Idempotency log for Stripe webhook handlers. Unique on event_id prevents
-- double-processing on webhook retries (dec-8 / std-9 webhook pattern).
CREATE TABLE "stripe_events" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id"     text        NOT NULL,
  "event_type"   text        NOT NULL,
  "processed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stripe_events_event_id_unique"
    UNIQUE ("event_id")
);
