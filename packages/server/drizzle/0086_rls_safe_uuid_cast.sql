-- spec-199 t-14: Fix RLS policy uuid cast — nullif guard
--
-- Migration 0081 created USING/WITH CHECK clauses of the form:
--
--   nullif(current_setting('app.memex_id', true), '') IS NOT NULL
--   AND memex_id = current_setting('app.memex_id', true)::uuid
--
-- PostgreSQL does NOT guarantee short-circuit AND evaluation, so when
-- app.memex_id is unset (returns ''), the second operand evaluates
-- current_setting(...)::uuid = ''::uuid which throws:
--
--   ERROR: invalid input syntax for type uuid: ""
--
-- Fix: wrap the cast side in the same nullif so the empty-string case
-- produces NULL::uuid = NULL (falsy, row blocked) instead of an error.
-- The IS NOT NULL guard is kept for readability / defence-in-depth.

ALTER POLICY documents_memex_isolation ON documents
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY standard_clauses_memex_isolation ON standard_clauses
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY clause_refs_memex_isolation ON clause_refs
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY doc_comments_memex_isolation ON doc_comments
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY decisions_memex_isolation ON decisions
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY tasks_memex_isolation ON tasks
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY acs_memex_isolation ON acs
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY issues_memex_isolation ON issues
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY doc_members_memex_isolation ON doc_members
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY doc_assignees_memex_isolation ON doc_assignees
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY tags_memex_isolation ON tags
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY document_tags_memex_isolation ON document_tags
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY memex_emission_keys_memex_isolation ON memex_emission_keys
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );

ALTER POLICY repos_memex_isolation ON repos
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );
