-- spec-304: originating-session surrogate for the magic-link flow (embedded webview).
--
-- A Flutter desktop app embeds the live web UI in a webview. The user requests a magic
-- link but clicks it in their EXTERNAL browser (a different cookie jar), so the requesting
-- webview never becomes authenticated. `login_requests` is a polling handle: the requesting
-- client holds `id` (a high-entropy capability — it never sees the raw token) and polls the
-- status endpoint. When the magic-link token is consumed elsewhere, `verified_at` is stamped
-- against the row whose `token_id` matches, and the next poll hands the webview a session.
--
-- Security: `id` yields a session, so it is treated like a single-use token — short TTL
-- (mirrors the magic_link token's `expires_at`) and only honoured while genuinely verified
-- AND unexpired. ON DELETE CASCADE on token_id ties its lifetime to the auth_tokens row.
CREATE TABLE IF NOT EXISTS login_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid NOT NULL REFERENCES auth_tokens(id) ON DELETE CASCADE,
  email text NOT NULL,
  verified_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_requests_token_id_idx ON login_requests (token_id);
