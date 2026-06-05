-- Adds deployment-preference segmentation to waitlist signups.
-- Values: 'cloud' | 'self_hosted' | 'any'. Existing rows backfill to 'any'.

ALTER TABLE "waitlist_entries"
  ADD COLUMN "deployment" text NOT NULL DEFAULT 'any';
