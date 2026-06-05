-- spec-111 t-1: read-only public access per Memex — schema foundation.
--
-- Two changes, both zero-downtime and idempotent (IF [NOT] EXISTS / DROP+ADD):
--
--   1. `memexes.visibility` (text, NOT NULL, default 'private'). The owner toggle
--      that ac-4 is built on. 'private' = org-members-only (std-4 model, unchanged);
--      'public' = read-only for everyone incl. anonymous. The default 'private'
--      applies to every existing row, so the migration never silently exposes a
--      memex. A `memexes_visibility_valid` CHECK constrains it to the known set.
--
--   2. `user_memex_access` — the "Visited public memex" pin relationship. Strictly
--      NON-org (org members already see all org memexes via org_memberships). When a
--      signed-in non-member visits a public memex we INSERT ... ON CONFLICT DO
--      NOTHING. Composite PK (user_id, memex_id). UUID FKs to users(id) and
--      memexes(id), both ON DELETE CASCADE. access_level is fixed to 'read' today
--      (write still requires org membership — there is no write path through this
--      relationship).
--
-- Idempotent so the hand-migration runner can re-apply cleanly on any environment
-- that already carries a partial touch.

-- 1. memexes.visibility -------------------------------------------------------
ALTER TABLE memexes
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';

ALTER TABLE memexes
  DROP CONSTRAINT IF EXISTS memexes_visibility_valid;

ALTER TABLE memexes
  ADD CONSTRAINT memexes_visibility_valid
    CHECK (visibility IN ('public', 'private'));

-- 2. user_memex_access --------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_memex_access (
  user_id      uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  memex_id     uuid NOT NULL REFERENCES memexes(id) ON DELETE CASCADE,
  access_level text NOT NULL DEFAULT 'read',
  added_at     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_memex_access_pkey PRIMARY KEY (user_id, memex_id)
);

ALTER TABLE user_memex_access
  DROP CONSTRAINT IF EXISTS user_memex_access_level_valid;

ALTER TABLE user_memex_access
  ADD CONSTRAINT user_memex_access_level_valid
    CHECK (access_level IN ('read'));

CREATE INDEX IF NOT EXISTS user_memex_access_memex_id_idx
  ON user_memex_access (memex_id);
