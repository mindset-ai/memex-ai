-- Backfill: org memex slug from legacy 'default' to canonical 'main'.
-- Migration 0038 wrote 'default' as a placeholder for orgs created during
-- the t-10 data move; services/orgs.ts writes 'main' for new orgs. This
-- reconciles existing rows so the URL shape is consistent
-- (/<org-namespace>/main/...).

UPDATE memexes m
SET slug = 'main'
FROM namespaces n
WHERE n.id = m.namespace_id
  AND n.kind = 'org'
  AND m.slug = 'default';
