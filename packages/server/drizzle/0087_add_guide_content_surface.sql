-- spec-222 t-7 (dec-3): make the voice-guide RAG corpus SURFACE-KEYED.
--
-- The guide_content corpus (migration 0079) is a single GLOBAL product-docs
-- store. spec-222 introduces a second consumer of voice guidance — the public
-- marketing website — alongside the in-product app. Both sessions read the SAME
-- table, but a public-website session must retrieve ONLY website content and an
-- app session ONLY app content (the blast-radius isolation boundary, ac-4 /
-- ac-11 / ac-12). The server ENFORCES this filter; the client cannot override it.
--
-- This migration adds the isolation key:
--   * surface text NOT NULL DEFAULT 'memex-app' — which product surface a chunk
--     documents. Additive + backward-compatible: every existing row (the app
--     corpus imported by db:import-guide-content) backfills to 'memex-app' via
--     the column default, so the existing app retrieval path is unchanged.
--     Website ingestion (a later task) writes surface = 'memex-website'.
--
-- Retrieval filters EVERY query by surface server-side (services/guide-content.ts):
--   Layer 1 (prefetchScreenContent) reads (surface, screen_key); Layer 2
--   (searchGuideContent) reads (surface) + vector/FTS. The indexes below make the
--   surface filter cheap on both arms.
--
-- Idempotent: IF NOT EXISTS guards on the column and indexes, so re-running is a
-- no-op (the hand-migration tracker also runs each file once per DB).
--
-- Revert: drizzle/reverts/0087_add_guide_content_surface.revert.sql.

ALTER TABLE "guide_content"
  ADD COLUMN IF NOT EXISTS "surface" text NOT NULL DEFAULT 'memex-app';

-- Layer-1 pre-fetch is now a (surface, screen_key) lookup — composite index so
-- the surface filter is served by the same scan as the screen_key equality.
CREATE INDEX IF NOT EXISTS "guide_content_surface_screen_key_idx"
  ON "guide_content" ("surface", "screen_key");

-- Layer-2 search filters by surface before the vector / FTS arm narrows further.
CREATE INDEX IF NOT EXISTS "guide_content_surface_idx"
  ON "guide_content" ("surface");
