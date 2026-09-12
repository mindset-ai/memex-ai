-- spec-563 t-4 — a section's tenant CANNOT disagree with its document's.
--
-- WHY THIS EXISTS, AND WHY IT IS A CONSTRAINT RATHER THAN A TEST.
--
-- 0147 denormalised documents.memex_id onto doc_sections. A denormalised column that CAN
-- drift from its source is a tenancy bug with a delay fuse: nothing reads wrong, until one
-- day a row is written with the wrong tenant and the activity view happily attributes it
-- there. The backfill made every existing row agree; nothing was stopping the next write
-- from disagreeing.
--
-- A test caught exactly that within an hour of 0147 landing — CI shard 2 went red with
-- `expected 1 to be +0` on a cross-table mismatch count. That is the correct outcome and
-- the wrong MECHANISM: the check ran late, in a suite, far from the insert that caused it,
-- and only because some other test happened to share the database. A test that depends on
-- global state to find a defect will also miss it whenever the ordering changes.
--
-- Postgres can enforce this at the write itself. A composite foreign key makes the
-- impossible state unrepresentable rather than merely detected:
--
--     doc_sections (doc_id, memex_id) REFERENCES documents (id, memex_id)
--
-- Now a fixture or a handler that stamps the wrong tenant fails AT THE INSERT, naming the
-- row, instead of surfacing three minutes later as an aggregate count in an unrelated
-- shard. [std-32: tenancy is load-bearing; std-39: reason about the write path, not only
-- the read.]

-- ── 1. The referenced side needs a unique key on the exact pair ─────────────────────────
-- `id` is already the primary key, so (id, memex_id) is unique by implication — but a
-- foreign key requires a DECLARED unique constraint over precisely its target columns.
-- This adds no meaningful storage beyond the index itself and no write ambiguity.
ALTER TABLE documents
  ADD CONSTRAINT documents_id_memex_id_key UNIQUE (id, memex_id);
--> statement-breakpoint

-- ── 2. Report any disagreement before trying to enforce it ──────────────────────────────
-- 0147 backfilled from documents, so every pre-existing row agrees by construction. If
-- that is somehow false, fail with the count rather than letting ADD CONSTRAINT emit a
-- generic violation — the number is the diagnostic.
DO $$
DECLARE mismatched bigint;
BEGIN
  SELECT count(*) INTO mismatched
    FROM doc_sections s JOIN documents d ON d.id = s.doc_id
   WHERE s.memex_id <> d.memex_id;
  IF mismatched > 0 THEN
    RAISE EXCEPTION
      'spec-563: % doc_sections rows disagree with their document''s memex_id. These are '
      'mis-attributed sections, not noise — investigate which writer produced them before '
      'correcting the rows, or the same writer will produce more.', mismatched;
  END IF;
END $$;
--> statement-breakpoint

-- ── 3. The constraint ───────────────────────────────────────────────────────────────────
-- ON DELETE CASCADE matches the existing doc_id foreign key: deleting a document already
-- takes its sections. ON UPDATE CASCADE covers a document moving between Memexes — the
-- sections follow rather than blocking the move or being orphaned into the old tenant.
ALTER TABLE doc_sections
  ADD CONSTRAINT doc_sections_doc_id_memex_id_fkey
  FOREIGN KEY (doc_id, memex_id) REFERENCES documents (id, memex_id)
  ON DELETE CASCADE ON UPDATE CASCADE;
