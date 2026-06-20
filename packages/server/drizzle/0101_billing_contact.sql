-- spec-171 t-1: billing contact designation.
--
-- Adds billing_contact_email and billing_contact_name to orgs so payment-related
-- emails route to a designated contact rather than always the org creator / admin.
-- Both nullable — null means "use org creator / all admins" (pre-existing behaviour).

ALTER TABLE "orgs" ADD COLUMN "billing_contact_name" text;
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "billing_contact_email" text;
