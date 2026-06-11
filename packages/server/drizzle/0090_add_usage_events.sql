-- spec-244 t-1 — usage_events: the durable product-engagement telemetry store.
--
-- Separate from activity_log (dec-1): activity_log is the audit history of what
-- CHANGED; usage_events is how people EXPERIENCE the product. Keeping them apart
-- stops high-volume product usage from bloating the audit log.
--
-- Two writers (dec-4 / dec-8): the POST /telemetry route (front-end track()
-- events, source='frontend') and a bus subscriber that mirrors whitelisted
-- mutate() outcomes (source='backend'). The forwarder (dec-3) tails this table:
-- `forwarded_at` IS the outbox cursor (NULL until a row has been shipped to the
-- analytics sink), giving at-least-once delivery that survives a Cloud Run
-- restart. `env` (dec-9) is the server-derived environment stamp so int and prod
-- never co-mingle at the sink boundary.
--
-- RLS — deliberately EXCLUDED, mirroring activity_log (drizzle/0081 §exclusions).
-- The dec-8 back-end subscriber writes from the bus dispatch path with NO request
-- ALS context (exactly like the activity_log sink), so a FORCE-RLS WITH CHECK
-- would silently reject those inserts; and the forwarder is a cross-tenant
-- background drain (no app.memex_id set), which a USING clause would filter to
-- zero rows. Tenant isolation is enforced at the SERVICE layer instead: every
-- read/query helper scopes by memex_id in its WHERE clause, and the payload
-- carries only IDs/enums/counts (no credentials). Same justification activity_log
-- carries in 0081.

CREATE TABLE IF NOT EXISTS "usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "memex_id" uuid NOT NULL REFERENCES "memexes"("id") ON DELETE cascade,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "name" text NOT NULL,
  "source" text NOT NULL,
  "props" jsonb,
  "env" text NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "forwarded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "usage_events_source_valid" CHECK ("source" IN ('frontend', 'backend')),
  CONSTRAINT "usage_events_env_valid" CHECK ("env" IN ('int', 'prod', 'local', 'test'))
);

-- Outbox tail: the forwarder scans undrained rows oldest-first. A partial index on
-- the unforwarded set keeps that scan tiny once most rows are drained.
CREATE INDEX IF NOT EXISTS "usage_events_unforwarded_idx"
  ON "usage_events" ("occurred_at")
  WHERE "forwarded_at" IS NULL;

-- SQL analytics + per-memex queries (rollout step one: queryable before any sink).
CREATE INDEX IF NOT EXISTS "usage_events_memex_id_occurred_at_idx"
  ON "usage_events" ("memex_id", "occurred_at");
