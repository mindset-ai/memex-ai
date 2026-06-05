-- feat-ac-spike (V0.0.1): introduce Acceptance Criteria as a first-class primitive.
--
-- An AC is a forward-facing testable assertion about what the system must do.
-- Two flavours: 'scope' (manager-authored plain-English outcome commitments,
-- travel with the Brief body) and 'implementation' (agent-spawned from resolved
-- Decisions, technical, AI-coder territory). Both flavours share this shape.
-- See docs/ac-primitive-hypothesis.md for the full thesis.
--
-- Four new tables:
--   acs                  the AC primitive itself
--   ac_parent_links      polymorphic direct-parent edges (separate from tenancy)
--   task_satisfies_ac    many-to-many between Tasks and ACs
--   test_events          append-only log of pass/fail emissions tagged with ac_uid
--
-- Tenancy: every AC lives under exactly one Brief via acs.brief_id (NOT NULL,
-- ON DELETE CASCADE). Tenancy and direct parentage are separate concepts. The
-- ac_parent_links table records direct parentage for blast-radius cascades.

CREATE TABLE acs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id    UUID NOT NULL,
  brief_id    UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('scope', 'implementation')),
  statement   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('proposed', 'active', 'rejected', 'superseded')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acs_brief_id_seq_unique UNIQUE (brief_id, seq)
);

CREATE INDEX acs_memex_id_idx ON acs (memex_id);
CREATE INDEX acs_brief_id_idx ON acs (brief_id);

-- Polymorphic direct parentage. parent_kind tells you what parent_id references:
--   'brief'    → documents(id)   typical for Scope ACs
--   'decision' → decisions(id)   typical for Implementation ACs
-- Many-to-many: an AC can have multiple parents (rare but allowed for
-- cross-cutting Implementation ACs spawned from more than one Decision).
--
-- No FK on parent_id because it's polymorphic. Integrity is enforced at the
-- service layer; orphan rows are tolerable for V0.0.1.
--
-- Blast-radius cascades walk this table. The acs.brief_id tenancy column is
-- for scoping queries only and is NOT consulted for "what's affected if this
-- Decision is reopened?" — that question is answered by joining through here.
CREATE TABLE ac_parent_links (
  ac_id        UUID NOT NULL REFERENCES acs(id) ON DELETE CASCADE,
  parent_kind  TEXT NOT NULL CHECK (parent_kind IN ('brief', 'decision')),
  parent_id    UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ac_id, parent_kind, parent_id)
);

CREATE INDEX ac_parent_links_parent_idx ON ac_parent_links (parent_kind, parent_id);

-- Many-to-many between Tasks and ACs. A Task can contribute to multiple ACs;
-- an AC can have multiple Tasks satisfying it. The Task primitive itself stays
-- under the Brief — the existing tasks.doc_id FK is unchanged.
CREATE TABLE task_satisfies_ac (
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ac_id       UUID NOT NULL REFERENCES acs(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, ac_id)
);

CREATE INDEX task_satisfies_ac_ac_id_idx ON task_satisfies_ac (ac_id);

-- Test event emissions tagged with an AC reference. Append-only log of pass/fail
-- events posted to POST /api/test-events by tests in the codebase. The workspace
-- computes AC verification status from the latest event per (ac_uid,
-- test_identifier).
--
-- Deliberately no `tests` primitive in Memex: the codebase is the source of truth
-- for tests. ac_uid is a free-text reference (typically the AC's handle like
-- 'ac-12' or a canonical ref) that the workspace resolves at query time — kept
-- as text (not FK) so renamed or restructured ACs degrade gracefully rather
-- than silently dropping rows. test_identifier is whatever the test passes
-- (typically file path + function name) so emissions can be grouped by test
-- for flakiness analysis or staleness detection.
CREATE TABLE test_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ac_uid           TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'error')),
  test_identifier  TEXT,
  duration_ms      INTEGER,
  commit_sha       TEXT,
  run_id           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary lookups: latest event per AC, and per test for flakiness/staleness.
CREATE INDEX test_events_ac_uid_created_at_idx ON test_events (ac_uid, created_at DESC);
CREATE INDEX test_events_test_identifier_idx ON test_events (test_identifier, created_at DESC);
