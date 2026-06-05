-- doc-23 T-1 / D-2: per-user Slack OAuth credentials with GCP KMS envelope encryption.
--
-- Token storage shape (per §3 of doc-23):
--   ciphertext   = AES-256-GCM(token) using a per-row 256-bit DEK + 12-byte IV
--   iv           = the 12-byte nonce used for the DEK encryption (BYTEA, not zero-length)
--   wrapped_dek  = the DEK encrypted by GCP KMS master key
--                  (projects/memex-ai-int/locations/us-east4/keyRings/memex/cryptoKeys/slack-tokens)
--
-- Local-dev plaintext mode (services/slack/crypto.ts, NODE_ENV !== 'production' AND
-- SLACK_TOKEN_ENCRYPTION=plaintext) writes the raw token into `ciphertext` and stores
-- empty BYTEA in `iv` and `wrapped_dek`. The CHECK on iv length is intentionally absent
-- so the dev path can write zero-length values; production paths enforce length=12 in
-- application code (typed via the bytea customType in db/schema.ts).
--
-- user_id is PK because v1 supports one Slack connection per user (multi-workspace UX
-- out-of-scope per §1; reconnecting overwrites). Reactivity: mutations emit via mutate()
-- with memexId="" + userId set, mirroring mcp_tokens per std-8 §3.

CREATE TABLE user_slack_tokens (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slack_user_id      TEXT NOT NULL,
  slack_workspace_id TEXT NOT NULL,
  scope              TEXT NOT NULL,
  ciphertext         BYTEA NOT NULL,
  iv                 BYTEA NOT NULL,
  wrapped_dek        BYTEA NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ
);

CREATE INDEX user_slack_tokens_workspace_idx
  ON user_slack_tokens (slack_workspace_id);
