-- spec-200 dec-7: persist the AI worthiness verdict for Specs NOT announced.
--
-- The generation step judges each shipped Spec's noteworthiness (worthAnnouncing).
-- Worthy → a row in whats_new_entries. NOT worthy → a row HERE, recording that the
-- Spec was evaluated and deliberately skipped (with the model's reason). This makes
-- the judgement happen exactly ONCE per Spec: the candidate set excludes Specs
-- present in EITHER table, so a skipped Spec is never re-judged on later deploys
-- (no wasted LLM calls, and no risk of a "skip" later flipping to "announce" and
-- appearing weeks after it shipped).
--
-- Global, like whats_new_entries — no memex/user scoping. Revert:
-- drizzle/reverts/0081_add_whats_new_skips.revert.sql drops the table.

CREATE TABLE "whats_new_skips" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_spec_ref"   text NOT NULL,
  "source_spec_handle" text NOT NULL,
  -- The model's reason for skipping (debug / audit only).
  "reason"            text,
  "created_at"        timestamptz NOT NULL DEFAULT now()
);

-- One verdict per source Spec — the judged-once key.
CREATE UNIQUE INDEX "whats_new_skips_source_spec_ref_idx"
  ON "whats_new_skips" ("source_spec_ref");
