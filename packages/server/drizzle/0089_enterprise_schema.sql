-- spec-171 t-2: enterprise schema — trial state, Stripe, LLM keys, self-hosted licenses.
--
-- Adds trial/billing columns to orgs and creates four new tables needed by the
-- enterprise purchase & trial flow before any route or service code can land.

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

-- ── 2. org_llm_keys ──────────────────────────────────────────────────────────
-- Encrypted LLM API keys per org per provider. Self-hosted Enterprise requires
-- these; hosted Enterprise may optionally provide them (per dec-32, no discount).
-- encrypted_key is AES-256-GCM via ENCRYPTION_KEY env var (per std-9).
CREATE TABLE "org_llm_keys" (
  "id"            uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"        uuid        NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "provider"      text        NOT NULL,
  "encrypted_key" text        NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "org_llm_keys_provider_valid"
    CHECK ("provider" IN ('openai', 'anthropic')),
  CONSTRAINT "org_llm_keys_org_id_provider_unique"
    UNIQUE ("org_id", "provider")
);
--> statement-breakpoint
CREATE INDEX "org_llm_keys_org_id_idx" ON "org_llm_keys" ("org_id");

--> statement-breakpoint

-- ── 3. self_hosted_licenses ───────────────────────────────────────────────────
-- JWT license keys for self-hosted deployments. org_id nullable — trial keys are
-- issued before a commercial org relationship exists (dec-31).
CREATE TABLE "self_hosted_licenses" (
  "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"           uuid        REFERENCES "orgs"("id") ON DELETE SET NULL,
  "license_key"      text        NOT NULL,
  "seats_purchased"  integer     NOT NULL,
  "valid_until"      timestamptz NOT NULL,
  "tier"             text        NOT NULL,
  "issued_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "self_hosted_licenses_license_key_unique"
    UNIQUE ("license_key"),
  CONSTRAINT "self_hosted_licenses_tier_valid"
    CHECK ("tier" IN ('trial', 'commercial'))
);
--> statement-breakpoint
CREATE INDEX "self_hosted_licenses_org_id_idx" ON "self_hosted_licenses" ("org_id");

--> statement-breakpoint

-- ── 4. license_checkins ───────────────────────────────────────────────────────
-- Daily phone-home from self-hosted instances. Composite index DESC on
-- checked_in_at for fast "latest checkin per license" queries (dec-23).
CREATE TABLE "license_checkins" (
  "id"                   uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "license_id"           uuid        NOT NULL REFERENCES "self_hosted_licenses"("id") ON DELETE CASCADE,
  "reported_seat_count"  integer     NOT NULL,
  "instance_fingerprint" text        NOT NULL,
  "checked_in_at"        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "license_checkins_license_id_checked_in_at_idx"
  ON "license_checkins" ("license_id", "checked_in_at" DESC);

--> statement-breakpoint

-- ── 5. stripe_events ──────────────────────────────────────────────────────────
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
