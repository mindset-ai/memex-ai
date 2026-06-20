-- spec-254 — usage_events.visitor_id: the anonymous-first identity join key.
--
-- A nullable, FK-less uuid column so a usage event can carry the visitor_id
-- (spec-254 dec-2) without requiring a visitors row to exist first (an anonymous
-- event may reference a visitor before any visitors row is written, and this is a
-- high-volume table where an FK check per insert is unwanted). The funnel joins
-- usage_events.visitor_id → visitors to stitch the anonymous head of a journey to
-- its identified tail. NULL on rows captured before visitor_id plumbing reaches
-- them (and on backend/system events with no browser origin).

ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "visitor_id" uuid;

-- Funnel join + per-visitor lookups. Partial — only rows carrying a visitor_id.
CREATE INDEX IF NOT EXISTS "usage_events_visitor_id_idx"
  ON "usage_events" ("visitor_id")
  WHERE "visitor_id" IS NOT NULL;
