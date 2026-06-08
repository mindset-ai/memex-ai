-- spec-200 t-1: storage for published "What's New" release-note entries.
--
-- One GLOBAL feed (dec-3) — the prod-promoted Specs of memex-building-itself,
-- identical for every user. So, like guide_content (0079), there is deliberately
-- NO memex_id / user_id column: the table is one shared, append-only feed that
-- every user's read hits.
--
-- Each row is one published entry, auto-generated at the daily prod promotion
-- (dec-1 fully-auto, no approval; dec-2 promotion-time). The generation service
-- (t-2) drafts what_text/why_text from a Spec's Overview + resolved Decisions +
-- Scope ACs and inserts here; the read API (t-4) lists newest-first; nothing
-- regenerates an entry once published, so entries are stable/citable (ac-9).
--
-- Idempotency (ac-6/ac-9): source_spec_ref is UNIQUE. Re-running a promotion
-- that re-encounters an already-published Spec is a no-op (repo uses
-- onConflictDoNothing) — never a duplicate, never a silent rewrite.
--
-- Revert: drizzle/reverts/0080_add_whats_new_entries.revert.sql drops the table.

CREATE TABLE "whats_new_entries" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical ref of the Spec this entry was generated from (idempotency key).
  "source_spec_ref"   text NOT NULL,
  -- Display handle (e.g. "spec-192") — denormalised for cheap rendering.
  "source_spec_handle" text NOT NULL,
  -- User-facing headline for the entry (benefit-led, not the raw Spec title).
  "title"             text NOT NULL,
  -- WHAT shipped (plain language).
  "what_text"         text NOT NULL,
  -- WHY it matters to users (plain language).
  "why_text"          text NOT NULL,
  "published_at"      timestamptz NOT NULL DEFAULT now(),
  "created_at"        timestamptz NOT NULL DEFAULT now()
);

-- One entry per source Spec — the generation idempotency key (ac-6/ac-9).
CREATE UNIQUE INDEX "whats_new_entries_source_spec_ref_idx"
  ON "whats_new_entries" ("source_spec_ref");

-- Newest-first list read (t-4 feed API, ac-11 popup ordering).
CREATE INDEX "whats_new_entries_published_at_idx"
  ON "whats_new_entries" ("published_at" DESC);
