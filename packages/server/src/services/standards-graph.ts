// spec-179 (t-4): the standards-graph read model — nodes + edges for the
// Standards network map.
//
// Mention edges are a plain join over clause_refs (materialized by t-1; no
// request-time prose parsing, ac-11), restricted to standard→standard pairs
// with both endpoints resolved in this memex. Self-references are dropped —
// a clause citing its own standard is navigation noise, not a relationship.
//
// Semantic edges ride the standards-section embeddings that already power
// search_memex (vector(1536) on doc_sections, populated by
// services/memex-embeddings.ts for docType='standard'). Doc-level similarity
// is the MAX cosine similarity over the two standards' section pairs;
// `threshold` filters the long tail. The embedding columns are intentionally
// not in the Drizzle schema (see schema.ts docSections note), so this goes
// through raw SQL like memex-search.ts does.

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";

export interface StandardsGraphNode {
  docId: string;
  handle: string;
  title: string;
  /** Live clause count — UI may scale node size by it. */
  clauseCount: number;
}

export interface MentionEvidence {
  /** The citing clause's cl-N seq; null for backfilled preamble refs. */
  clauseSeq: number | null;
  snippet: string | null;
}

export interface MentionEdge {
  sourceDocId: string;
  targetDocId: string;
  /** Number of distinct citing sources — the edge weight. */
  count: number;
  evidence: MentionEvidence[];
}

export interface SemanticEdge {
  sourceDocId: string;
  targetDocId: string;
  similarity: number;
}

export interface StandardsGraph {
  nodes: StandardsGraphNode[];
  mentionEdges: MentionEdge[];
  semanticEdges: SemanticEdge[];
}

/** Default cosine-similarity floor for the semantic overlay. */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.5;

export async function standardsGraph(
  memexId: string,
  opts: { semanticThreshold?: number } = {},
): Promise<StandardsGraph> {
  const threshold = opts.semanticThreshold ?? DEFAULT_SEMANTIC_THRESHOLD;

  const nodes = (await db.execute(sql`
    SELECT
      d.id AS "docId",
      d.handle,
      d.title,
      count(sc.id) FILTER (WHERE sc.status <> 'deleted')::int AS "clauseCount"
    FROM documents d
    LEFT JOIN standard_clauses sc ON sc.doc_id = d.id
    WHERE d.memex_id = ${memexId} AND d.doc_type = 'standard' AND d.archived_at IS NULL
    GROUP BY d.id, d.handle, d.title
    ORDER BY d.handle
  `)) as unknown as StandardsGraphNode[];

  const mentionEdges = (await db.execute(sql`
    SELECT
      cr.source_doc_id AS "sourceDocId",
      cr.target_doc_id AS "targetDocId",
      count(*)::int AS count,
      json_agg(
        json_build_object(
          'clauseSeq', sc.seq,
          'snippet', left(coalesce(sc.body, ''), 140)
        )
        ORDER BY sc.seq NULLS LAST
      ) AS evidence
    FROM clause_refs cr
    JOIN documents sd ON sd.id = cr.source_doc_id AND sd.doc_type = 'standard' AND sd.archived_at IS NULL
    JOIN documents td ON td.id = cr.target_doc_id AND td.doc_type = 'standard' AND td.archived_at IS NULL
    LEFT JOIN standard_clauses sc ON sc.id = cr.source_clause_id
    WHERE cr.memex_id = ${memexId}
      AND cr.target_doc_id IS NOT NULL
      AND cr.source_doc_id <> cr.target_doc_id
    GROUP BY cr.source_doc_id, cr.target_doc_id
    ORDER BY count DESC
  `)) as unknown as MentionEdge[];

  // Pairwise doc-level similarity. s1.doc_id < s2.doc_id keeps each pair once
  // (the overlay is undirected). Standards corpora are small (tens of docs,
  // hundreds of sections), so the cross join is cheap.
  const semanticEdges = (await db.execute(sql`
    SELECT
      s1.doc_id AS "sourceDocId",
      s2.doc_id AS "targetDocId",
      round(max(1 - (s1.embedding <=> s2.embedding))::numeric, 3)::float AS similarity
    FROM doc_sections s1
    JOIN documents d1 ON d1.id = s1.doc_id AND d1.memex_id = ${memexId}
      AND d1.doc_type = 'standard' AND d1.archived_at IS NULL
    JOIN doc_sections s2 ON s2.doc_id > s1.doc_id
    JOIN documents d2 ON d2.id = s2.doc_id AND d2.memex_id = ${memexId}
      AND d2.doc_type = 'standard' AND d2.archived_at IS NULL
    WHERE s1.embedding IS NOT NULL AND s2.embedding IS NOT NULL
    GROUP BY s1.doc_id, s2.doc_id
    HAVING max(1 - (s1.embedding <=> s2.embedding)) >= ${threshold}
    ORDER BY similarity DESC
  `)) as unknown as SemanticEdge[];

  return { nodes, mentionEdges, semanticEdges };
}
