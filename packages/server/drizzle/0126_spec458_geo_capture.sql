-- spec-458 (dec-9): coarse geo capture for the public /live world map.
-- Hand-written migration (journal frozen at 0008; applied by apply-hand-migrations.mjs).
--
-- Adds nullable geo_lat/geo_lng to the TWO RLS-EXCLUDED activity stores the /live
-- global aggregate reads:
--   * mcp_sessions  — agents; stamped at /mcp ingress from the GCLB geo header.
--   * usage_events  — humans; stamped at telemetry ingress from the same header.
-- Values are rounded to 1 decimal degree (~11km) in services/geo.ts BEFORE the
-- write — precise coordinates never reach storage (ac-3/ac-15). No IP columns are
-- added or touched. Nullable adds only — backward-compatible (spec-417 gates); no
-- backfill (history has no location, honestly).
--
-- NOTE (deviation from the original t-2 wording): presence was named as the
-- human-side geo home, but presence is RLS-SCOPED (spec-440) so the cross-tenant
-- /live read could never see it. usage_events is the RLS-excluded human-activity
-- store the aggregate already reads — the geo lives where the reader can look.
ALTER TABLE mcp_sessions ADD COLUMN IF NOT EXISTS geo_lat double precision;
--> statement-breakpoint
ALTER TABLE mcp_sessions ADD COLUMN IF NOT EXISTS geo_lng double precision;
--> statement-breakpoint
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS geo_lat double precision;
--> statement-breakpoint
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS geo_lng double precision;
