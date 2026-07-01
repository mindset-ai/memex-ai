-- spec-14 (memex-backstage) — GRANT UPDATE on public.experiments to memex_admin.
-- The Backstage "Experiments" operator tab switches an experiment on/off by writing
-- experiments.status. Backstage connects as the memex_admin BYPASSRLS role, which is
-- read-oriented today (it SELECTs public.* cross-tenant but does not write it). The
-- experiments cluster is platform-global, operator-owned and RLS-excluded (spec-426,
-- 0116_add_experiments.sql), so a status flip is operator-plane state, not a tenant
-- mutation — Backstage performs it as a direct, audited UPDATE under memex_admin
-- (spec-14 dec-3), pairing it with an audit row in Backstage's own admin schema. That
-- UPDATE needs this grant; without it the write fails with "permission denied for
-- table experiments". Core owns public.experiments, so the grant ships here as a
-- forward-only hand migration (std-9: DDL against int/prod Cloud SQL is CI/migration
-- only, never hand-run). SELECT is already available to memex_admin; this adds only
-- UPDATE, and only on experiments — NOT experiment_variants / experiment_assignments,
-- which Backstage only reads. GRANT is idempotent, so a re-run is a no-op.
--
-- ROLE GUARD: `memex_admin` is a Backstage-infra role that exists in the shared prod
-- database (where Backstage connects as it) but NOT in core's CI / local test
-- containers — and core migrations otherwise never reference it. A bare GRANT there
-- fails with "role memex_admin does not exist" and breaks the migration runner. So we
-- grant only when the role is present: a no-op in CI/local, the real grant in prod.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'memex_admin') then
    grant update on public.experiments to memex_admin;
  end if;
end $$;
