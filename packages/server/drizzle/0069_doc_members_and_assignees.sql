-- spec-118 t-1: per-Spec roles (editor/reviewer) + ticket-style assignment.
--
-- Two per-Spec relations layered ABOVE the org-level access gate — std-4 is
-- unchanged. Role decides capability + UI posture; assignment decides
-- responsibility. Neither narrows read access (a reviewer reads every field an
-- editor does). Modelled on the org_memberships / acs conventions: tenancy on
-- memex_id (NOT NULL, denormalised), parentage via doc_id → documents(id)
-- ON DELETE CASCADE, and user_id → users(id) ON DELETE CASCADE.
--
-- Named CHECK / UNIQUE constraints match the Drizzle schema's check()/unique()
-- names so introspection-by-conname and any future ALTER ... DROP CONSTRAINT
-- stay in lockstep (the migration-CHECK-name drift hazard).
--
-- Idempotent (IF NOT EXISTS) so the hand-migration runner can re-apply cleanly.

-- 1. doc_members — canonical per-Spec membership (spec-118 dec-1) ---------------
--
-- v1 writes only 'editor' rows; a member with NO row resolves to the implicit
-- 'reviewer' default (dec-6), so reading a Spec never writes a row.
-- UNIQUE(doc_id, user_id) makes promote an idempotent upsert and demote a delete
-- (dec-5). role CHECK is exactly {editor, reviewer} (ac-7 / ac-8).
CREATE TABLE IF NOT EXISTS doc_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id   UUID NOT NULL,
  doc_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  role       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT doc_members_doc_id_user_id_unique UNIQUE (doc_id, user_id),
  CONSTRAINT doc_members_role_valid CHECK (role IN ('editor', 'reviewer'))
);

CREATE INDEX IF NOT EXISTS doc_members_doc_id_idx  ON doc_members (doc_id);
CREATE INDEX IF NOT EXISTS doc_members_user_id_idx ON doc_members (user_id);

-- 2. doc_assignees — ticket-style assignment, INDEPENDENT of role (dec-3) -------
--
-- Assigning a user writes NO doc_members row; "owner" is subsumed by "assignee".
-- One-or-more assignees per Spec; UNIQUE(doc_id, user_id) makes assign idempotent
-- and unassign a delete. assigned_by records attribution (ON DELETE SET NULL so
-- removing the actor keeps the assignment). The user_id index backs the
-- "assigned to me" board filter (ac-19).
CREATE TABLE IF NOT EXISTS doc_assignees (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id    UUID NOT NULL,
  doc_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id)              ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT doc_assignees_doc_id_user_id_unique UNIQUE (doc_id, user_id)
);

CREATE INDEX IF NOT EXISTS doc_assignees_doc_id_idx  ON doc_assignees (doc_id);
CREATE INDEX IF NOT EXISTS doc_assignees_user_id_idx ON doc_assignees (user_id);
