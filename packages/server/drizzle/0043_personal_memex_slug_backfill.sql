-- Backfill: personal memex slug from legacy 'default' to canonical 'personal'.
-- Migration 0038 used 'default' as a placeholder for both personal and org
-- memexes; services/user-namespaces.ts writes 'personal' for new personal
-- memexes on signup. This reconciles existing rows so the URL shape is
-- consistent (/<user-namespace>/personal/...).
--
-- Scope: user-kind namespaces only. Org memexes are intentionally left
-- alone here — the org slug ('main' for new orgs, 'default' for legacy
-- migration-0038 rows) is a separate concern.
--
-- Idempotent: rows already on 'personal' are untouched.

UPDATE memexes m
SET slug = 'personal'
FROM namespaces n
WHERE n.id = m.namespace_id
  AND n.kind = 'user'
  AND m.slug = 'default';
