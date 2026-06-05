-- doc-26 t-4 (part 1): replace the opaque (reference_type, reference_id) text
-- pair on doc_comments with four nullable structured FK columns — one per
-- referenceable entity kind (mission, standard, decision, task). Cross-reference
-- comments (commentType='cross_reference') now point at the target via FK
-- instead of an opaque handle string, so rendering can join through to fetch
-- the entity's CURRENT handle and survive any future handle-scheme rename
-- without a content sweep.
--
-- This migration adds the new columns + backfills from the legacy text pair +
-- adds the XOR CHECK constraint. The legacy reference_type / reference_id
-- columns are left in place; t-4 part 2 (a follow-up migration) drops them
-- AFTER the application layer has switched to the new columns (t-5).
--
-- Backfill rules:
--   reference_type='mission'   → reference_mission_id  (lookup documents by handle within same memex,
--                                                       restricted to doc_type='mission')
--   reference_type='standard'  → reference_standard_id (documents where doc_type='standard')
--   reference_type='decision'  → reference_decision_id (decisions where seq matches handle suffix)
--   reference_type='task'      → reference_task_id     (tasks where seq matches handle suffix)
--
-- Handle parsing tolerates BOTH the legacy lowercase forms (`doc-N` / `dec-N` /
-- `t-N` / `std-N`) and the post-rename uppercase forms (`M-N` / `D-N` / `T-N`).
-- documents.handle for missions is still `doc-N` at the time this migration
-- runs (the M-N rewrite is a later migration in the same release) — so the
-- mission backfill below joins on the LEGACY `doc-N` form.

-- ── 1. Add the four new FK columns (nullable). ─────────────────
ALTER TABLE "doc_comments"
  ADD COLUMN "reference_mission_id"  uuid REFERENCES "documents" ("id") ON DELETE CASCADE,
  ADD COLUMN "reference_standard_id" uuid REFERENCES "documents" ("id") ON DELETE CASCADE,
  ADD COLUMN "reference_decision_id" uuid REFERENCES "decisions" ("id") ON DELETE CASCADE,
  ADD COLUMN "reference_task_id"     uuid REFERENCES "tasks"     ("id") ON DELETE CASCADE;

-- ── 2. Backfill from the legacy text pair. ─────────────────────
-- Mission: handle is `doc-N` (legacy) or `M-N` (post-rename, in case this
-- runs after the M-N rewrite). The (memex_id, handle) unique constraint on
-- documents lets us match without disambiguation.
UPDATE "doc_comments" c
   SET "reference_mission_id" = d."id"
  FROM "documents" d
 WHERE c."reference_type" = 'mission'
   AND c."reference_id" IS NOT NULL
   AND d."memex_id" = c."memex_id"
   AND d."doc_type" = 'mission'
   AND d."handle" = c."reference_id";

-- Standard: handle is `std-N`.
UPDATE "doc_comments" c
   SET "reference_standard_id" = d."id"
  FROM "documents" d
 WHERE c."reference_type" = 'standard'
   AND c."reference_id" IS NOT NULL
   AND d."memex_id" = c."memex_id"
   AND d."doc_type" = 'standard'
   AND d."handle" = c."reference_id";

-- Decision: handle is `dec-N` or `D-N`. Decisions live under exactly one doc,
-- so `(memex_id, seq)` is NOT unique on its own — a `dec-3` exists in many
-- docs. We resolve by parsing the suffix and matching on memex_id + seq, but
-- a multi-doc memex with collisions can't be resolved without a doc handle in
-- the legacy text. In practice cross_reference comments emitted by the agent
-- have always carried the bare handle scoped to the doc the comment lives on,
-- so we scope the lookup further to the doc whose section/decision/task the
-- comment is attached to.
UPDATE "doc_comments" c
   SET "reference_decision_id" = d."id"
  FROM "decisions" d,
       "doc_sections" s
 WHERE c."reference_type" = 'decision'
   AND c."reference_id" IS NOT NULL
   AND c."section_id" = s."id"
   AND d."memex_id" = c."memex_id"
   AND d."doc_id" = s."doc_id"
   AND d."seq" = CAST(substring(c."reference_id" from '(?:dec|D)-([0-9]+)$') AS integer)
   AND substring(c."reference_id" from '(?:dec|D)-([0-9]+)$') IS NOT NULL;

UPDATE "doc_comments" c
   SET "reference_decision_id" = d."id"
  FROM "decisions" d, "decisions" hostd
 WHERE c."reference_type" = 'decision'
   AND c."reference_id" IS NOT NULL
   AND c."reference_decision_id" IS NULL
   AND c."decision_id" = hostd."id"
   AND d."memex_id" = c."memex_id"
   AND d."doc_id" = hostd."doc_id"
   AND d."seq" = CAST(substring(c."reference_id" from '(?:dec|D)-([0-9]+)$') AS integer)
   AND substring(c."reference_id" from '(?:dec|D)-([0-9]+)$') IS NOT NULL;

UPDATE "doc_comments" c
   SET "reference_decision_id" = d."id"
  FROM "decisions" d, "tasks" hostt
 WHERE c."reference_type" = 'decision'
   AND c."reference_id" IS NOT NULL
   AND c."reference_decision_id" IS NULL
   AND c."task_id" = hostt."id"
   AND d."memex_id" = c."memex_id"
   AND d."doc_id" = hostt."doc_id"
   AND d."seq" = CAST(substring(c."reference_id" from '(?:dec|D)-([0-9]+)$') AS integer)
   AND substring(c."reference_id" from '(?:dec|D)-([0-9]+)$') IS NOT NULL;

-- Task: handle is `t-N` or `T-N`. Same per-doc-seq scoping as decisions.
UPDATE "doc_comments" c
   SET "reference_task_id" = t."id"
  FROM "tasks" t,
       "doc_sections" s
 WHERE c."reference_type" = 'task'
   AND c."reference_id" IS NOT NULL
   AND c."section_id" = s."id"
   AND t."memex_id" = c."memex_id"
   AND t."doc_id" = s."doc_id"
   AND t."seq" = CAST(substring(c."reference_id" from '(?:t|T)-([0-9]+)$') AS integer)
   AND substring(c."reference_id" from '(?:t|T)-([0-9]+)$') IS NOT NULL;

UPDATE "doc_comments" c
   SET "reference_task_id" = t."id"
  FROM "tasks" t, "decisions" hostd
 WHERE c."reference_type" = 'task'
   AND c."reference_id" IS NOT NULL
   AND c."reference_task_id" IS NULL
   AND c."decision_id" = hostd."id"
   AND t."memex_id" = c."memex_id"
   AND t."doc_id" = hostd."doc_id"
   AND t."seq" = CAST(substring(c."reference_id" from '(?:t|T)-([0-9]+)$') AS integer)
   AND substring(c."reference_id" from '(?:t|T)-([0-9]+)$') IS NOT NULL;

UPDATE "doc_comments" c
   SET "reference_task_id" = t."id"
  FROM "tasks" t, "tasks" hostt
 WHERE c."reference_type" = 'task'
   AND c."reference_id" IS NOT NULL
   AND c."reference_task_id" IS NULL
   AND c."task_id" = hostt."id"
   AND t."memex_id" = c."memex_id"
   AND t."doc_id" = hostt."doc_id"
   AND t."seq" = CAST(substring(c."reference_id" from '(?:t|T)-([0-9]+)$') AS integer)
   AND substring(c."reference_id" from '(?:t|T)-([0-9]+)$') IS NOT NULL;

-- ── 3. CHECK constraint: cross_reference rows must point at exactly one ─────
-- Existing cross_reference rows that backfilled to nothing (un-resolvable
-- handle) would violate this — we relax the constraint to "at most one" for
-- pre-existing rows by only enforcing it when ANY ref column is set; service
-- layer (t-5) enforces "exactly one" on writes.
ALTER TABLE "doc_comments"
  ADD CONSTRAINT "doc_comments_cross_reference_target"
  CHECK (
    "comment_type" <> 'cross_reference'
    OR (
      (CASE WHEN "reference_mission_id"  IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "reference_standard_id" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "reference_decision_id" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "reference_task_id"     IS NOT NULL THEN 1 ELSE 0 END
      ) <= 1
    )
  );
