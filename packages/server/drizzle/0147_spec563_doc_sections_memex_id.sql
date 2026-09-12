-- spec-563 t-4 (ac-3) — doc_sections carries its own memex_id.
--
-- THE SURVIVING INSTANCE. spec-563 set out to fix "the tenant recovered through a join
-- instead of read from the table". For test_events that had already been repaired by
-- spec-396/spec-398 and the Spec was wrong about it. For doc_sections it is still true, and
-- this is the only arm where it is:
--
--     ( SELECT pd.memex_id FROM documents pd WHERE pd.id = s.doc_id) AS memex_id
--       FROM doc_sections s
--
-- Every other activity-bearing table — acs, tasks, decisions, doc_comments, test_events,
-- activity_log — carries `memex_id uuid NOT NULL` as a first-class column [std-32: load-
-- bearing fields are columns, not derivations]. doc_sections is the odd one out, and
-- schema.ts said so in a comment rather than fixing it.
--
-- ⚠ THIS IS A CONSISTENCY REPAIR, NOT A PERFORMANCE FIX — and that was MEASURED, not
-- assumed. The worry on the task was that home-specs.ts reads activity_view WITHOUT a spec
-- filter, so the correlated subplan would run once per section across the whole Memex.
-- EXPLAIN says otherwise:
--
--     Index Scan using doc_sections_actor_created_at_idx on doc_sections s
--       Index Cond: (s.actor_user_id = $0)
--       Filter: (... AND (SubPlan 3) = $1)
--
-- `actor_user_id` is an INDEX CONDITION, so the subplan only ever runs on rows that
-- already survived it — bounded by one user's sections, not the Memex's. Sizing this as a
-- latency fix would have been the same error this Spec exists to correct, one table over.
--
-- NO NEW INDEX. The footer read reaches doc_sections by doc_id and home-specs by
-- actor_user_id; both already have one, and after this change `memex_id` is a cheap column
-- check rather than a subquery. Adding an index "for the tenancy filter" would cost a tuple
-- per insert forever to serve no measured reader [std-39]. If one is needed later, a
-- measurement will say so.

-- ── 1. The column ───────────────────────────────────────────────────────────────────────
ALTER TABLE doc_sections ADD COLUMN IF NOT EXISTS memex_id uuid;
--> statement-breakpoint

UPDATE doc_sections s
   SET memex_id = d.memex_id
  FROM documents d
 WHERE d.id = s.doc_id
   AND s.memex_id IS NULL;
--> statement-breakpoint

-- An orphan section would block SET NOT NULL. doc_id references documents, so there should
-- be none — which is exactly why a surprise here is a finding and not something to paper
-- over with a DELETE. Fail loudly and let a human look.
DO $$
DECLARE orphans bigint;
BEGIN
  SELECT count(*) INTO orphans FROM doc_sections WHERE memex_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'spec-563: % doc_sections rows have no resolvable document. Investigate before '
      'forcing NOT NULL — deleting them here would destroy activity history silently.',
      orphans;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE doc_sections ALTER COLUMN memex_id SET NOT NULL;
--> statement-breakpoint

-- ── 2. The view arm reads the column ────────────────────────────────────────────────────
--
-- ⚠ CAPTURED AND PATCHED, NOT RESTATED. activity_view is defined across six migrations and
-- 0142 recreates it dynamically from pg_get_viewdef WITHOUT carrying its text — so "the
-- last migration that defines it" is not a readable source [spec-564]. Retyping the whole
-- body here would silently revert anything live that this file's author did not know about.
-- Instead: read the live definition, patch the one arm by regex, and REFUSE to proceed if
-- the patch did not apply. A silent no-op is the failure mode being designed against.
DO $$
DECLARE
  old_def text;
  new_def text;
BEGIN
  SELECT pg_get_viewdef('activity_view'::regclass, true) INTO old_def;

  new_def := regexp_replace(
    old_def,
    '\(\s*SELECT\s+pd\.memex_id\s+FROM\s+documents\s+pd\s+WHERE\s+pd\.id\s*=\s*s\.doc_id\s*\)',
    's.memex_id',
    'g');

  IF new_def = old_def THEN
    RAISE EXCEPTION
      'spec-563: the doc_sections correlated subquery was not found in the live '
      'activity_view definition. It may already be repaired, or rendered differently. '
      'Read pg_get_viewdef(''activity_view''::regclass, true) and adjust this migration '
      'rather than letting it succeed having changed nothing.';
  END IF;

  IF new_def NOT LIKE '%s.memex_id%' THEN
    RAISE EXCEPTION 'spec-563: patched view definition does not read s.memex_id: %', new_def;
  END IF;

  -- DROP + CREATE rather than CREATE OR REPLACE: replace refuses any change to the output
  -- column list, and while this change keeps it identical, the drop makes a mismatch a
  -- loud error here instead of a subtle one later. security_invoker is re-stated because
  -- it does NOT survive a drop — losing it would silently disable the RLS posture std-36
  -- depends on.
  DROP VIEW activity_view;
  EXECUTE format('CREATE VIEW activity_view WITH (security_invoker = true) AS %s', new_def);
END $$;
--> statement-breakpoint

-- ── 3. Assert the result, rather than trusting the block above ──────────────────────────
DO $$
DECLARE
  def          text;
  invoker      boolean;
BEGIN
  SELECT pg_get_viewdef('activity_view'::regclass, true) INTO def;

  IF def LIKE '%FROM documents pd%' THEN
    RAISE EXCEPTION 'spec-563: the doc_sections correlated subquery is still present: %', def;
  END IF;

  SELECT COALESCE((SELECT option_value::boolean
                     FROM pg_options_to_table(c.reloptions)
                    WHERE option_name = 'security_invoker'), false)
    INTO invoker
    FROM pg_class c WHERE c.oid = 'activity_view'::regclass;

  IF NOT invoker THEN
    RAISE EXCEPTION
      'spec-563: activity_view lost security_invoker in the recreate. The runtime role '
      'would read it as the owner and bypass RLS [std-36].';
  END IF;
END $$;
