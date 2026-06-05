-- 0063_brief_to_spec.sql
-- b-105: Full migration: Brief → Spec
-- - docType 3-state sweep ('brief' | 'mission' | 'strategy' → 'spec')
-- - regexp_replace over document_sections.body, decisions.context, decisions.resolution, comments.body
-- - Allowlist: documents with handles b-10, b-26, b-65, b-105 (their prose remembers the prior names)
-- Atomic; runs in pre-deploy hook.
--
-- Implementation notes:
--   * The brief named the columns conceptually as `document_sections.body` and
--     `comments.body` — the actual columns in db/schema.ts are
--     `doc_sections.content` and `doc_comments.content`. We use the real names.
--   * Allowlist matching is by Brief HANDLE (b-10, b-26, b-65, b-105). At this
--     migration's time the doc_type column still has 'brief' for most Briefs
--     and may carry 'spec' for any row already flipped; the CTE accepts either
--     to stay replay-safe.
--   * Per dec-3 / ac-10 of b-105, no legacy "strategy"/"mission" alias block
--     remains anywhere — we sweep them out of prose too.
--   * Word boundaries use Postgres regex `\m` (start-of-word) / `\M`
--     (end-of-word), matching the convention established in 0051.
--   * Rewrites are split into separate UPDATEs so each step is independently
--     auditable in EXPLAIN / pg_stat. URL-path rewrites run BEFORE bare-handle
--     rewrites so we don't double-rewrite the `briefs/` segment.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- Step 1a — docType 3-state sweep.
-- ════════════════════════════════════════════════════════════════════════
-- Eager rename per dec-3: every doc_type that used to mean "Brief" flips to
-- 'spec'. 'mission' and 'strategy' are caught for defence-in-depth in case
-- this migration runs against a DB snapshot from before 0049.
UPDATE "documents"
   SET "doc_type" = 'spec'
 WHERE "doc_type" IN ('brief', 'mission', 'strategy');

-- ════════════════════════════════════════════════════════════════════════
-- Step 1b — handle prefix migration: b-N → spec-N.
-- ════════════════════════════════════════════════════════════════════════
-- Per dec-3, the handle string itself migrates in lockstep with the
-- prefix-table change in services/refs.ts (briefs:'b' → specs:'spec'). The
-- URL resolver does an exact string match on documents.handle, so the
-- column value must flip from 'b-N' to 'spec-N' for /specs/spec-N URLs to
-- resolve. The seq column is unchanged (only the textual prefix moves).
--
-- Allowlisted Specs (b-10, b-26, b-65, b-105) DO migrate their handle (the
-- handle is computed identity, not body prose); their section bodies are
-- the carve-out, not their handles. Per dec-12 this Spec's own b-105 →
-- spec-105 happens atomically here.
--
-- Constraint: documents has a UNIQUE (memex_id, doc_type, handle). Step 1a
-- has already flipped doc_type to 'spec' for every prior brief/mission/
-- strategy row, so the new 'spec-N' handles collide only with existing
-- 'spec-N' rows. If pre-b-105 'spec'-typed rows already used 'spec-N'
-- handles, abort (Step 1c verifies this).
UPDATE "documents"
   SET "handle" = 'spec-' || substring("handle" FROM 3)
 WHERE "doc_type" = 'spec'
   AND "handle" ~ '^b-[0-9]+$';

-- Step 1c — verify no handle survived the rewrite. Defensive: catches
-- pre-b-105 collisions where a 'spec'-typed row already owned a spec-N
-- handle that conflicts with a freshly-renamed b-N → spec-N.
DO $$
DECLARE
  stale_b_handles INTEGER;
BEGIN
  SELECT count(*) INTO stale_b_handles
    FROM documents WHERE doc_type = 'spec' AND handle ~ '^b-[0-9]+$';
  IF stale_b_handles > 0 THEN
    RAISE EXCEPTION
      'b-105 Step 1b: % handle(s) still have b-N prefix after rewrite — likely UNIQUE collision rolled back the update',
      stale_b_handles;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- Step 2 — prose sweep across section / decision / comment text.
-- ════════════════════════════════════════════════════════════════════════
-- The allowlist resolves the four Briefs whose narrative INTENTIONALLY
-- records the prior names ("this Brief retired the Mission → Brief →
-- Spec lineage…"). Their rows are excluded from every rewrite below.
--
-- Allowlist is matched by handle (b-10, b-26, b-65, b-105). doc_type is
-- accepted as 'spec' or 'brief' — Step 1 above will have flipped them to
-- 'spec' inside this transaction, but the OR keeps the CTE replay-safe.

-- ── doc_sections — six ordered rewrites over content. ──────────────────

-- 1. URL paths `briefs/b-N` → `specs/spec-N`. Must run before bare-handle
--    rewrite so the `b-N` inside the path isn't half-rewritten first.
WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_sections"
   SET "content" = regexp_replace("content", '\mbriefs/b-(\d+)\M', 'specs/spec-\1', 'gi')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

-- 2. Bare handles `b-N` → `spec-N`.
WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_sections"
   SET "content" = regexp_replace("content", '\mb-(\d+)\M', 'spec-\1', 'gi')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

-- 3. `Briefs` → `Specs` (plural, capitalised).
WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_sections"
   SET "content" = regexp_replace("content", '\mBriefs\M', 'Specs', 'g')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

-- 4. `briefs` → `specs` (plural, lowercase).
WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_sections"
   SET "content" = regexp_replace("content", '\mbriefs\M', 'specs', 'g')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

-- 5. `Brief` → `Spec` (singular, capitalised).
WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_sections"
   SET "content" = regexp_replace("content", '\mBrief\M', 'Spec', 'g')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

-- 6. `brief` → `spec` (singular, lowercase).
WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_sections"
   SET "content" = regexp_replace("content", '\mbrief\M', 'spec', 'g')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

-- ── decisions.context — same six rewrites, scoped by doc_id. ───────────

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "context" = regexp_replace("context", '\mbriefs/b-(\d+)\M', 'specs/spec-\1', 'gi')
 WHERE "context" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "context" = regexp_replace("context", '\mb-(\d+)\M', 'spec-\1', 'gi')
 WHERE "context" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "context" = regexp_replace("context", '\mBriefs\M', 'Specs', 'g')
 WHERE "context" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "context" = regexp_replace("context", '\mbriefs\M', 'specs', 'g')
 WHERE "context" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "context" = regexp_replace("context", '\mBrief\M', 'Spec', 'g')
 WHERE "context" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "context" = regexp_replace("context", '\mbrief\M', 'spec', 'g')
 WHERE "context" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

-- ── decisions.resolution — same six rewrites, scoped by doc_id. ────────

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "resolution" = regexp_replace("resolution", '\mbriefs/b-(\d+)\M', 'specs/spec-\1', 'gi')
 WHERE "resolution" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "resolution" = regexp_replace("resolution", '\mb-(\d+)\M', 'spec-\1', 'gi')
 WHERE "resolution" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "resolution" = regexp_replace("resolution", '\mBriefs\M', 'Specs', 'g')
 WHERE "resolution" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "resolution" = regexp_replace("resolution", '\mbriefs\M', 'specs', 'g')
 WHERE "resolution" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "resolution" = regexp_replace("resolution", '\mBrief\M', 'Spec', 'g')
 WHERE "resolution" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "decisions"
   SET "resolution" = regexp_replace("resolution", '\mbrief\M', 'spec', 'g')
 WHERE "resolution" IS NOT NULL
   AND "doc_id" NOT IN (SELECT id FROM allowlist);

-- ── doc_comments.content — same six rewrites, scoped by doc_id. ────────

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_comments"
   SET "content" = regexp_replace("content", '\mbriefs/b-(\d+)\M', 'specs/spec-\1', 'gi')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_comments"
   SET "content" = regexp_replace("content", '\mb-(\d+)\M', 'spec-\1', 'gi')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_comments"
   SET "content" = regexp_replace("content", '\mBriefs\M', 'Specs', 'g')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_comments"
   SET "content" = regexp_replace("content", '\mbriefs\M', 'specs', 'g')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_comments"
   SET "content" = regexp_replace("content", '\mBrief\M', 'Spec', 'g')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

WITH allowlist AS (
  SELECT id FROM documents
   WHERE doc_type IN ('spec', 'brief')
     AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
)
UPDATE "doc_comments"
   SET "content" = regexp_replace("content", '\mbrief\M', 'spec', 'g')
 WHERE "doc_id" NOT IN (SELECT id FROM allowlist);

-- ════════════════════════════════════════════════════════════════════════
-- Step 3 — self-verification.
-- ════════════════════════════════════════════════════════════════════════
-- After the rewrites above, no non-allowlisted row should still contain a
-- bare `brief`, `briefs`, or `b-N` token (the noun-and-handle shapes the
-- rewrites covered). If any do, the rewrites missed something and we abort
-- the whole transaction so the migration is its own post-condition test.
--
-- Scope intentionally narrower than the codebase guard test's regex
-- (\b(brief|mission|strategy)\b): the body rewrites only sweep the Brief
-- family. `mission` and `strategy` are swept on `documents.doc_type` by
-- Step 1 (verified below), but their occurrence as English prose nouns
-- inside Spec bodies, decisions, and comments (e.g. "marketing strategy",
-- "Our mission is…") is legitimate and out of scope for this migration.
-- Step 1 alone covers the docType contract; prose mission/strategy lives
-- on for the same reason "summary"-sense `brief` is exempt — the user
-- writes their Specs in English.
--
-- Allowlisted historical Specs (b-10, b-26, b-65, b-105) are excluded
-- because their narratives intentionally preserve the prior vocabulary.
DO $$
DECLARE
  prose_hits INTEGER;
  doctype_hits INTEGER;
BEGIN
  WITH allowlist AS (
    SELECT id FROM documents
     WHERE doc_type IN ('spec', 'brief')
       AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')
  ),
  hits AS (
    SELECT 1
      FROM doc_sections s
     WHERE s.doc_id NOT IN (SELECT id FROM allowlist)
       AND s.content ~* '\m(brief|briefs|b-[0-9]+)\M'
    UNION ALL
    SELECT 1
      FROM decisions d
     WHERE d.doc_id NOT IN (SELECT id FROM allowlist)
       AND (
            (d.context    IS NOT NULL AND d.context    ~* '\m(brief|briefs|b-[0-9]+)\M')
         OR (d.resolution IS NOT NULL AND d.resolution ~* '\m(brief|briefs|b-[0-9]+)\M')
       )
    UNION ALL
    SELECT 1
      FROM doc_comments c
     WHERE c.doc_id NOT IN (SELECT id FROM allowlist)
       AND c.content ~* '\m(brief|briefs|b-[0-9]+)\M'
  )
  SELECT count(*) INTO prose_hits FROM hits;

  -- Defensive: also confirm Step 1's docType sweep didn't miss anything.
  SELECT count(*) INTO doctype_hits
    FROM documents WHERE doc_type IN ('brief', 'mission', 'strategy');

  IF prose_hits > 0 OR doctype_hits > 0 THEN
    RAISE EXCEPTION
      'b-105 migration self-check failed: % non-allowlisted prose hit(s) + % stale doc_type row(s) remain',
      prose_hits, doctype_hits;
  END IF;
END $$;

COMMIT;
