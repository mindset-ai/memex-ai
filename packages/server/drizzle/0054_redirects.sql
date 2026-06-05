-- b-36 T-4 — redirects table for cross-memex Brief moves + namespace/memex renames.
--
-- Canonical refs (mindset/personal/briefs/b-12, mindset/team/docs/doc-5/tasks/t-1)
-- live in URL paths. When a Brief moves between memexes or a namespace/memex
-- slug renames, existing path references must keep resolving. Per b-36 D-6:
--
--   * Store ONE row per move event — the resolver prefix-matches on read so
--     child paths (.../tasks/t-1, .../sections/s-2) inherit the redirect
--     without per-entity rows.
--   * `old_path` is the primary key — at most one redirect per source path
--     (re-recording a move is an UPSERT in the service layer).
--   * Direct-first precedence — callers consult this layer only after a
--     direct entity lookup misses (resolver work lands in T-5).
--   * Transitive chains handled in-app (services/redirects.ts) with a
--     maxDepth + visited-set cycle guard.
--   * No automatic expiry — redirects are permanent rows.
--
-- The CHECK on `reason` keeps writes honest: only the three documented move
-- events are valid sources of a redirect row.

CREATE TABLE redirects (
  old_path     TEXT PRIMARY KEY,
  new_path     TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('brief_move', 'memex_rename', 'namespace_rename')),
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);

-- Reverse lookups: "what redirects point at this path?" (e.g., for chain
-- analysis or operator tooling). Not load-bearing for the resolver hot path,
-- which is keyed off old_path / prefix-of-old_path.
CREATE INDEX redirects_new_path_idx ON redirects(new_path);
