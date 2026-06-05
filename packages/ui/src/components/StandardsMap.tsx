// spec-179 (t-6): the Standards network map — the `map` half of the
// list ⇄ map toggle on /standards.
//
// Nodes: the memex's standards (size accent by clause count). Solid edges:
// clause_refs mention edges (thickness ∝ citing-clause count; click reveals
// the citing clauses). Dashed edges: the optional embedding-similarity
// overlay (ac-13) behind a toggle — visually distinct and clearly fuzzy.
// Node click navigates to the standard (ac-3 / ac-16 deep-link).
//
// Layout: deterministic ring — nodes ordered by handle around a circle whose
// radius grows with node count, then freely user-draggable. Deterministic
// beats force-directed for legibility at standards scale (tens of nodes);
// switch to a proper force/dagre layout if a corpus outgrows the ring
// (mirrors TaskGraph's layout posture).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { fetchStandardsGraph, type StandardsGraphData } from '../api/client';
import { tenantPath } from '../utils/tenantUrl';
import { ACCENT } from './insights/theme';

const SEMANTIC_COLOR = '#a78bfa'; // violet-400 — clearly distinct from mention edges

export interface StandardsMapData {
  nodes: Node[];
  edges: Edge[];
}

/**
 * Pure mapping from the analytics graph payload to React Flow nodes + edges.
 * Exported for unit testing — the render below trusts whatever this returns.
 */
export function buildStandardsMapData(
  graph: StandardsGraphData,
  opts: { showSemantic: boolean },
): StandardsMapData {
  const ordered = [...graph.nodes].sort((a, b) =>
    a.handle.localeCompare(b.handle, undefined, { numeric: true }),
  );
  const n = ordered.length;
  const radius = Math.max(180, n * 42);
  const cx = radius + 120;
  const cy = radius + 60;

  const nodes: Node[] = ordered.map((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
    return {
      id: node.docId,
      position: { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) },
      data: {
        label: `${node.handle} — ${node.title}`,
        handle: node.handle,
        clauseCount: node.clauseCount,
      },
      style: {
        fontSize: 11,
        borderRadius: 10,
        padding: '6px 10px',
        maxWidth: 220,
        // Clause-count accent: better-evidenced standards get a firmer border.
        borderWidth: node.clauseCount > 0 ? 2 : 1,
      },
    };
  });

  const maxCount = Math.max(...graph.mentionEdges.map((e) => e.count), 1);
  const edges: Edge[] = graph.mentionEdges.map((e) => ({
    id: `mention:${e.sourceDocId}->${e.targetDocId}`,
    source: e.sourceDocId,
    target: e.targetDocId,
    style: { stroke: ACCENT, strokeWidth: 1 + (e.count / maxCount) * 3.5 },
    data: { kind: 'mention', count: e.count, evidence: e.evidence },
  }));

  if (opts.showSemantic) {
    for (const e of graph.semanticEdges) {
      edges.push({
        id: `semantic:${e.sourceDocId}->${e.targetDocId}`,
        source: e.sourceDocId,
        target: e.targetDocId,
        style: { stroke: SEMANTIC_COLOR, strokeWidth: 1.25, strokeDasharray: '6 4', opacity: 0.7 },
        data: { kind: 'semantic', similarity: e.similarity },
      });
    }
  }

  return { nodes, edges };
}

type EvidenceItem = { clauseSeq: number | null; snippet: string | null };

export function StandardsMap() {
  const navigate = useNavigate();
  const [graph, setGraph] = useState<StandardsGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSemantic, setShowSemantic] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<{
    sourceHandle: string;
    targetHandle: string;
    evidence: EvidenceItem[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchStandardsGraph()
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const data = useMemo(
    () => (graph ? buildStandardsMapData(graph, { showSemantic }) : { nodes: [], edges: [] }),
    [graph, showSemantic],
  );

  const handleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const node of graph?.nodes ?? []) m.set(node.docId, node.handle);
    return m;
  }, [graph]);

  const onNodeClick = useCallback(
    (_e: unknown, node: Node) => {
      const handle = (node.data as { handle?: string }).handle;
      if (handle) navigate(tenantPath(`/standards/${handle}`));
    },
    [navigate],
  );

  const onEdgeClick = useCallback(
    (_e: unknown, edge: Edge) => {
      const d = edge.data as { kind: string; evidence?: EvidenceItem[] } | undefined;
      if (d?.kind !== 'mention') return;
      setSelectedEdge({
        sourceHandle: handleById.get(edge.source) ?? edge.source,
        targetHandle: handleById.get(edge.target) ?? edge.target,
        evidence: d.evidence ?? [],
      });
    },
    [handleById],
  );

  if (error) {
    return (
      <div className="text-sm text-secondary py-12 text-center" data-testid="standards-map-error">
        Couldn&apos;t load the standards graph: {error}
      </div>
    );
  }

  const semanticAvailable = (graph?.semanticEdges.length ?? 0) > 0;

  return (
    <div className="relative h-full min-h-[480px]" data-testid="standards-map">
      <div className="absolute top-2 right-2 z-10">
        <button
          type="button"
          onClick={() => setShowSemantic((v) => !v)}
          disabled={!semanticAvailable}
          className={`text-xs px-3 py-1.5 rounded border transition-colors ${
            showSemantic
              ? 'border-edge bg-card-hover text-heading'
              : 'border-edge text-secondary hover:bg-card-hover'
          } disabled:opacity-40 disabled:cursor-not-allowed`}
          title={
            semanticAvailable
              ? 'Overlay embedding-similarity edges (fuzzy — not citations)'
              : 'No semantic edges yet — embeddings haven’t been generated for this memex'
          }
          data-testid="semantic-toggle"
        >
          {showSemantic ? '◉' : '○'} semantic neighbors
        </button>
      </div>

      <ReactFlow
        nodes={data.nodes}
        edges={data.edges}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        edgesFocusable
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {selectedEdge && (
        <div
          className="absolute bottom-3 left-3 z-10 max-w-md bg-panel border border-edge rounded-lg shadow-lg p-3"
          data-testid="edge-evidence"
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium">
              {selectedEdge.sourceHandle} → {selectedEdge.targetHandle}
            </span>
            <button
              type="button"
              className="text-xs text-secondary hover:text-heading"
              onClick={() => setSelectedEdge(null)}
              aria-label="Close evidence"
            >
              ✕
            </button>
          </div>
          <ul className="text-xs text-secondary space-y-1 max-h-40 overflow-y-auto">
            {selectedEdge.evidence.map((ev, i) => (
              <li key={i}>
                {ev.clauseSeq !== null && (
                  <span className="font-mono text-muted mr-1">cl-{ev.clauseSeq}</span>
                )}
                {ev.snippet}
                {ev.snippet && ev.snippet.length >= 140 ? '…' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
