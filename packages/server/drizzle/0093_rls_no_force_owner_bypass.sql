-- spec-257 dec-1: drop FORCE on every tenant table — restore owner-bypass.
--
-- WHAT THIS CHANGES
--   For each FORCE'd tenant table: ALTER TABLE ... NO FORCE ROW LEVEL SECURITY.
--   RLS stays ENABLED and every memex_id isolation policy (0081/0086) stays in
--   place. The ONLY change is removing FORCE.
--
-- WHY (the posture, settled in spec-257 dec-1 on verified grounding)
--   Postgres RLS does not apply to a table's OWNER unless FORCE is set. On
--   Cloud SQL the deploy/migration role connects as `postgres`, which — verified
--   read-only on prod AND int 2026-06-11 — is NOT a superuser and does NOT hold
--   BYPASSRLS (rolsuper=f, rolbypassrls=f). It owns all of these tables. So
--   migration 0081's ENABLE+FORCE made RLS apply to the owner too, and every
--   query the owner runs WITHOUT an app.memex_id GUC is filtered to zero rows.
--
--   Two production outages came from this single false assumption that the
--   "superuser" deploy path bypasses RLS:
--     * 2026-06-10 — emission outage: 0081's FORCE policy on memex_emission_keys
--       filtered verifyEmissionKey() to 0 rows once the runtime cut to memex_app
--       (fixed by 0087, which fully excluded that identity table).
--     * 2026-06-11 — What's New ribbon dark on prod: deploy.sh step 1f
--       (db:generate-whats-new) runs as `postgres` and read `documents` with no
--       GUC → "judged 0 of 0 shippable specs" against ~70 eligible. Three sibling
--       deploy scripts (1c handhold-demo, 1d default-standards, 1e guide-content)
--       were silently failing the same way behind their `|| echo` wrappers.
--
--   NO FORCE puts RLS at the correct trust boundary:
--     * `postgres` (table OWNER, the migration/admin/deploy identity) bypasses
--       RLS as owner — so all migrations and deploy scripts work with no
--       per-script changes. Granting BYPASSRLS instead is impossible on Cloud SQL
--       (no superuser to grant it); wrapping every script in runWithMemexId was
--       rejected as fragile (spec-257 dec-1 options B/C).
--     * `memex_app` (runtime role, non-owner, NOBYPASSRLS — verified) remains
--       SUBJECT to RLS, so runtime tenant isolation is unchanged. Confirm via the
--       spec-199 cross-tenant regression tests run under the memex_app role.
--
-- LOAD-BEARING INVARIANT (spec-257 dec-1 caveat / Standard ac-5)
--   This is safe ONLY while the runtime never connects as the owner role. RLS
--   silently stops firing for any runtime path pointed at postgres/DB_USER
--   credentials. The deploy split already enforces this (RUNTIME_DB_USER=memex_app
--   vs DB_USER=postgres in deploy.sh); spec-257 dec-3 adds a structural guard.
--
-- Tables below = every table FORCE'd on develop as of 2026-06-12. The 14
-- currently-FORCE'd tables on prod were verified by read-only query
-- (relforcerowsecurity=true) 2026-06-11; `qa_report_views` was added with
-- ENABLE+FORCE by 0092 (spec-260) AFTER that query and is included here — files
-- run 0092→0093 in order, so the table exists by the time this applies.
-- (`memex_emission_keys` already excluded by 0087; `activity_log` never FORCE'd.)
--
-- NOTE: spec-260's 0092 reintroduced the FORCE pattern days after the outages it
-- causes — nothing prevented it. spec-257 dec-3 (a structural lint/CI guard) and
-- ac-5 (the Standard) are what stop the next one; this migration only cleans up
-- the 15 that exist today.
ALTER TABLE acs             NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clause_refs     NO FORCE ROW LEVEL SECURITY;
ALTER TABLE decisions       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_assignees   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_comments    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_members     NO FORCE ROW LEVEL SECURITY;
ALTER TABLE document_tags   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE documents       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE issues          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE presence        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE qa_report_views NO FORCE ROW LEVEL SECURITY;
ALTER TABLE repos           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE standard_clauses NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tags            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks           NO FORCE ROW LEVEL SECURITY;
