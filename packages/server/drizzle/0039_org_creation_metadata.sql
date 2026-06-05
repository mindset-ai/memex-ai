-- t-14 of doc-15: org creation flow metadata.
--
-- Three additions to support the org/namespace lifecycle rules from std-3:
--   1. orgs.created_by_user_id  — who created this org. Powers the
--      "≤5 org creations per user per 24h" rate limit (per std-3 / dec-8).
--   2. namespaces.slug_changed_at  — last time this namespace's slug was
--      renamed. Enforces the 30-day rename cooldown (per std-3 / dec-7).
--   3. namespace_slug_reservations — post-rename slug protection. When a
--      namespace renames `acme` → `acme-co`, `acme` lives in this table for
--      30 days so a squatter can't grab it and impersonate.
--
-- Single transaction; pre-launch internal-only data.

ALTER TABLE "orgs" ADD COLUMN "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "orgs_created_by_user_id_idx" ON "orgs" ("created_by_user_id");
--> statement-breakpoint

ALTER TABLE "namespaces" ADD COLUMN "slug_changed_at" timestamp with time zone;
--> statement-breakpoint

CREATE TABLE "namespace_slug_reservations" (
  -- The slug being held in reserve.
  "slug" text PRIMARY KEY,
  -- The namespace that previously owned this slug. Nullable in case the
  -- namespace itself is deleted before the reservation expires (we still
  -- want to keep squatters out for the 30-day window).
  "released_namespace_id" uuid REFERENCES "namespaces"("id") ON DELETE SET NULL,
  -- After this timestamp, the reservation expires and the slug is free again.
  "reserved_until" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- Same format rules as namespaces.slug — keep them in sync if std-3 changes.
  CONSTRAINT "namespace_slug_reservations_slug_format"
    CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,38}$')
);
--> statement-breakpoint
CREATE INDEX "namespace_slug_reservations_reserved_until_idx"
  ON "namespace_slug_reservations" ("reserved_until");
