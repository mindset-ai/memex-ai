-- spec-300: Skills in Memex — authorable, dispatchable agent capabilities.
-- Skills are docType='skill' rows in `documents` (dec-16), NOT a bespoke table.
-- This migration adds only the two additive pieces the documents model lacks:
--   1. a nullable `description` column on documents (the dispatch key, dec-12);
--   2. the `skill_files` child table — the auxiliary-file MANIFEST (dec-18/dec-19).
-- Both are additive and nullable; no backfill. Auxiliary-file BYTES never live in
-- Postgres (dec-19) — `text_content` holds small inline text, `blob_uri` points at
-- the StorageProvider. `checksum` makes files content-addressed for future
-- document versioning (spec-448) with no rework.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS description text;

CREATE TABLE IF NOT EXISTS skill_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_doc_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  path text NOT NULL,
  purpose text,
  content_type text NOT NULL,
  size integer NOT NULL,
  checksum text NOT NULL,
  storage_kind text NOT NULL,
  text_content text,
  blob_uri text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_files_storage_kind_valid CHECK (storage_kind IN ('inline', 'bucket')),
  CONSTRAINT skill_files_doc_path_unique UNIQUE (skill_doc_id, path)
);

CREATE INDEX IF NOT EXISTS skill_files_skill_doc_id_idx ON skill_files (skill_doc_id);
