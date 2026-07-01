-- spec-427 t-4 (dec-5): lifecycle-email suppression store. One nullable timestamp on
-- users — null = subscribed, a timestamp = the user unsubscribed from activation/
-- win-back (lifecycle/broadcast) email via the one-click List-Unsubscribe link. Scope
-- is LIFECYCLE ONLY: transactional/auth email and the spec-428 welcome ignore it and
-- always send (ac-11 scope / ac-12). users is global (not RLS/memex-scoped), so no
-- policy change is needed. Idempotent — re-running is a no-op.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "lifecycle_email_unsubscribed_at" timestamp with time zone;
