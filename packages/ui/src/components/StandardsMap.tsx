// spec-179 (t-8): the Standards network map — the `map` half of the
// list ⇄ map toggle on /standards.
//
// Obsidian's graph-view recipe, per amended dec-1: PIXI.js renders (WebGL),
// d3-force lays out. Nodes: the memex's standards, sized by connectedness and
// coloured by mention-edge cluster (spec-496 dec-2). Solid edges: clause_refs
// mention edges (thickness ∝ citing-clause count; click reveals the citing
// clauses). Dashed edges: the optional embedding-similarity overlay behind a
// toggle. Hovering highlights a node's neighborhood with the accent + a glow;
// labels fade in with zoom; dragging re-heats the simulation.
//
// spec-496 dec-5: single-click focuses a node's local graph (depth chip
// toggles 1 ⇄ 2 hops, a card offers "Open standard"); double-click or the
// card action navigates (the spec-179 ac-3/ac-16 deep link, unchanged);
// Escape or a background click restores the full map. prefers-reduced-motion
// is read here and handed to the renderer (dec-3).
//
// This component is the React shell: data fetching + the DOM overlays
// (evidence panel, focus card). The search box and semantic toggle live in
// StandardList's shared toolbar (stable across the list ⇄ map switch) and
// drive this component through props. The imperative WebGL engine lives in
// ./standards-map/renderer.ts; the pure, jsdom-testable mapping in
// ./standards-map/model.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchStandardsGraph, type StandardsGraphData } from '../api/client';
import { tenantPath } from '../utils/tenantUrl';
import { useThemeName } from './ThemeContext';
import {
  buildSimGraph,
  MAP_PALETTES,
  searchHits,
  type EvidenceItem,
  type FocusDepth,
  type SimLink,
  type SimNode,
} from './standards-map/model';
import { StandardsMapRenderer } from './standards-map/renderer';

export interface StandardsMapProps {
  /** Toolbar search query (owned by StandardList) — highlights hits. */
  query: string;
  /** Semantic-overlay toggle state (owned by StandardList). */
  showSemantic: boolean;
  /** Reports whether this memex has semantic edges (enables the toggle). */
  onSemanticAvailable?: (available: boolean) => void;
}

interface FocusState {
  id: string;
  handle: string;
  title: string;
  clauseCount: number;
}

/** The e2e observation hook's window shape (spec-496 t-5). */
type StandardsMapTestWindow = Window & {
  __standardsMapE2E?: {
    nodePosition(handle: string): { x: number; y: number } | null;
    nodeFill(handle: string): number | null;
  };
};

export function StandardsMap({ query, showSemantic, onSemanticAvailable }: StandardsMapProps) {
  const navigate = useNavigate();
  const theme = useThemeName();
  const [graph, setGraph] = useState<StandardsGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{
    sourceHandle: string;
    targetHandle: string;
    evidence: EvidenceItem[];
  } | null>(null);
  // Local-graph focus (spec-496 dec-5) — the shell owns the state, the
  // renderer projects it. Depth persists across focus changes in a session.
  const [focus, setFocus] = useState<FocusState | null>(null);
  const [focusDepth, setFocusDepth] = useState<FocusDepth>(1);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<StandardsMapRenderer | null>(null);
  // The renderer's callbacks close over these refs so a stale closure can
  // never navigate with an old router or read an old graph.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const onSemanticAvailableRef = useRef(onSemanticAvailable);
  onSemanticAvailableRef.current = onSemanticAvailable;

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

  const handleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const node of graph?.nodes ?? []) m.set(node.docId, node.handle);
    return m;
  }, [graph]);

  useEffect(() => {
    if (graph) onSemanticAvailableRef.current?.(graph.semanticEdges.length > 0);
  }, [graph]);

  // Mount the WebGL engine once the data is in. The renderer outlives
  // semantic-toggle and theme changes (handled by the effects below) so the
  // force layout isn't recomputed from scratch on every UI tweak.
  useEffect(() => {
    if (!graph || !hostRef.current) return;
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const renderer = new StandardsMapRenderer(
      MAP_PALETTES[theme],
      {
        onNodeFocus: (node: SimNode) => {
          setFocus({
            id: node.id,
            handle: node.handle,
            title: node.title,
            clauseCount: node.clauseCount,
          });
        },
        onNodeNavigate: (node: SimNode) => {
          navigateRef.current(tenantPath(`/standards/${node.handle}`));
        },
        onEdgeClick: (link: SimLink) => {
          if (link.kind !== 'mention') return;
          const s = typeof link.source === 'string' ? link.source : link.source.id;
          const t = typeof link.target === 'string' ? link.target : link.target.id;
          setSelectedEdge({
            sourceHandle: handleById.get(s) ?? s,
            targetHandle: handleById.get(t) ?? t,
            evidence: link.evidence ?? [],
          });
        },
        onBackgroundClick: () => setFocus(null),
      },
      { reducedMotion },
    );
    rendererRef.current = renderer;
    setFocus(null);
    void renderer
      .init(hostRef.current, buildSimGraph(graph, { showSemantic: false }))
      .then(() => {
        // spec-496 (t-5): read-only e2e observation hook — WebGL nodes have no
        // DOM, so the std-28 journey reads screen positions/fills from here to
        // click nodes for real. Harmless in production (bare function reads).
        (window as StandardsMapTestWindow).__standardsMapE2E = {
          nodePosition: (handle: string) => renderer.nodeScreenPosition(handle),
          nodeFill: (handle: string) => renderer.nodeFill(handle),
        };
      });
    return () => {
      rendererRef.current = null;
      delete (window as StandardsMapTestWindow).__standardsMapE2E;
      renderer.destroy();
    };
    // handleById derives from graph; theme changes go through setPalette below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    if (graph) rendererRef.current?.setGraph(buildSimGraph(graph, { showSemantic }));
  }, [graph, showSemantic]);

  useEffect(() => {
    rendererRef.current?.setPalette(MAP_PALETTES[theme]);
  }, [theme, graph]);

  useEffect(() => {
    if (graph) rendererRef.current?.setSearch(searchHits(graph, query));
  }, [graph, query]);

  // Project the focus state into the renderer; Escape exits (dec-5).
  useEffect(() => {
    rendererRef.current?.setFocus(focus?.id ?? null, focusDepth);
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, focusDepth]);

  if (error) {
    return (
      <div className="text-sm text-secondary py-12 text-center" data-testid="standards-map-error">
        Couldn&apos;t load the standards graph: {error}
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[480px]" data-testid="standards-map">
      <div
        ref={hostRef}
        className="absolute inset-0 overflow-hidden"
        data-testid="standards-map-canvas"
      />

      {focus && (
        <div
          className="absolute top-3 left-3 z-10 max-w-xs bg-panel border border-edge rounded-lg shadow-lg p-3"
          data-testid="focus-card"
        >
          <div className="flex items-center justify-between gap-3 mb-1">
            <span className="text-xs font-medium truncate" data-testid="focus-card-title">
              <span className="font-mono text-muted mr-1">{focus.handle}</span>
              {focus.title}
            </span>
            <button
              type="button"
              className="text-xs text-secondary hover:text-heading shrink-0"
              onClick={() => setFocus(null)}
              aria-label="Exit focus"
              data-testid="focus-card-close"
            >
              ✕
            </button>
          </div>
          <div className="text-xs text-secondary mb-2">
            {focus.clauseCount} clause{focus.clauseCount === 1 ? '' : 's'}
          </div>
          <div className="flex items-center justify-between gap-3">
            <div
              className="inline-flex rounded-md border border-edge overflow-hidden"
              data-testid="focus-depth-chip"
              role="group"
              aria-label="Focus depth"
            >
              {([1, 2] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  data-testid={`focus-depth-${d}`}
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
            <button
              type="button"
              className="text-xs font-medium text-accent hover:underline"
              data-testid="focus-card-open"
              onClick={() => navigateRef.current(tenantPath(`/standards/${focus.handle}`))}
            >
              Open standard →
            </button>
          </div>
        </div>
      )}

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
