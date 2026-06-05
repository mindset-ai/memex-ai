-- spec-179 (dec-3, t-1): clause_refs — materialized handle-mentions for the
-- standards network map.
--
-- Standards are decomposed into first-class clause rows (spec-150) whose prose
-- cites other entities via the strict std-1 handle grammar (std-N, spec-N,
-- legacy b-N, doc-N, dec-N, cl-N). This table materializes those mentions so
-- the standards-graph endpoint is a plain join (no request-time prose parsing,
-- ac-11) and reverse lookup ("which standards cite std-2") is indexed.
--
-- Write-path maintenance lives in services/clause-refs.ts (syncClauseRefsTx,
-- called inside every clause mutation transaction). The TS parser and the
-- backfill regex below MUST stay in lock-step (same convention as 0074 ↔
-- issue-handle-rewrite.ts). The backfill section below is delimited by the
-- BACKFILL marker line and is executed verbatim by the lock-step test
-- (services/clause-refs.spec-179.test.ts) against seeded rows.
--
-- Targets: target_doc_id resolves memex-scoped for doc-level kinds
-- (standard/spec/document); dec-N and cl-N are doc-relative so they keep a
-- NULL target_doc_id (no graph edge, ac-12). Unresolvable handles also keep
-- NULL — never a cross-memex resolution.

CREATE TABLE IF NOT EXISTS clause_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id uuid NOT NULL,
  source_clause_id uuid REFERENCES standard_clauses(id) ON DELETE CASCADE,
  source_section_id uuid REFERENCES doc_sections(id) ON DELETE CASCADE,
  source_doc_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_kind text NOT NULL,
  target_handle text NOT NULL,
  target_doc_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Exactly one source: a live clause (write-path maintained) XOR a legacy
  -- section preamble (backfill-only; preamble edits don't resync).
  CONSTRAINT clause_refs_one_source CHECK (
    (source_clause_id IS NOT NULL)::int + (source_section_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT clause_refs_kind_valid CHECK (
    target_kind IN ('standard', 'spec', 'document', 'decision', 'clause')
  )
);

-- One row per (source, target kind, target handle): repeated mentions of std-2
-- inside one clause dedupe. Partial because exactly one source column is set.
CREATE UNIQUE INDEX IF NOT EXISTS clause_refs_clause_target_unique
  ON clause_refs (source_clause_id, target_kind, target_handle)
  WHERE source_clause_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clause_refs_section_target_unique
  ON clause_refs (source_section_id, target_kind, target_handle)
  WHERE source_section_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS clause_refs_memex_id_idx ON clause_refs (memex_id);
CREATE INDEX IF NOT EXISTS clause_refs_source_doc_id_idx ON clause_refs (source_doc_id);
CREATE INDEX IF NOT EXISTS clause_refs_target_doc_id_idx ON clause_refs (target_doc_id);

-- BACKFILL --
-- One-time sweep over the existing corpus (ac-10): live clause bodies plus the
-- connective preambles of legacy decomposed sections on standards. Idempotent
-- (ON CONFLICT DO NOTHING against the partial uniques), so re-running is safe.
-- Postgres \m / \M are word boundaries (JS \b equivalents); the alternation and
-- kind mapping mirror services/clause-refs.ts PARSE exactly.

INSERT INTO clause_refs (memex_id, source_clause_id, source_doc_id, target_kind, target_handle, target_doc_id)
SELECT DISTINCT
  sc.memex_id,
  sc.id,
  sc.doc_id,
  CASE m.match[1]
    WHEN 'std' THEN 'standard'
    WHEN 'spec' THEN 'spec'
    WHEN 'b' THEN 'spec'
    WHEN 'doc' THEN 'document'
    WHEN 'dec' THEN 'decision'
    WHEN 'cl' THEN 'clause'
  END,
  m.match[1] || '-' || m.match[2],
  d.id
FROM standard_clauses sc
CROSS JOIN LATERAL regexp_matches(sc.body, '\m(std|spec|b|doc|dec|cl)-([0-9]+)\M', 'g') AS m(match)
LEFT JOIN documents d
  ON d.memex_id = sc.memex_id
 AND d.handle = m.match[1] || '-' || m.match[2]
 AND m.match[1] IN ('std', 'spec', 'b', 'doc')
WHERE sc.status <> 'deleted'
ON CONFLICT (source_clause_id, target_kind, target_handle) WHERE source_clause_id IS NOT NULL
DO NOTHING;

INSERT INTO clause_refs (memex_id, source_section_id, source_doc_id, target_kind, target_handle, target_doc_id)
SELECT DISTINCT
  doc.memex_id,
  s.id,
  s.doc_id,
  CASE m.match[1]
    WHEN 'std' THEN 'standard'
    WHEN 'spec' THEN 'spec'
    WHEN 'b' THEN 'spec'
    WHEN 'doc' THEN 'document'
    WHEN 'dec' THEN 'decision'
    WHEN 'cl' THEN 'clause'
  END,
  m.match[1] || '-' || m.match[2],
  d.id
FROM doc_sections s
JOIN documents doc ON doc.id = s.doc_id AND doc.doc_type = 'standard'
CROSS JOIN LATERAL regexp_matches(s.preamble, '\m(std|spec|b|doc|dec|cl)-([0-9]+)\M', 'g') AS m(match)
LEFT JOIN documents d
  ON d.memex_id = doc.memex_id
 AND d.handle = m.match[1] || '-' || m.match[2]
 AND m.match[1] IN ('std', 'spec', 'b', 'doc')
WHERE s.preamble IS NOT NULL
  AND (s.status IS NULL OR s.status <> 'deleted')
ON CONFLICT (source_section_id, target_kind, target_handle) WHERE source_section_id IS NOT NULL
DO NOTHING;
