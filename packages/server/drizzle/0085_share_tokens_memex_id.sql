-- spec-199 t-14: share_tokens needs memex_id to bootstrap ALS context on the
-- public share endpoint (no session middleware, no currentMemexId). Without it,
-- getSharedDocumentByToken cannot call runWithMemexId before querying RLS-gated
-- tables, so every valid share link returns 404 under memex_app.
ALTER TABLE share_tokens
  ADD COLUMN memex_id uuid REFERENCES memexes(id) ON DELETE CASCADE;

UPDATE share_tokens
  SET memex_id = documents.memex_id
  FROM documents
  WHERE share_tokens.document_id = documents.id;

ALTER TABLE share_tokens
  ALTER COLUMN memex_id SET NOT NULL;
