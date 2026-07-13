-- spec-474 dec-6 — content-provisioning marker on Memexes.
--
-- NULL = the onboarding content seed (default facets + default Standards + the
-- "Understanding Memex" starter Spec) has NOT yet run for this Memex. That seed used
-- to run synchronously on the signup request (awaited inside ensureUserNamespace),
-- which delayed the signup response and the verification email. It now runs on an
-- explicit first-load readiness endpoint (POST /api/me/provision) that the SPA drives
-- behind a "Getting your Memex ready…" blocker, so nothing seed-heavy sits on the
-- signup path. That request carries its own Cloud Run CPU allocation, sidestepping the
-- post-response throttle that forced the old await (no empty-Memex regression).
--
-- Existing Memexes already carry their content, so backfill them to now() — only
-- NET-NEW Memexes come up NULL and get provisioned on first load. Additive + nullable;
-- the only lock is the one-time backfill UPDATE (std-39).
ALTER TABLE memexes ADD COLUMN IF NOT EXISTS provisioned_at timestamptz;
UPDATE memexes SET provisioned_at = now() WHERE provisioned_at IS NULL;
