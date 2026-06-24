-- spec-349: cross-instance auth rate-limit store.
--
-- Auth rate-limiting (std-13 native auth) was enforced with PROCESS-LOCAL state
-- (an in-memory Map in services/auth-rate-limit.ts). Prod runs on Cloud Run with
-- up to 3 instances and no session affinity, so a "5 per 15min" cap effectively
-- became up to 15 and reset on every cold start — the brute-force / enumeration
-- guarantee was defeated across instances (parent audit spec-345, finding perf-3).
--
-- Fix: back the counter with Postgres so the window is shared across every
-- instance. Redis was deliberately rejected for the bus (spec-156) to keep the
-- zero-managed-dependency posture; we reuse the same lever here — a tiny counter
-- table, incremented with a single atomic INSERT ... ON CONFLICT DO UPDATE so
-- concurrent instances serialise on the row lock (no lost increments, no races).
--
-- The table is intentionally NOT tenant-scoped: rate-limit keys are IP / email /
-- user-id, not memex-id, so RLS is left DISABLED (the runtime role reads/writes
-- it directly). Stale rows are reaped lazily by the limiter and can be swept by
-- housekeeping; `reset_at` carries the window boundary so the count is only ever
-- read as live while now() < reset_at.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  scope text NOT NULL,
  key text NOT NULL,
  count integer NOT NULL,
  reset_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);
--> statement-breakpoint

-- Lets the lazy / scheduled reaper drop expired windows by `reset_at` without a
-- full scan.
CREATE INDEX IF NOT EXISTS rate_limit_counters_reset_at_idx ON rate_limit_counters (reset_at);
--> statement-breakpoint

-- The restricted runtime role (memex_app, created in 0081) is the one that serves
-- requests on Cloud Run. ALTER DEFAULT PRIVILEGES in 0081 already grants on tables
-- created afterwards, but — mirroring migration 0100 — we GRANT explicitly so the
-- privilege does not depend on the creating role matching the default-privileges
-- grantor. No RLS is enabled on this table, so memex_app operates on it directly.
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_counters TO memex_app;
