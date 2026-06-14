-- spec-293 t-1 (dec-1): RLS-sanctioned cross-tenant Spec move via a SECURITY
-- DEFINER function.
--
-- WHY A FUNCTION (the prod 500)
--   Moving a Spec re-points memex_id from tenant A to tenant B. The runtime role
--   `memex_app` is NOBYPASSRLS and every request is scoped to ONE app.memex_id
--   GUC (db/connection.ts), so the `*_memex_isolation` WITH CHECK (0081) rejects
--   `UPDATE … SET memex_id = <other tenant>` — that is the prod-only Internal
--   Server Error (it passes locally only because dev/tests connect as the table
--   OWNER, which bypasses RLS under ENABLE+NO FORCE, std-36 / 0093).
--
--   `move_doc` is owned by the table owner and marked SECURITY DEFINER, so its
--   body executes with owner privileges and bypasses RLS for this one sanctioned,
--   audited operation. memex_app gets EXECUTE on this function ONLY (below) — it
--   gains no general cross-tenant power. The authorization guard lives INSIDE the
--   function so privilege and guard cannot drift apart (dec-1).
--
-- WHAT MOVES (dec-2 / dec-3): the whole Spec. Every doc-scoped artifact that
--   carries a denormalised memex_id is re-pointed; the rest follow by FK:
--     re-pointed (memex_id):  documents, doc_comments (ALL targets — dec-3),
--       decisions, tasks, acs (brief_id), issues, doc_members, doc_assignees,
--       document_tags (document_id), clause_refs (source_doc_id)
--     follow by FK (no memex_id): doc_sections (doc_id), conversations (doc_id),
--       messages (conversation_id), ac_parent_links (ac_id), task_satisfies_ac
--     not tenant-scoped: test_events / test_event_latest are keyed by the AC's
--       text uid (the AC keeps its handle on move), so verification history
--       follows the AC with no row change.
--   Deliberately NOT touched (per-user / per-Memex read-state, not Spec content):
--     qa_report_views, presence, user_memex_access, mcp_tool_calls.
--
-- Errors (mapped to HTTP by services/doc-move.ts):
--   MX001 — document not found in source memex          → 404 (std-7)
--   MX002 — caller not authorized in source/target       → 404 (std-7, never 403)
--   MX003 — source and target memex are the same         → 400

-- Authorization helper: is p_user_id allowed in the memex p_memex_id? Owns the
-- namespace (personal) or holds an active org_membership in the owning org
-- (mirrors services/doc-move.ts:108-126). SECURITY DEFINER + owner so it reads
-- the tenancy tables regardless of RLS; STABLE (no writes).
CREATE OR REPLACE FUNCTION _memex_member(p_memex_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM memexes m
      JOIN namespaces n ON n.id = m.namespace_id
     WHERE m.id = p_memex_id
       AND (
         (n.kind = 'user' AND n.owner_user_id = p_user_id)
         OR (n.kind = 'org' AND n.owner_org_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM org_memberships om
               WHERE om.user_id = p_user_id
                 AND om.org_id = n.owner_org_id
                 AND om.status = 'active'
            ))
       )
  );
$$;

CREATE OR REPLACE FUNCTION move_doc(
  p_doc_id        uuid,
  p_from_memex_id uuid,
  p_to_memex_id   uuid,
  p_user_id       uuid
)
RETURNS TABLE (
  new_handle            text,
  revoked_share_tokens  integer,
  removed_decision_deps integer,
  removed_task_deps     integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_doc_type   text;
  v_handle     text;
  v_prefix     text;
  v_attempt    integer := 0;
  v_done       boolean := false;
BEGIN
  IF p_from_memex_id = p_to_memex_id THEN
    RAISE EXCEPTION 'source and target memex must differ' USING ERRCODE = 'MX003';
  END IF;

  -- Lock the doc in the source memex; 404 if it isn't there.
  SELECT doc_type INTO v_doc_type
    FROM documents
   WHERE id = p_doc_id AND memex_id = p_from_memex_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document % not found in source memex', p_doc_id USING ERRCODE = 'MX001';
  END IF;

  -- Authorization: the caller must be allowed in BOTH source and target Memex.
  -- (memexes / namespaces / org_memberships are not RLS-scoped tables.)
  IF NOT _memex_member(p_from_memex_id, p_user_id) THEN
    RAISE EXCEPTION 'not authorized in source memex' USING ERRCODE = 'MX002';
  END IF;
  IF NOT _memex_member(p_to_memex_id, p_user_id) THEN
    RAISE EXCEPTION 'not authorized in target memex' USING ERRCODE = 'MX002';
  END IF;

  -- Per doc-30 / spec-105: specs → spec-N, standards → std-N, everything else → doc-N.
  v_prefix := CASE v_doc_type WHEN 'spec' THEN 'spec' WHEN 'standard' THEN 'std' ELSE 'doc' END;

  -- Re-mint the handle in the TARGET memex. The MAX+1 read is racy against a
  -- concurrent create/move into the same memex; retry on the unique violation
  -- (documents_memex_id_handle_unique). Owner-context read sees the real target
  -- rows (the app role would be RLS-filtered to the source and mint wrong).
  WHILE NOT v_done LOOP
    v_attempt := v_attempt + 1;
    SELECT v_prefix || '-' || (
             coalesce(max(cast(substring(handle from (v_prefix || '-([0-9]+)')) as integer)), 0) + 1
           )
      INTO v_handle
      FROM documents
     WHERE memex_id = p_to_memex_id;
    BEGIN
      UPDATE documents
         SET memex_id = p_to_memex_id, handle = v_handle
       WHERE id = p_doc_id;
      v_done := true;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 25 THEN
        RAISE;  -- give up after persistent contention rather than spin forever
      END IF;
    END;
  END LOOP;

  -- Re-point every doc-scoped artifact carrying a denormalised memex_id (dec-2).
  -- doc_comments covers ALL comment targets via the denormalised doc_id (dec-3).
  -- standard_clauses holds a Standard doc's body (matters for the dedupe merge,
  -- where personal Memexes carry seeded default Standards).
  UPDATE standard_clauses SET memex_id = p_to_memex_id WHERE doc_id     = p_doc_id;
  UPDATE doc_comments  SET memex_id = p_to_memex_id WHERE doc_id        = p_doc_id;
  UPDATE decisions     SET memex_id = p_to_memex_id WHERE doc_id        = p_doc_id;
  UPDATE tasks         SET memex_id = p_to_memex_id WHERE doc_id        = p_doc_id;
  UPDATE acs           SET memex_id = p_to_memex_id WHERE brief_id      = p_doc_id;
  UPDATE issues        SET memex_id = p_to_memex_id WHERE doc_id        = p_doc_id;
  UPDATE doc_members   SET memex_id = p_to_memex_id WHERE doc_id        = p_doc_id;
  UPDATE doc_assignees SET memex_id = p_to_memex_id WHERE doc_id        = p_doc_id;
  UPDATE document_tags SET memex_id = p_to_memex_id WHERE document_id   = p_doc_id;
  UPDATE clause_refs   SET memex_id = p_to_memex_id WHERE source_doc_id = p_doc_id;
  -- doc_sections, conversations, messages, ac_parent_links, task_satisfies_ac
  -- carry no memex_id — they follow via their FK chain to the moved rows.

  -- Any dep edge that now straddles two memexes is structurally invalid (the
  -- blocked party can't see the blocker across the tenant wall). Silent-delete,
  -- return the counts so the UI can surface a toast. Whole-Spec moves keep
  -- intra-Spec edges intact; only edges to OTHER specs left behind can straddle.
  WITH del AS (
    DELETE FROM decision_deps dd
     USING tasks w, decisions d
     WHERE dd.task_id = w.id AND dd.decision_id = d.id
       AND w.memex_id <> d.memex_id
       AND (w.doc_id = p_doc_id OR d.doc_id = p_doc_id)
    RETURNING 1
  ) SELECT count(*) INTO removed_decision_deps FROM del;

  WITH del AS (
    DELETE FROM task_deps wd
     USING tasks w1, tasks w2
     WHERE wd.task_id = w1.id AND wd.depends_on_id = w2.id
       AND w1.memex_id <> w2.memex_id
       AND (w1.doc_id = p_doc_id OR w2.doc_id = p_doc_id)
    RETURNING 1
  ) SELECT count(*) INTO removed_task_deps FROM del;

  -- Public share URLs are source-scoped and would break after the move; revoke them.
  WITH upd AS (
    UPDATE share_tokens SET revoked = TRUE
     WHERE document_id = p_doc_id AND revoked = FALSE
    RETURNING 1
  ) SELECT count(*) INTO revoked_share_tokens FROM upd;

  new_handle := v_handle;
  RETURN NEXT;
END;
$$;

-- memex_app may CALL the move, nothing more. Revoke the implicit PUBLIC EXECUTE
-- so the cross-tenant seam is reachable only through this one granted path.
REVOKE ALL ON FUNCTION move_doc(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION _memex_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION move_doc(uuid, uuid, uuid, uuid) TO memex_app;
GRANT EXECUTE ON FUNCTION _memex_member(uuid, uuid) TO memex_app;
