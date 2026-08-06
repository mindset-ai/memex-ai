-- spec-521 t-3 (ac-15, ac-12) — supersession pointers + archive attribution on documents.
--
-- TWO GROUPS OF COLUMNS, one migration, because both ship in the same PR (§4:
-- the columns are inert until the code writes them, so there is no window where
-- one half is live without the other).
--
-- 1. SUPERSESSION (dec-5, doc-level only). "This Spec shipped, and a later Spec
--    changed it" — history you do not want forgotten, whose prose is no longer
--    true. Archive cannot express that: archive means "this is dead" and
--    withholds content, whereas supersession withholds nothing and only adds a
--    pointer. Four independent workarounds for the missing concept already exist
--    in this Memex (state in the title, supersession recorded in the SUCCESSOR's
--    title, hand-written "Reconciliation with…" sections, an "On Ice" tag), which
--    is the tell that the model was missing a primitive.
--
--    superseded_at NULL = not superseded, mirroring archived_at's convention.
--    Many-to-one is allowed (several Specs may point at one successor); chains are
--    legal but cycles are rejected at write, not by a constraint here.
--
--    Doc-level ONLY per dec-5 — no decision, section or other child entity gains a
--    pointer. Decision-level would fan out to every reader of a decision
--    (listDecisions alone has ten non-test callers, agent/context-builder.ts among
--    them), and a marker honoured in most read paths but not all is worse than no
--    marker, because people learn to trust it and it is absent exactly when it
--    matters.
--
-- 2. ARCHIVE ATTRIBUTION (ac-2, ac-5, ac-12). The archived-Spec stub an agent gets
--    must carry WHO archived it and WHY, and the archive view must show both. The
--    table had archived_at and nothing else, so the reason and the actor had
--    nowhere to live. Recorded on spec-521 issue-3: §4 counted only the three
--    supersession columns and undercounted the migration by these three.
--
--    archived_by_name is the DENORMALISED display snapshot, stamped at write per
--    std-32, so a later user rename or deletion can never rewrite historical
--    attribution. This mirrors the grounded_by_user_id / grounded_by_name pair
--    added to this same table by 0112 — same shape, same reasoning, no new pattern,
--    and like 0112 the provenance user id carries no FK.
--
--    PHASE-AT-ARCHIVE NEEDS NO COLUMN, deliberately. archived_at is orthogonal to
--    status (documented on the column since doc-12: "Orthogonal to status so the
--    Spec retains its kanban lane when unarchived"), so the phase a Spec was in
--    when archived simply IS its unchanged `status`. The stub reads status for that
--    fact, and restore (ac-4 — "restore it to exactly the phase and content it
--    had") is satisfied by nulling archived_at alone. There is no phase to save and
--    reinstate.
--
-- std-39 — the cost reasoning, recorded at design time rather than discovered in
-- production:
--   * LOCKS / REWRITE. Every column here is nullable with NO default, so on
--     PG 11+ each ADD COLUMN is a catalogue-only change — no table rewrite, and the
--     ACCESS EXCLUSIVE lock is held only for the metadata update. There is no
--     backfill UPDATE (contrast 0127, which had to reason about one): every
--     existing row is correctly "not superseded" and "no archive attribution" with
--     all six NULL. Nothing to order against the live write path, so no
--     lock_timeout / lock-ordering hazard (cl-2, cl-3) applies.
--   * GROWTH (cl-4, cl-23). These are per-DOCUMENT columns, not a per-event table.
--     They add no row accrual, so no retention or aging policy is owed.
--   * INDEX BUILD (cl-20). The index below is created with a PLAIN inline
--     CREATE INDEX, not CONCURRENTLY, and that is the correct call here rather than
--     an oversight. CONCURRENTLY cannot run inside a transaction, and this repo's
--     hand-migration runner wraps every file in one — so CONCURRENTLY would have to
--     be an out-of-band step. It is not warranted: `documents` is bounded by the
--     number of Specs/docs across all Memexes (the largest single Memex is in the
--     low hundreds), which is a build measured in milliseconds, not the "large,
--     already-populated table" cl-20 is written for. If `documents` ever grows to
--     the point where this stops being true, a future index on it belongs
--     out-of-band.
--   * INDEX JUSTIFICATION (cl-18, cl-19, cl-25). The index serves the REVERSE
--     question the successor's page asks — "what did I replace?" — i.e. a lookup by
--     superseded_by_doc_id to render the mirror line ("Replaces spec-245"). That is
--     on the hot doc-read path, so an unindexed scan is not acceptable. The write
--     cost is negligible: supersession is set once per Spec by an agent, so this is
--     a near-read-only column on a low-write table, which is the case where an
--     index is clearly worth its maintenance. It is a PARTIAL index (WHERE NOT
--     NULL) because the overwhelming majority of rows are NULL and never need an
--     entry — smaller index, cheaper writes for every non-superseded doc.
--
-- std-36 — new columns on an RLS-enabled table. `documents` already carries its
-- memex_id isolation policy, and a policy covers every column of its table, so NO
-- new or altered policy is needed and none is added here. Because RLS is ENABLE and
-- not FORCE, this migration runs as the table owner and bypasses RLS by design;
-- the same-Memex invariant on supersededBy is therefore asserted IN CODE at the
-- service layer as well, never left to the policy to enforce.
--
-- REVERSIBLE by a plain DROP COLUMN on all six (plus DROP INDEX) if the pointer
-- turns out to be the wrong model. No view or RLS policy references the new
-- columns, so nothing downstream needs re-granting — contrast 0113, which had to
-- reason about paused_at's dependents before dropping it.
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner wraps each file in a
-- transaction and tracks it in manual_migrations; the guards let a retry re-apply
-- cleanly if a prior run committed the DDL but not the tracking row.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS superseded_by_doc_id uuid,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS supersession_note text,
  ADD COLUMN IF NOT EXISTS archive_reason text,
  ADD COLUMN IF NOT EXISTS archived_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS archived_by_name text;

-- ON DELETE SET NULL: if a successor Spec is ever hard-deleted, its predecessors
-- must fall back to "not superseded" rather than keep a dangling pointer. Added
-- separately from the ADD COLUMN so the IF NOT EXISTS guard above stays usable;
-- the catalogue check makes the constraint add idempotent too.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_superseded_by_doc_id_fkey'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_superseded_by_doc_id_fkey
      FOREIGN KEY (superseded_by_doc_id) REFERENCES documents(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS documents_superseded_by_doc_id_idx
  ON documents (superseded_by_doc_id)
  WHERE superseded_by_doc_id IS NOT NULL;
