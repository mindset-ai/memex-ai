-- spec-293 t-4 (dec-4): one-time data backfill — collapse duplicate personal
-- Memexes left behind by the pre-fix signup race.
--
-- BACKGROUND. The concurrent-signup race that minted a second (and third)
-- personal Memex per user is already closed in code (spec-177:
-- services/user-namespaces.ts, ownership-first resolution + onConflictDoNothing).
-- This migration only cleans up the rows that race left on prod. The creation
-- path is not touched here.
--
-- POLICY (dec-4).
--   * Canonical = the personal Memex in the namespace users.namespaceId points at
--     (the one the user actually sees). Fallback to the OLDEST personal Memex if
--     that pointer is null or has no personal Memex.
--   * MERGE every duplicate's content INTO the canonical — no user content is ever
--     deleted. We reuse move_doc() (migration 0094) per document, so each doc and
--     ALL its doc-scoped artifacts travel and its handle is re-minted on collision
--     (documents_memex_id_handle_unique). move_doc is SECURITY DEFINER; this
--     migration runs as the table OWNER, which bypasses RLS — no GUC needed.
--   * Then DELETE the now-empty duplicate Memex (FK cascade clears its per-user
--     read-state: qa_report_views, user_memex_access, presence, …) and its orphaned
--     user-namespace (guarded: only if nothing else references it).
--
-- IDEMPOTENT. The driving query selects only users who still have >1 personal
-- Memex, so a second run is a no-op. Safe to re-run.
--
-- ROLLOUT (std-17). Ships int-first, green there before prod; capture a PITR
-- marker before the prod run (precedent spec-65). Post-migration invariant
-- (ac-14): zero users with >1 personal Memex — the SELECT at the bottom must
-- return 0 (also asserted by the integration test).

DO $$
DECLARE
  r_user      record;
  v_canonical uuid;
  r_dup       record;
  r_doc       record;
BEGIN
  FOR r_user IN
    SELECT n.owner_user_id AS user_id
      FROM namespaces n
      JOIN memexes m ON m.namespace_id = n.id AND m.slug = 'personal'
     WHERE n.kind = 'user' AND n.owner_user_id IS NOT NULL
     GROUP BY n.owner_user_id
    HAVING count(*) > 1
  LOOP
    -- Canonical: personal Memex in the namespace users.namespaceId references.
    SELECT m.id INTO v_canonical
      FROM users u
      JOIN namespaces n ON n.id = u.namespace_id
      JOIN memexes m ON m.namespace_id = n.id AND m.slug = 'personal'
     WHERE u.id = r_user.user_id;

    -- Fallback: the oldest personal Memex the user owns.
    IF v_canonical IS NULL THEN
      SELECT m.id INTO v_canonical
        FROM namespaces n
        JOIN memexes m ON m.namespace_id = n.id AND m.slug = 'personal'
       WHERE n.kind = 'user' AND n.owner_user_id = r_user.user_id
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT 1;
    END IF;

    -- Merge every NON-canonical personal Memex into the canonical, then remove it.
    FOR r_dup IN
      SELECT m.id AS memex_id, m.namespace_id
        FROM namespaces n
        JOIN memexes m ON m.namespace_id = n.id AND m.slug = 'personal'
       WHERE n.kind = 'user' AND n.owner_user_id = r_user.user_id
         AND m.id <> v_canonical
    LOOP
      -- Move each doc whole (handle re-minted in canonical by move_doc).
      FOR r_doc IN SELECT id FROM documents WHERE memex_id = r_dup.memex_id LOOP
        PERFORM move_doc(r_doc.id, r_dup.memex_id, v_canonical, r_user.user_id);
      END LOOP;

      -- The duplicate now holds no documents. Delete it; FK cascade clears its
      -- per-user read-state rows.
      DELETE FROM memexes WHERE id = r_dup.memex_id;

      -- Delete the orphaned user-namespace, but only if nothing else points at it.
      DELETE FROM namespaces n2
       WHERE n2.id = r_dup.namespace_id
         AND NOT EXISTS (SELECT 1 FROM memexes mm WHERE mm.namespace_id = n2.id)
         AND NOT EXISTS (SELECT 1 FROM users uu WHERE uu.namespace_id = n2.id)
         AND NOT EXISTS (SELECT 1 FROM orgs o WHERE o.namespace_id = n2.id);
    END LOOP;
  END LOOP;
END $$;

-- Post-migration invariant (ac-14): must be 0. (psql prints the count; the
-- integration test asserts it programmatically.)
DO $$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining FROM (
    SELECT n.owner_user_id
      FROM namespaces n
      JOIN memexes m ON m.namespace_id = n.id AND m.slug = 'personal'
     WHERE n.kind = 'user' AND n.owner_user_id IS NOT NULL
     GROUP BY n.owner_user_id
    HAVING count(*) > 1
  ) offenders;
  RAISE NOTICE 'spec-293 dedupe: % user(s) still with >1 personal Memex (expect 0)', v_remaining;
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'spec-293 dedupe left % user(s) with >1 personal Memex', v_remaining;
  END IF;
END $$;
