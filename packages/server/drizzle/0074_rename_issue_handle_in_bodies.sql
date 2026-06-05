-- spec-158 t-1: rewrite the legacy issue child handle `i-N` → `issue-N` inside
-- stored free-text bodies.
--
-- The canonical issue handle changed shape (services/refs.ts CHILD_HANDLE_PREFIX:
-- "i" → "issue"; canonical refs are now `.../specs/spec-N/issues/issue-N`). Per
-- dec-3 this is a HARD cutover with no backwards-compat alias — the product is
-- unreleased — so any literal `i-N` issue token already sitting in a stored body
-- would dangle (the parser no longer accepts the bare form). This sweep rewrites
-- those tokens to the new form in the two columns that carry agent/human prose:
--   * doc_sections.content
--   * doc_comments.content
--
-- The transform is also implemented (and unit-tested) in TypeScript at
-- services/shared/issue-handle-rewrite.ts — the two MUST stay in lock-step. The
-- two regexes below mirror ISSUE_PATH_RE and ISSUE_PROSE_RE semantically
-- (Postgres `\y` word boundaries stand in for JavaScript's `\b`; equivalent for
-- the [a-z0-9-] token shapes involved, not byte-for-byte identical syntax).
--
-- CONSERVATIVE BY DESIGN. `i-N` is a generic token — it collides with ordinary
-- prose ("i-beam", "wi-fi") and with nothing the rewrite should touch outside the
-- two shapes the server itself emits:
--   1. PATH form  `<...>/issues/i-N`  — the `/issues/` segment proves it's an Issue.
--   2. PROSE form `Issue i-N` / `issue i-N` — the leading word disambiguates.
-- Bare `i-N` in arbitrary prose, dec-3, t-1, i-beam, wi-fi are LEFT ALONE.
--
-- This is a pure UPDATE (no DDL), so the Postgres-auto-named-CHECK drift gotcha
-- (project memory) doesn't apply. Idempotent: re-running over an already-rewritten
-- body is a no-op (the new `/issues/issue-N` / `Issue issue-N` forms no longer
-- match the legacy patterns). Each replace is guarded by a matching WHERE so we
-- only write rows that actually carry a legacy token.

-- 1. doc_sections.content -----------------------------------------------------
--    Path form first, then prose form, in a single UPDATE so a body carrying both
--    is rewritten once. The `~` predicate restricts the write to rows that match.
UPDATE doc_sections
SET content = regexp_replace(
                regexp_replace(content, '/issues/i-(\d+)\y', '/issues/issue-\1', 'g'),
                '\y(Issue|issue) i-(\d+)\y', '\1 issue-\2', 'g'
              )
WHERE content ~ '/issues/i-\d+\y'
   OR content ~ '\y(Issue|issue) i-\d+\y';

-- 2. doc_comments.content -----------------------------------------------------
UPDATE doc_comments
SET content = regexp_replace(
                regexp_replace(content, '/issues/i-(\d+)\y', '/issues/issue-\1', 'g'),
                '\y(Issue|issue) i-(\d+)\y', '\1 issue-\2', 'g'
              )
WHERE content ~ '/issues/i-\d+\y'
   OR content ~ '\y(Issue|issue) i-\d+\y';
