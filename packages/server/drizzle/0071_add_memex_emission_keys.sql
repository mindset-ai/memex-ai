-- memex_emission_keys: long-lived per-Memex keys gating POST /api/test-events (spec-129).
-- Modelled on mcp_tokens (0020). The raw key `mxk_<random>` is stored only as a SHA-256
-- hash (`hashed_key`, UNIQUE for O(1) auth lookup, dec-5); `prefix` keeps the leading
-- chars for an `mxk_xxxxxxxx…` display in the settings list (never the raw key, never the
-- hash). Revoke = set `revoked_at` (we never delete) so the key list + audit trail stay
-- intact. Multiple non-revoked keys per Memex live simultaneously — that IS the rotation
-- mechanism (mint new → roll out → revoke old, no time pressure, dec-4).
--
-- There is deliberately NO anonymous-emission path (dec-3 / dec-7): a valid key is required
-- for every emission, so no `allow_anonymous_emission` flag is added to `memexes` or
-- anywhere else. This migration touches only the new key table.

CREATE TABLE IF NOT EXISTS memex_emission_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id      uuid NOT NULL REFERENCES memexes(id) ON DELETE CASCADE,
  name          text NOT NULL,
  hashed_key    text NOT NULL UNIQUE,
  prefix        text NOT NULL,
  last_used_at  timestamp with time zone,
  revoked_at    timestamp with time zone,
  created_at    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memex_emission_keys_memex_id_idx ON memex_emission_keys(memex_id);
