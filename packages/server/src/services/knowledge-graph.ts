// spec-497 (t-4) — the knowledge-graph read model: the whole-vault graph that grows the
// standards map (spec-179/spec-496) into an Obsidian-style multi-type view. One
// read-only, memex-scoped payload carrying facet / standard / spec / decision nodes
// and the typed edges between them, plus drift.
//
// Everything is SQL aggregation (spec-179 posture, reaffirmed spec-406) — no raw-row
// shipping. All four core relationships are first-class in the schema already:
//   • standard→facet   standard_clause_facets  (spec-340)
//   • decision→facet   decision_facet_ballots  (spec-423)
//   • spec→decision    decisions.doc_id        (plain containment)
//   • standard→standard clause_refs             (spec-179; shared via standards-graph.ts)
// The fifth — drift→decision — rides doc_comments.drift_decision_id (spec-497 dec-3).
//
// The facet vocabulary is owner-config (spec-340 dec-7): no memex_id, no RLS, resolved
// server-side via ownerForMemex — a caller never supplies an owner id (ac-3).

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { ownerForMemex } from "./shared/memex-ownership.js";
import {
  standardsGraphNodes,
  standardsGraphMentionEdges,
  standardsGraphSemanticEdges,
  DEFAULT_SEMANTIC_THRESHOLD,
  type MentionEdge,
  type SemanticEdge,
} from "./standards-graph.js";

// Which decisions enter the graph (dec-2). 'resolved' (default) = resolved decisions
// carrying ≥1 true facet verdict; 'all' additionally admits open/candidate; 'none'
// returns the standards+facets skeleton (empty decisions/specs). deleted/rejected are
// ALWAYS excluded.
export type DecisionFilter = "resolved" | "all" | "none";
export const DEFAULT_DECISION_FILTER: DecisionFilter = "resolved";

// A hard cap on decision nodes so a runaway memex can't blow the payload budget
// (ac-4). Well above current prod scale; when it bites, meta.truncated flags it
// rather than silently dropping nodes.
export const DECISION_NODE_CAP = 2000;

export interface FacetNode {
  id: string;
  key: string;
  name: string | null;
  description: string;
  ord: number;
  /** DISTINCT standards with ≥1 clause tagged with this facet (always full corpus). */
  standardCount: number;
  /** Included decisions whose ballot marks this facet true (varies with the filter). */
  decisionCount: number;
}

export interface StandardNode {
  docId: string;
  handle: string;
  title: string;
  clauseCount: number;
  /** Clauses of this standard carrying ≥1 member facet tag (governs-something). */
  taggedClauseCount: number;
  /** Open drift comments on this standard's sections — exact, link-independent. */
  openDriftCount: number;
}

export interface SpecNode {
  docId: string;
  handle: string;
  title: string;
  status: string;
  /** Included decisions this spec owns. */
  decisionCount: number;
}

export interface DecisionNode {
  id: string;
  handle: string;
  title: string;
  status: string;
  resolvedAt: string | null;
}

export interface SpecDecisionEdge {
  specDocId: string;
  decisionId: string;
}

export interface StandardFacetEdge {
  standardDocId: string;
  facetId: string;
  clauseCount: number;
  evidence: Array<{ clauseHandle: string; snippet: string }>;
}

export interface DecisionFacetEdge {
  decisionId: string;
  facetId: string;
}

export interface DriftEdge {
  decisionId: string;
  standardDocId: string;
  sectionId: string;
  commentId: string;
  openedAt: string;
}

export interface KnowledgeGraph {
  nodes: {
    facets: FacetNode[];
    standards: StandardNode[];
    specs: SpecNode[];
    decisions: DecisionNode[];
  };
  edges: {
    specDecision: SpecDecisionEdge[];
    standardFacet: StandardFacetEdge[];
    decisionFacet: DecisionFacetEdge[];
    mentions: MentionEdge[];
    semantic: SemanticEdge[];
    drift: DriftEdge[];
  };
  meta: {
    decisionFilter: DecisionFilter;
    truncated: boolean;
    counts: { facets: number; standards: number; specs: number; decisions: number };
  };
}

export interface KnowledgeGraphOpts {
  decisions?: DecisionFilter;
  semanticThreshold?: number;
}

export async function knowledgeGraph(
  memexId: string,
  opts: KnowledgeGraphOpts = {},
): Promise<KnowledgeGraph> {
  const decisionFilter = opts.decisions ?? DEFAULT_DECISION_FILTER;
  const threshold = opts.semanticThreshold ?? DEFAULT_SEMANTIC_THRESHOLD;
  const owner = await ownerForMemex(memexId);

  // ── Facet vocabulary (owner-resolved; empty if no owner/vocab) ─────────────
  const facetRows = owner
    ? ((await db.execute(sql`
        SELECT id, key, name, description, ord
        FROM facets
        WHERE owner_type = ${owner.ownerType} AND owner_id = ${owner.ownerId}
        ORDER BY ord, key
      `)) as unknown as Array<{ id: string; key: string; name: string | null; description: string; ord: number }>)
    : [];

  // ── Standard nodes: base (shared) + tagged-clause + open-drift augmentation ─
  const baseStandards = await standardsGraphNodes(memexId);

  const taggedClauseRows = (await db.execute(sql`
    SELECT sc.doc_id AS "docId", count(DISTINCT sc.id)::int AS "taggedClauseCount"
    FROM standard_clause_facets scf
    JOIN standard_clauses sc ON sc.id = scf.clause_id AND sc.status <> 'deleted'
    WHERE scf.memex_id = ${memexId} AND scf.facet_id IS NOT NULL
    GROUP BY sc.doc_id
  `)) as unknown as Array<{ docId: string; taggedClauseCount: number }>;
  const taggedByDoc = new Map(taggedClauseRows.map((r) => [r.docId, r.taggedClauseCount]));

  const driftCountRows = (await db.execute(sql`
    SELECT ds.doc_id AS "docId", count(dc.id)::int AS "openDriftCount"
    FROM doc_comments dc
    JOIN doc_sections ds ON ds.id = dc.section_id
    WHERE dc.memex_id = ${memexId} AND dc.comment_type = 'drift' AND dc.resolved_at IS NULL
    GROUP BY ds.doc_id
  `)) as unknown as Array<{ docId: string; openDriftCount: number }>;
  const driftByDoc = new Map(driftCountRows.map((r) => [r.docId, r.openDriftCount]));

  const standards: StandardNode[] = baseStandards.map((s) => ({
    ...s,
    taggedClauseCount: taggedByDoc.get(s.docId) ?? 0,
    openDriftCount: driftByDoc.get(s.docId) ?? 0,
  }));

  // ── standard→facet edges (aggregated to standard level, dec-4) ─────────────
  const standardFacet = (await db.execute(sql`
    SELECT
      sc.doc_id AS "standardDocId",
      scf.facet_id AS "facetId",
      count(DISTINCT sc.id)::int AS "clauseCount",
      json_agg(
        DISTINCT jsonb_build_object(
          'clauseHandle', 'cl-' || sc.seq,
          'snippet', left(coalesce(sc.body, ''), 140)
        )
      ) AS evidence
    FROM standard_clause_facets scf
    JOIN standard_clauses sc ON sc.id = scf.clause_id AND sc.status <> 'deleted'
    JOIN documents d ON d.id = sc.doc_id AND d.doc_type = 'standard' AND d.archived_at IS NULL
    WHERE scf.memex_id = ${memexId} AND scf.facet_id IS NOT NULL
    GROUP BY sc.doc_id, scf.facet_id
  `)) as unknown as StandardFacetEdge[];

  // ── Decision nodes (filtered) + their ballots ──────────────────────────────
  // A decision enters iff it passes the status filter AND its ballot marks ≥1 facet
  // true (a no-facet decision touches nothing on this graph). Ordered oldest-first
  // so the cap (if ever hit) drops the newest, and the set is deterministic.
  const statusSet =
    decisionFilter === "resolved"
      ? sql`d.status = 'resolved'`
      : sql`d.status IN ('open', 'resolved', 'candidate')`;

  const decisionRows =
    decisionFilter === "none"
      ? []
      : ((await db.execute(sql`
          SELECT
            d.id,
            'dec-' || d.seq AS handle,
            d.title,
            d.status,
            d.doc_id AS "specDocId",
            to_char(d.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "resolvedAt"
          FROM decisions d
          JOIN decision_facet_ballots b ON b.decision_id = d.id
          WHERE d.memex_id = ${memexId}
            AND ${statusSet}
            AND b.verdict <> '{}'::jsonb
            AND EXISTS (
              SELECT 1 FROM jsonb_each(b.verdict) kv WHERE kv.value = 'true'::jsonb
            )
          ORDER BY d.created_at, d.id
          LIMIT ${DECISION_NODE_CAP + 1}
        `)) as unknown as Array<{
          id: string;
          handle: string;
          title: string;
          status: string;
          specDocId: string;
          resolvedAt: string | null;
        }>);

  const truncated = decisionRows.length > DECISION_NODE_CAP;
  const includedDecisions = truncated ? decisionRows.slice(0, DECISION_NODE_CAP) : decisionRows;
  const includedIds = includedDecisions.map((d) => d.id);

  const decisions: DecisionNode[] = includedDecisions.map((d) => ({
    id: d.id,
    handle: d.handle,
    title: d.title,
    status: d.status,
    resolvedAt: d.resolvedAt,
  }));

  // spec→decision containment: one edge per included decision.
  const specDecision: SpecDecisionEdge[] = includedDecisions.map((d) => ({
    specDocId: d.specDocId,
    decisionId: d.id,
  }));

  // ── decision→facet edges + facet.decisionCount (over the included set) ─────
  // Resolve each included decision's TRUE facet keys to facet ids via the owner vocab.
  const keyToFacet = new Map(facetRows.map((f) => [f.key, f.id]));
  const decisionFacet: DecisionFacetEdge[] = [];
  const facetDecisionCount = new Map<string, number>();
  if (includedIds.length > 0 && facetRows.length > 0) {
    const ballotRows = (await db.execute(sql`
      SELECT decision_id AS "decisionId", verdict
      FROM decision_facet_ballots
      WHERE memex_id = ${memexId} AND decision_id IN (${sql.join(includedIds, sql`, `)})
    `)) as unknown as Array<{ decisionId: string; verdict: Record<string, boolean> }>;
    for (const row of ballotRows) {
      for (const [key, val] of Object.entries(row.verdict)) {
        if (val !== true) continue;
        const facetId = keyToFacet.get(key);
        if (!facetId) continue; // key not in the current vocabulary (renamed/removed)
        decisionFacet.push({ decisionId: row.decisionId, facetId });
        facetDecisionCount.set(facetId, (facetDecisionCount.get(facetId) ?? 0) + 1);
      }
    }
  }

  // facet.standardCount: DISTINCT standards tagged with each facet (full corpus).
  const facetStandardCountRows = (await db.execute(sql`
    SELECT scf.facet_id AS "facetId", count(DISTINCT sc.doc_id)::int AS "standardCount"
    FROM standard_clause_facets scf
    JOIN standard_clauses sc ON sc.id = scf.clause_id AND sc.status <> 'deleted'
    WHERE scf.memex_id = ${memexId} AND scf.facet_id IS NOT NULL
    GROUP BY scf.facet_id
  `)) as unknown as Array<{ facetId: string; standardCount: number }>;
  const facetStandardCount = new Map(facetStandardCountRows.map((r) => [r.facetId, r.standardCount]));

  const facets: FacetNode[] = facetRows.map((f) => ({
    id: f.id,
    key: f.key,
    name: f.name,
    description: f.description,
    ord: f.ord,
    standardCount: facetStandardCount.get(f.id) ?? 0,
    decisionCount: facetDecisionCount.get(f.id) ?? 0,
  }));

  // ── Spec nodes: exactly the specs owning ≥1 included decision ──────────────
  const specDocIds = [...new Set(includedDecisions.map((d) => d.specDocId))];
  const specDecisionCount = new Map<string, number>();
  for (const d of includedDecisions) {
    specDecisionCount.set(d.specDocId, (specDecisionCount.get(d.specDocId) ?? 0) + 1);
  }
  const specs: SpecNode[] =
    specDocIds.length === 0
      ? []
      : ((await db.execute(sql`
          SELECT id AS "docId", handle, title, status
          FROM documents
          WHERE memex_id = ${memexId} AND id IN (${sql.join(specDocIds, sql`, `)})
          ORDER BY handle
        `)) as unknown as Array<{ docId: string; handle: string; title: string; status: string }>).map(
          (s) => ({ ...s, decisionCount: specDecisionCount.get(s.docId) ?? 0 }),
        );

  // ── Shared standard→standard edges + drift edges ───────────────────────────
  const [mentions, semantic, driftRows] = await Promise.all([
    standardsGraphMentionEdges(memexId),
    standardsGraphSemanticEdges(memexId, threshold),
    // Drift edges are independent of the decision filter (dec-6 / design note): a
    // drift whose decision falls outside the filter still ships. Only open drift
    // comments carrying a resolved link (drift_decision_id NOT NULL) draw an edge;
    // the rest live in standards[].openDriftCount.
    db.execute(sql`
      SELECT
        dc.drift_decision_id AS "decisionId",
        ds.doc_id AS "standardDocId",
        dc.section_id AS "sectionId",
        dc.id AS "commentId",
        to_char(dc.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "openedAt"
      FROM doc_comments dc
      JOIN doc_sections ds ON ds.id = dc.section_id
      JOIN documents d ON d.id = ds.doc_id AND d.doc_type = 'standard' AND d.archived_at IS NULL
      WHERE dc.memex_id = ${memexId}
        AND dc.comment_type = 'drift'
        AND dc.resolved_at IS NULL
        AND dc.drift_decision_id IS NOT NULL
    `) as unknown as Promise<DriftEdge[]>,
  ]);
  const drift = driftRows as unknown as DriftEdge[];

  // ── Unfiltered totals for meta.counts (ac-14) — nothing hidden silently ────
  const [countRow] = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM documents WHERE memex_id = ${memexId} AND doc_type = 'standard' AND archived_at IS NULL)::int AS standards,
      (SELECT count(*) FROM documents WHERE memex_id = ${memexId} AND doc_type = 'spec' AND archived_at IS NULL)::int AS specs,
      (SELECT count(*) FROM decisions WHERE memex_id = ${memexId} AND status NOT IN ('deleted', 'rejected'))::int AS decisions
  `)) as unknown as Array<{ standards: number; specs: number; decisions: number }>;

  return {
    nodes: { facets, standards, specs, decisions },
    edges: { specDecision, standardFacet, decisionFacet, mentions, semantic, drift },
    meta: {
      decisionFilter,
      truncated,
      counts: {
        facets: facetRows.length,
        standards: countRow?.standards ?? 0,
        specs: countRow?.specs ?? 0,
        decisions: countRow?.decisions ?? 0,
      },
    },
  };
}
