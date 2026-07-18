// spec-498 — Brain: the whole-vault knowledge graph. The spec-497 payload
// (facets, standards, specs, decisions + typed edges, including drift) drawn
// on the spec-496 WebGL map engine, so a user can SEE how everything in the
// memex connects — and click into any of it.
//
// This page is the React shell (the StandardsMap.tsx posture): data fetching
// + DOM overlays (legend, decision filter, focus card, edge evidence). The
// projection into the engine's SimGraph lives in the pure mapper
// (components/brain/model.ts — dec-1); the shared imperative WebGL engine is
// components/standards-map/renderer.ts, untouched beyond the colour-override
// seams. Colour = entity type, rose = open drift (dec-2); semantic-similarity
// edges are deliberately absent (dec-3).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  fetchKnowledgeGraph,
  type KnowledgeGraphData,
  type KnowledgeGraphDecisionFilter,
} from '../api/insights';
import { tenantPath } from '../utils/tenantUrl';
import { PageHeader } from '../components/PageHeader';
import { useThemeName } from '../components/ThemeContext';
import {
  brainPalette,
  buildBrainGraph,
  type BrainLink,
  type BrainNode,
} from '../components/brain/model';
import { MAP_PALETTES, type EvidenceItem, type SimLink, type SimNode } from '../components/standards-map/model';
import { StandardsMapRenderer } from '../components/standards-map/renderer';

interface FocusState {
  id: string;
  kind: BrainNode['kind'];
  handle: string;
  title: string;
  detail: string;
  href: string | null;
}

/** The e2e observation hook's window shape (the spec-496 t-5 pattern). */
type BrainTestWindow = Window & {
  __brainMapE2E?: {
    nodePosition(handle: string): { x: number; y: number } | null;
    nodeFill(handle: string): number | null;
  };
};

const KIND_LABELS: Record<BrainNode['kind'], string> = {
  facet: 'Facet',
  standard: 'Standard',
  spec: 'Spec',
  decision: 'Decision',
};

const cssHex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

export function Brain() {
  const navigate = useNavigate();
  const theme = useThemeName();
  const [graph, setGraph] = useState<KnowledgeGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisionFilter, setDecisionFilter] = useState<KnowledgeGraphDecisionFilter>('resolved');
  const [focus, setFocus] = useState<FocusState | null>(null);
  const [focusDepth, setFocusDepth] = useState<1 | 2>(1);
  const [selectedEdge, setSelectedEdge] = useState<{
    sourceHandle: string;
    targetHandle: string;
    evidence: EvidenceItem[];
  } | null>(null);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<StandardsMapRenderer | null>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const palette = useMemo(() => brainPalette(theme), [theme]);

  useEffect(() => {
    let cancelled = false;
    fetchKnowledgeGraph({ decisions: decisionFilter })
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      });
    return () => {
      cancelled = true;
    };
  }, [decisionFilter]);

  const handleById = useMemo(() => {
    const m = new Map<string, string>();
    if (!graph) return m;
    for (const f of graph.nodes.facets) m.set(f.id, f.key);
    for (const s of graph.nodes.standards) m.set(s.docId, s.handle);
    for (const s of graph.nodes.specs) m.set(s.docId, s.handle);
    for (const d of graph.nodes.decisions) m.set(d.id, d.handle);
    return m;
  }, [graph]);

  // Mount the engine on first data; later fetches (filter flips) and theme
  // changes go through setGraph/setPalette so node positions survive.
  useEffect(() => {
    if (!graph || !hostRef.current) return;
    const sim = buildBrainGraph(graph, palette);
    if (rendererRef.current) {
      rendererRef.current.setPalette(MAP_PALETTES[theme]);
      rendererRef.current.setGraph(sim);
      return;
    }
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const renderer = new StandardsMapRenderer(
      MAP_PALETTES[theme],
      {
        onNodeFocus: (node: SimNode) => {
          const b = node as BrainNode;
          setFocus({
            id: b.id,
            kind: b.kind,
            handle: b.handle,
            title: b.title,
            detail: b.detail,
            href: b.href,
          });
        },
        onNodeNavigate: (node: SimNode) => {
          const b = node as BrainNode;
          if (b.href) navigateRef.current(tenantPath(b.href));
        },
        onEdgeClick: (link: SimLink) => {
          const b = link as BrainLink;
          if (!b.evidence || b.evidence.length === 0) return;
          const s = typeof b.source === 'string' ? b.source : b.source.id;
          const t = typeof b.target === 'string' ? b.target : b.target.id;
          setSelectedEdge({
            sourceHandle: handleById.get(s) ?? s,
            targetHandle: handleById.get(t) ?? t,
            evidence: b.evidence,
          });
        },
        onBackgroundClick: () => setFocus(null),
      },
      { reducedMotion },
    );
    rendererRef.current = renderer;
    void renderer.init(hostRef.current, sim).then(() => {
      // Read-only e2e hook (std-28): WebGL nodes have no DOM, so the journey
      // reads screen positions to click and fills to assert the colour
      // encoding. Harmless in production — bare function reads.
      (window as BrainTestWindow).__brainMapE2E = {
        nodePosition: (handle: string) => renderer.nodeScreenPosition(handle),
        nodeFill: (handle: string) => renderer.nodeFill(handle),
      };
    });
    // handleById/palette derive from graph/theme; both are applied via the
    // setGraph/setPalette path above on subsequent runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, palette, theme]);

  // Unmount exactly once — the renderer outlives graph/theme changes.
  useEffect(() => {
    return () => {
      const renderer = rendererRef.current;
      rendererRef.current = null;
      delete (window as BrainTestWindow).__brainMapE2E;
      renderer?.destroy();
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setFocus(focus?.id ?? null, focusDepth);
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, focusDepth]);

  const shownDecisions = graph?.nodes.decisions.length ?? 0;
  const totalDecisions = graph?.meta.counts.decisions ?? 0;

  return (
    <div className="h-full flex flex-col px-6 py-6">
      <PageHeader
        title="Brain"
        actions={
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted" data-testid="brain-decision-count">
              {shownDecisions} of {totalDecisions} decision{totalDecisions === 1 ? '' : 's'}
              {graph?.meta.truncated ? ' (truncated)' : ''}
            </span>
            <select
              value={decisionFilter}
              onChange={(e) => {
                setFocus(null);
                setDecisionFilter(e.target.value as KnowledgeGraphDecisionFilter);
              }}
              aria-label="Decisions shown"
              className="text-xs px-2 py-1.5 rounded-sm border border-edge bg-transparent text-secondary focus:outline-hidden focus:border-edge-strong"
              data-testid="brain-decision-filter"
            >
              <option value="resolved">resolved decisions</option>
              <option value="all">all decisions</option>
              <option value="none">no decisions</option>
            </select>
          </div>
        }
      />

      {error ? (
        <div className="text-sm text-secondary py-12 text-center" data-testid="brain-error">
          Couldn&apos;t load the knowledge graph: {error}
        </div>
      ) : (
        <div className="relative flex-1 min-h-[480px]" data-testid="brain-map">
          <div ref={hostRef} className="absolute inset-0 overflow-hidden" data-testid="brain-map-canvas" />

          {/* The colour legend (dec-2) — always visible, the encoding is
              self-describing. Rose is the one alarm colour: open drift. */}
          <div
            className="absolute bottom-3 right-3 z-10 bg-panel border border-edge rounded-lg shadow-lg px-3 py-2 space-y-1"
            data-testid="brain-legend"
          >
            {(
              [
                ['facet', palette.facet],
                ['spec', palette.spec],
                ['decision', palette.decision],
                ['standard', palette.standard],
              ] as const
            ).map(([kind, color]) => (
              <div key={kind} className="flex items-center gap-2 text-xs text-secondary">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: cssHex(color) }}
                />
                {KIND_LABELS[kind as BrainNode['kind']]}
              </div>
            ))}
            <div className="flex items-center gap-2 text-xs text-secondary" data-testid="brain-legend-drift">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: cssHex(palette.drift) }}
              />
              Drift (open)
            </div>
          </div>

          {focus && (
            <div
              className="absolute top-3 left-3 z-10 max-w-xs bg-panel border border-edge rounded-lg shadow-lg p-3"
              data-testid="brain-focus-card"
            >
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-xs font-medium truncate" data-testid="brain-focus-title">
                  <span className="uppercase tracking-wide text-[10px] text-muted mr-1.5">
                    {KIND_LABELS[focus.kind]}
                  </span>
                  <span className="font-mono text-muted mr-1">{focus.handle}</span>
                  {focus.title}
                </span>
                <button
                  type="button"
                  className="text-xs text-secondary hover:text-heading shrink-0"
                  onClick={() => setFocus(null)}
                  aria-label="Exit focus"
                  data-testid="brain-focus-close"
                >
                  ✕
                </button>
              </div>
              <div className="text-xs text-secondary mb-2" data-testid="brain-focus-detail">
                {focus.detail}
              </div>
              <div className="flex items-center justify-between gap-3">
                <div
                  className="inline-flex rounded-md border border-edge overflow-hidden"
                  data-testid="brain-focus-depth-chip"
                  role="group"
                  aria-label="Focus depth"
                >
                  {([1, 2] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      data-testid={`brain-focus-depth-${d}`}
                      aria-pressed={focusDepth === d}
                      className={`px-2 py-0.5 text-xs ${
                        focusDepth === d
                          ? 'bg-accent/15 text-heading font-medium'
                          : 'text-secondary hover:text-heading'
                      }`}
                      onClick={() => setFocusDepth(d)}
                    >
                      {d}
                    </button>
                  ))}
                </div>
                {focus.href && (
                  <button
                    type="button"
                    className="text-xs font-medium text-accent hover:underline"
                    data-testid="brain-focus-open"
                    onClick={() => navigateRef.current(tenantPath(focus.href!))}
                  >
                    Open {KIND_LABELS[focus.kind].toLowerCase()} →
                  </button>
                )}
              </div>
            </div>
          )}

          {selectedEdge && (
            <div
              className="absolute bottom-3 left-3 z-10 max-w-md bg-panel border border-edge rounded-lg shadow-lg p-3"
              data-testid="brain-edge-evidence"
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
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
