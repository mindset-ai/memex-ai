-- spec-122 t-4 (dec-3 / ac-12) — give activity_log the contract's denormalised
-- actor_name, so the rows the activity view UNIONs for SOURCELESS events
-- (spec-179 status_changed phase moves, spec-132 checkpoint beats) carry the
-- full {actor_user_id, actor_name, channel} contract and render with no
-- read-time join, surviving a later user rename (ac-10).
--
-- Nullable + backfill-free: legacy rows and any event that didn't carry an actor
-- read as unknown. The sink (services/activity-log.ts) writes it from the event's
-- propagated actor; mutate() stamps the event from the RequestCtx.

ALTER TABLE activity_log
  ADD COLUMN IF NOT EXISTS actor_name text;
