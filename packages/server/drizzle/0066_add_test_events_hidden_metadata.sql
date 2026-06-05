-- spec-115 v0.1.0: add `actor`, `hidden`, and `metadata` columns to test_events.
--
-- actor:   nullable text. WHO emitted this event (spec-115 dec-6, spec-122
--          activity contract). First-class column — not nested in metadata
--          — so the Pulse activity view can UNION on actor across every
--          activity-bearing table without going through metadata->>'actor'.
--          Helper auto-populates from a documented env-var fallback chain
--          (GITHUB_ACTOR, GITLAB_USER_LOGIN, BUILDKITE_BUILD_AUTHOR,
--          CIRCLE_USERNAME, USER, USERNAME); when no env var is set the
--          field is omitted and lands NULL.
--
-- hidden:  default false; when true, the event is stored but excluded from
--          the AC's displayed verification badge calculation. Audit trail
--          intact; "latest emission wins" logic skips hidden rows.
--
-- metadata: JSONB; extensible context bag surfaced in the AC matrix tooltip
--           in the admin UI. Server-side caps (4KB total, 32 keys, 256-char
--           values) enforced at the test-events route; oversized keys are
--           dropped and named in the X-Memex-Warning response header.
--           A `metadata.actor` key (legacy hand-rolled wire format) is
--           accepted opaquely; it is NOT promoted into the top-level
--           actor column. The canonical actor is the top-level field.
--
-- Backwards-compatible: existing emissions land identically (actor = NULL,
-- hidden = false, metadata = NULL). The helper does not enforce limits
-- client-side (spec-115 ac-12); the server is the single point of validation.

ALTER TABLE "test_events" ADD COLUMN IF NOT EXISTS "actor" text;
ALTER TABLE "test_events" ADD COLUMN IF NOT EXISTS "hidden" boolean NOT NULL DEFAULT false;
ALTER TABLE "test_events" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
