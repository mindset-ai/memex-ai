-- spec-6 (memex-backstage) t-1 — comms_log: the unified per-user record of every
-- outbound communication across all channels (email / in-app / badge / OS),
-- scheduled and sent. Core (memex-ai) OWNS + WRITES this public table; Backstage
-- READS it cross-tenant via the memex_admin BYPASSRLS role and never writes it
-- (spec-6 dec-5; the spec-280 admin↔public boundary). It is the single pane that
-- lets ops see the total comms load on one human and avoid bombarding them.
--
-- METADATA ONLY (spec-6 dec-4): a one-line subject/summary + status + timestamps
-- + a source_ref pointer — NEVER the message body. Full content stays in the
-- system-of-record (Postmark / HubSpot / in-app notification store), reached via
-- source_ref. Retention ~90 days, pruned core-side (spec-6 t-8).
--
-- RLS — deliberately EXCLUDED, mirroring usage_events (drizzle/0090) and visitors
-- (drizzle/0096). comms_log is a CROSS-TENANT, user-scoped comms/telemetry
-- dimension (keyed on user_id, not memex_id), written ADVISORILY from send paths
-- that often run with no request ALS / tenant GUC (a background Activation send,
-- a Postmark/Stripe delivery webhook) — a FORCE-RLS WITH CHECK would silently
-- reject those inserts, and a memex_id USING clause is meaningless on a
-- user-keyed row. The row holds only ids/enums/a summary line (no body, no
-- credentials); isolation is enforced at the service layer and, in Backstage, by
-- the requireOperator gate. Same justification usage_events / visitors carry.
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner wraps each file in a
-- transaction and tracks it in manual_migrations; the guards let a retry re-apply
-- cleanly if a prior run committed the DDL but not the tracking row.

CREATE TABLE IF NOT EXISTS "comms_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "channel" text NOT NULL,
  "type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'sent',
  "scheduled_for" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "subject" text,
  "source_ref" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comms_log_channel_valid" CHECK ("channel" IN ('email', 'in_app', 'badge', 'os')),
  CONSTRAINT "comms_log_status_valid" CHECK ("status" IN ('scheduled', 'sent', 'delivered', 'failed'))
);

-- Per-user timeline: every comm to one human, newest first (spec-6 ac-1).
CREATE INDEX IF NOT EXISTS "comms_log_user_id_created_at_idx"
  ON "comms_log" ("user_id", "created_at");

-- Cross-user schedule view: upcoming sends only, soonest first (spec-6 ac-4).
-- Partial on the unsent set so the scan stays tiny.
CREATE INDEX IF NOT EXISTS "comms_log_scheduled_idx"
  ON "comms_log" ("scheduled_for")
  WHERE "sent_at" IS NULL;
