-- mcp_tokens: long-lived MCP API keys, one per (user × device label). Token plaintext
-- (`mxt_<random>`) is stored only as a SHA256 hash; `prefix` keeps the first 8 chars
-- for a recognisable "mxt_xxxxxxxx…" display in the settings list. Revoke = set
-- revoked_at (we never delete, so /settings/tokens history stays intact).
--
-- cli_auth_requests: ephemeral state for the device-flow installer. The CLI calls
-- /api/cli/auth/start to claim a `code` (e.g., ABCD-1234), opens the user's browser to
-- the admin's confirm page, then long-polls /api/cli/auth/poll/:reqId for the minted
-- token. Rows expire 5 minutes after creation; cleanup runs as part of the auth flow.

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  prefix      text NOT NULL,
  last_used_at  timestamp with time zone,
  revoked_at    timestamp with time zone,
  created_at    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_tokens_user_id_idx ON mcp_tokens(user_id);

CREATE TABLE IF NOT EXISTS cli_auth_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'pending',
  minted_token  text,
  completed_at  timestamp with time zone,
  expires_at    timestamp with time zone NOT NULL,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cli_auth_requests_status_valid CHECK (status IN ('pending', 'completed', 'consumed'))
);
