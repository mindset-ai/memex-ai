-- spec-12 (memex-backstage) t-1 — comms_event: one row per Postmark delivery /
-- engagement event for an already-logged email (Delivery / Open / Click / Bounce /
-- SpamComplaint), the fidelity layer comms_log's thin sent|delivered|failed shadow
-- lacks. Core (memex-ai) OWNS + WRITES this public table from the Postmark webhook
-- (routes/postmark-webhook.ts, spec-12 t-2); Backstage READS it cross-tenant via the
-- memex_admin BYPASSRLS role and never writes it (spec-280 admin↔public boundary).
-- It powers the Comms page's per-message OUTCOME, the single-message event trail
-- fallback, and repeat-send / high-retry detection (spec-12 dec-2).
--
-- LINK: comms_log_id is a real FK to comms_log(id) ON DELETE cascade, so the
-- core-side 90-day retention prune (pruneCommsLog) cascades these rows away with
-- their parent — no orphan accumulation. source_ref (the Postmark MessageID) is
-- denormalized alongside it: it is the join key the webhook matches on (it only has
-- the MessageID, not our row id) AND the dedup discriminator. Events for a MessageID
-- with no matching comms_log row (e.g. a send we never logged) are simply not
-- recorded — same graceful no-op as updateCommDeliveryStatus on an unknown id.
--
-- METADATA ONLY (spec-6 dec-4, carried forward): event type + bounce type/reason +
-- timestamps + the link — NEVER a message body. Full content stays in Postmark,
-- reached via source_ref. No html/text/body column exists.
--
-- IDEMPOTENT enrichment (spec-12 dec-6): UNIQUE (source_ref, event_type, occurred_at)
-- lets the webhook write ON CONFLICT DO NOTHING, so a redelivered/duplicate Postmark
-- event is a no-op. That unique index leads with source_ref, so it ALSO serves the
-- source_ref join lookups — no separate source_ref index is needed. occurred_at is
-- the Postmark event timestamp (NOT now()): the displayed per-message outcome is
-- resolved by event recency/priority at read time so a late Delivery never clobbers
-- an earlier Bounce/SpamComplaint.
--
-- RLS — deliberately EXCLUDED, mirroring comms_log (0104) and usage_events (0090).
-- comms_event is a CROSS-TENANT, user-scoped telemetry dimension written ADVISORILY
-- from the contextless Postmark webhook (no request ALS / tenant GUC) — a FORCE-RLS
-- WITH CHECK would silently reject those inserts, and a memex_id USING clause is
-- meaningless on a row keyed via comms_log → user_id, not memex_id. The row holds
-- only ids/enums/a bounce reason line (no body, no credentials); isolation is at the
-- service layer and, in Backstage, the requireOperator gate. OMITTING all RLS DDL IS
-- the exclusion (same justification comms_log / usage_events / visitors carry).
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner wraps each file in a
-- transaction and tracks it in manual_migrations; the guards let a retry re-apply
-- cleanly if a prior run committed the DDL but not the tracking row.

CREATE TABLE IF NOT EXISTS "comms_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "comms_log_id" uuid NOT NULL REFERENCES "comms_log"("id") ON DELETE cascade,
  "source_ref" text NOT NULL,
  "event_type" text NOT NULL,
  "bounce_type" text,
  "bounce_reason" text,
  "occurred_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comms_event_dedup" UNIQUE ("source_ref", "event_type", "occurred_at")
);

-- FK lookups + ON DELETE cascade performance (the source_ref join is served by the
-- comms_event_dedup unique index, which leads with source_ref).
CREATE INDEX IF NOT EXISTS "comms_event_comms_log_id_idx"
  ON "comms_event" ("comms_log_id");
