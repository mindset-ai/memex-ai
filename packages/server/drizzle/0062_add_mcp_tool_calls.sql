-- MCP tool-call telemetry: per-session client identity + per-call audit trail.
--
-- Why: the MCP `instructions` field truncates at 2 KB on Claude Code, and we
-- have no visibility into whether colleagues' agents are hitting the same
-- friction the author sees in their own threads. This table is the empirical
-- substrate for that analysis — "across N sessions and N users, which tools
-- error, which sequences recur, which guidance gets ignored?".
--
-- Two tables, deliberately:
--   * mcp_sessions      — one row per Mcp-Session-Id, capturing client identity
--                         once (UA, parsed name/version, IP, initialize blob).
--                         last_seen_at refreshes on every call.
--   * mcp_tool_calls    — one row per tool invocation. user_id is denormalised
--                         off mcp_sessions deliberately (per user request) so
--                         the common "what did user X do" query doesn't need
--                         a join. session_id FK keeps the link to client/IP.
--
-- Session-id mechanics (spike-verified):
--   * Server stamps a UUID in the `Mcp-Session-Id` response header if the
--     client didn't send one (Hono-level, see packages/server/src/app.ts).
--   * Per MCP spec the client SHOULD echo that id on subsequent requests.
--     Claude Code does (verified across multiple calls within one thread,
--     different ids across fresh threads).
--   * Non-compliant clients that re-roll the id on every call will look like
--     N one-call sessions — analytically degraded but not broken.
--
-- Capture policy:
--   * args_json: always captured (JSONB). Tool inputs already contain user
--     content the agent has, no incremental sensitivity.
--   * result_text: dev-mode ONLY (see services/telemetry.ts isDevMode gate).
--     Production capture requires explicit customer opt-in; this column stays
--     NULL otherwise. The column exists so we don't ship two schemas.
--   * error: always captured (a tool failure with no error message is
--     useless for the friction-pattern analysis the table exists for).

CREATE TABLE mcp_sessions (
  -- The MCP session id is whatever the client echoes (or the UUID we minted
  -- if they didn't send one). TEXT not UUID — clients aren't required to
  -- use UUIDs and we'd rather store the raw value than coerce-and-lose.
  session_id      TEXT        PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Parsed from User-Agent header (e.g. "claude-code", "cursor", "curl-probe").
  -- Falls back to the raw UA if parsing fails. Indexable for "what clients
  -- hit us" rollups.
  client_name     TEXT,
  client_version  TEXT,

  -- Raw User-Agent header — kept so we can re-parse if the parser improves
  -- without losing historical fidelity.
  user_agent      TEXT,

  -- Initialize body's clientInfo blob (MCP-spec canonical client identity).
  -- JSONB so we keep whatever extras the client sends; we read .name/.version
  -- from it. NULL for sessions where we never saw the initialize POST (e.g.
  -- session started on a previous server instance, client reconnected with
  -- existing session-id).
  client_info     JSONB,

  -- Caller IP. INET so we can range-query (CIDR) for "all calls from one org".
  -- Sourced from X-Forwarded-For (Cloud Run sets this in prod). NULL locally
  -- where there's no proxy in front.
  ip_address      INET,

  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mcp_sessions_user_id_started_at_idx
  ON mcp_sessions (user_id, started_at DESC);

CREATE INDEX mcp_sessions_client_name_idx
  ON mcp_sessions (client_name)
  WHERE client_name IS NOT NULL;


CREATE TABLE mcp_tool_calls (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  session_id   TEXT        NOT NULL REFERENCES mcp_sessions(session_id) ON DELETE CASCADE,

  -- Denormalised off mcp_sessions.user_id by design (per user request) so the
  -- common "what did user X do across all sessions" query stays a single-table
  -- scan. CASCADE so user deletion wipes the trail.
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Which memex did this call act on?
  --
  -- Captured from the tool's ctx.resolveMemex / resolveMemexFromEntity /
  -- resolveRef calls — those resolvers run server-side off whatever the
  -- tool's args carry (e.g. `memex='ns/mx'`, or a ref string, or an entity
  -- UUID), and the telemetry wrap reads the resolved id at the end of the
  -- call. NULL for tools that don't touch a specific memex (`list_memexes`,
  -- `get_information`) or for calls that errored out before resolving.
  --
  -- SET NULL on memex delete so the historical row survives.
  memex_id     UUID        REFERENCES memexes(id) ON DELETE SET NULL,

  -- Which org does that memex belong to?
  --
  -- Derived from memex_id at insert time (memex → namespace → org for
  -- org-kind namespaces; NULL for personal-kind). Denormalised here so
  -- "calls per org" stays a single-table scan even after memex/namespace
  -- renames or moves. NULL for personal memexes (no owning org) and for
  -- calls where memex_id is itself NULL.
  org_id       UUID        REFERENCES orgs(id) ON DELETE SET NULL,

  tool_name    TEXT        NOT NULL,
  args_json    JSONB       NOT NULL,
  duration_ms  INTEGER     NOT NULL,

  -- NULL on success, the error message on failure. Truncated by the service
  -- layer if pathologically large; the analysis target is patterns not stacks.
  error        TEXT,

  -- DEV-ONLY capture (gated in services/telemetry.ts). NULL in production
  -- until per-customer opt-in lands.
  result_text  TEXT
);

CREATE INDEX mcp_tool_calls_session_idx
  ON mcp_tool_calls (session_id, created_at);

CREATE INDEX mcp_tool_calls_user_idx
  ON mcp_tool_calls (user_id, created_at DESC);

-- "Which tools error most" rollup.
CREATE INDEX mcp_tool_calls_tool_error_idx
  ON mcp_tool_calls (tool_name, created_at DESC)
  WHERE error IS NOT NULL;

-- "Calls within memex X" / "calls within org Y". Partial — most analytics
-- queries care only about rows where the call actually touched a memex
-- (i.e. not list_memexes / get_information).
CREATE INDEX mcp_tool_calls_memex_id_idx
  ON mcp_tool_calls (memex_id, created_at DESC)
  WHERE memex_id IS NOT NULL;

CREATE INDEX mcp_tool_calls_org_id_idx
  ON mcp_tool_calls (org_id, created_at DESC)
  WHERE org_id IS NOT NULL;
