-- spec-171 t-7: subscription tier columns on orgs.
--
-- Adds three columns to track the active Stripe subscription and purchased seat
-- count so the tier query endpoint can respond without a Stripe API call on every
-- request. plan_tier is kept in sync by the stripe-webhook handler on
-- invoice.payment_succeeded and customer.subscription.deleted events.

ALTER TABLE "orgs" ADD COLUMN "stripe_subscription_id" text;
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "plan_tier" text;
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "seats_purchased" integer;
--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_plan_tier_valid"
  CHECK ("plan_tier" IN ('premium', 'enterprise', 'self-hosted-enterprise'));
