-- Revert spec-257 dec-1: re-apply FORCE ROW LEVEL SECURITY on every tenant table.
--
-- WARNING: re-applying FORCE re-introduces the 2026-06-10 / 2026-06-11 outage
-- class — the deploy/migration role (`postgres`, NOBYPASSRLS on Cloud SQL) will
-- again be filtered to zero rows on any query without an app.memex_id GUC, so
-- migrations and deploy scripts 1c/1d/1e/1f silently break. Only revert if the
-- runtime/deploy role topology has changed such that the owner can bypass another
-- way. See 0091_rls_no_force_owner_bypass.sql and spec-257 dec-1.
ALTER TABLE acs             FORCE ROW LEVEL SECURITY;
ALTER TABLE clause_refs     FORCE ROW LEVEL SECURITY;
ALTER TABLE decisions       FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_assignees   FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_comments    FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_members     FORCE ROW LEVEL SECURITY;
ALTER TABLE document_tags   FORCE ROW LEVEL SECURITY;
ALTER TABLE documents       FORCE ROW LEVEL SECURITY;
ALTER TABLE issues          FORCE ROW LEVEL SECURITY;
ALTER TABLE presence        FORCE ROW LEVEL SECURITY;
ALTER TABLE qa_report_views FORCE ROW LEVEL SECURITY;
ALTER TABLE repos           FORCE ROW LEVEL SECURITY;
ALTER TABLE standard_clauses FORCE ROW LEVEL SECURITY;
ALTER TABLE tags            FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks           FORCE ROW LEVEL SECURITY;
