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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchKnowledgeGraph, type KnowledgeGraphData } from '../api/insights';
import { tenantPath } from '../utils/tenantUrl';
import { timeAgo } from '../utils/timeAgo';
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

// One open drift, enriched for the drift tour (the next/prev walk through every
// open drift). A drift IS the rose edge from a decision to the standard it
// contradicts; `href` deep-links to THAT item in the Drift Inbox.
interface DriftStep {
  commentId: string;
  href: string;
  decisionId: string;
  decisionHandle: string;
  decisionTitle: string;
  /** Canonical decision page (/specs/:spec/decisions/:dec); null if no owning spec. */
  decisionHref: string | null;
  standardDocId: string;
  standardHandle: string;
  standardTitle: string;
  standardHref: string;
  openedAt: string;
}

/** The e2e observation hook's window shape (the spec-496 t-5 pattern). */
type BrainTestWindow = Window & {
  __brainMapE2E?: {
    nodePosition(handle: string): { x: number; y: number } | null;
    nodeFill(handle: string): number | null;
  };
};

// spec-498 dec-6: the facet ENTITY displays as "Discipline" on this surface —
// a display-only rename; the machine-facing noun stays `facet` everywhere.
const KIND_LABELS: Record<BrainNode['kind'], string> = {
  facet: 'Discipline',
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
  const [focus, setFocus] = useState<FocusState | null>(null);
  const [focusDepth, setFocusDepth] = useState<1 | 2>(1);
  // The drift tour position — null when not touring. Mutually exclusive with
  // `focus`: starting a drift step clears node/discipline focus and vice versa.
  const [driftIndex, setDriftIndex] = useState<number | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{
    sourceHandle: string;
    targetHandle: string;
    evidence: EvidenceItem[];
  } | null>(null);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<StandardsMapRenderer | null>(null);
  // The last-built sim nodes — the discipline selector (dec-7) looks its
  // target node up here to run the same focus path a canvas click would.
  const brainNodesRef = useRef<BrainNode[]>([]);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // The renderer's edge-click callback is built once, so route the drift-edge →
  // card action through a ref that each render refreshes with the latest
  // openDrifts/goToDrift (the same latest-ref pattern as navigateRef).
  const openDriftEdgeRef = useRef<(decisionId: string, standardDocId: string) => void>(() => {});

  const palette = useMemo(() => brainPalette(theme), [theme]);

  // The decisions filter stays at the API's resolved default (dec-7) — the
  // one toolbar control is the discipline selector below.
  useEffect(() => {
    let cancelled = false;
    fetchKnowledgeGraph()
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
    if (!graph) return m;
    for (const f of graph.nodes.facets) m.set(f.id, f.key);
    for (const s of graph.nodes.standards) m.set(s.docId, s.handle);
    for (const s of graph.nodes.specs) m.set(s.docId, s.handle);
    for (const d of graph.nodes.decisions) m.set(d.id, d.handle);
    return m;
  }, [graph]);

  // Every open drift, enriched with its endpoints and ordered oldest-first — the
  // ordered list the drift tour steps through. Drifts whose decision or standard
  // fell outside the payload are skipped (mirrors the model's edge guard).
  const openDrifts = useMemo<DriftStep[]>(() => {
    if (!graph) return [];
    const decById = new Map(graph.nodes.decisions.map((d) => [d.id, d]));
    const stdById = new Map(graph.nodes.standards.map((s) => [s.docId, s]));
    // A decision deep-links through its owning spec (the specDecision join),
    // matching the node hrefs the mapper builds.
    const specHandleByDocId = new Map(graph.nodes.specs.map((s) => [s.docId, s.handle]));
    const specDocIdByDecision = new Map(
      graph.edges.specDecision.map((sd) => [sd.decisionId, sd.specDocId]),
    );
    return graph.edges.drift
      .map((e): DriftStep | null => {
        const dec = decById.get(e.decisionId);
        const std = stdById.get(e.standardDocId);
        if (!dec || !std) return null;
        const specDocId = specDocIdByDecision.get(e.decisionId);
        const specHandle = specDocId ? specHandleByDocId.get(specDocId) : undefined;
        return {
          commentId: e.commentId,
          href: `/drift?doc=${std.handle}&drift=${e.commentId}`,
          decisionId: e.decisionId,
          decisionHandle: dec.handle,
          decisionTitle: dec.title,
          decisionHref: specHandle ? `/specs/${specHandle}/decisions/${dec.handle}` : null,
          standardDocId: std.docId,
          standardHandle: std.handle,
          standardTitle: std.title,
          standardHref: `/standards/${std.handle}`,
          openedAt: e.openedAt,
        };
      })
      .filter((d): d is DriftStep => d !== null)
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }, [graph]);

  // Step the drift tour to `idx` (wrapping), pin+glide the camera to the
  // drifting decision so its rose edge to the contradicted standard is the hero
  // of the frame, and clear any node/discipline focus (mutually exclusive).
  const goToDrift = useCallback(
    (idx: number) => {
      const n = openDrifts.length;
      if (n === 0) return;
      const clamped = ((idx % n) + n) % n;
      setFocus(null);
      setSelectedEdge(null);
      setDriftIndex(clamped);
      rendererRef.current?.frameFocus(openDrifts[clamped].decisionId, focusDepth);
    },
    [openDrifts, focusDepth],
  );

  // Clicking a drift edge opens the drift card at that drift (never navigates —
  // only the card's "Open drift →" leaves the map). Matched by its endpoints.
  openDriftEdgeRef.current = (decisionId: string, standardDocId: string) => {
    const idx = openDrifts.findIndex(
      (d) => d.decisionId === decisionId && d.standardDocId === standardDocId,
    );
    if (idx >= 0) goToDrift(idx);
  };

  // Mount the engine on first data; later fetches (filter flips) and theme
  // changes go through setGraph/setPalette so node positions survive.
  useEffect(() => {
    if (!graph || !hostRef.current) return;
    const sim = buildBrainGraph(graph, palette);
    brainNodesRef.current = sim.nodes;
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
          setDriftIndex(null); // a node click leaves the drift tour
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
          const s = typeof b.source === 'string' ? b.source : b.source.id;
          const t = typeof b.target === 'string' ? b.target : b.target.id;
          // A drift edge opens the drift card at that drift — it does NOT
          // navigate; only the card's "Open drift →" leaves the map (ac-15).
          if (b.rel === 'drift') {
            openDriftEdgeRef.current(s, t);
            return;
          }
          if (!b.evidence || b.evidence.length === 0) return;
          setSelectedEdge({
            sourceHandle: handleById.get(s) ?? s,
            targetHandle: handleById.get(t) ?? t,
            evidence: b.evidence,
          });
        },
        onBackgroundClick: () => {
          setFocus(null);
          setDriftIndex(null);
        },
      },
      // Drift is the map's one live signal — the flow-flagged rose drift edges
      // animate continuously; every other edge is a thin static line (spec-498).
      { reducedMotion, continuousFlow: true },
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

  // The graph highlight follows whichever mode is active: a drift step pins the
  // drifting decision (so its rose edge stands out); otherwise the node /
  // discipline focus. They're mutually exclusive, so one derived id drives both.
  const highlightId =
    driftIndex !== null ? openDrifts[driftIndex]?.decisionId ?? null : focus?.id ?? null;
  const currentDrift = driftIndex !== null ? openDrifts[driftIndex] ?? null : null;

  useEffect(() => {
    rendererRef.current?.setFocus(highlightId, focusDepth);
  }, [highlightId, focusDepth]);

  // Keyboard while focused or touring: Escape exits; ← / → step the drift tour
  // (ignored while a form control is focused so the discipline <select> keeps
  // its native arrow behaviour).
  useEffect(() => {
    if (!focus && driftIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFocus(null);
        setDriftIndex(null);
        return;
      }
      if (driftIndex === null) return;
      const el = e.target as HTMLElement | null;
      if (el && ['SELECT', 'INPUT', 'TEXTAREA'].includes(el.tagName)) return;
      if (e.key === 'ArrowRight') goToDrift(driftIndex + 1);
      else if (e.key === 'ArrowLeft') goToDrift(driftIndex - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, driftIndex, goToDrift]);

  // dec-7: selecting a discipline runs the exact single-click focus path —
  // same FocusState, same renderer projection — plus a camera glide to it.
  const focusDiscipline = (key: string) => {
    setDriftIndex(null); // selecting a discipline leaves the drift tour
    if (!key) {
      setFocus(null);
      return;
    }
    const node = brainNodesRef.current.find((n) => n.kind === 'facet' && n.handle === key);
    if (!node) return;
    setFocus({
      id: node.id,
      kind: node.kind,
      handle: node.handle,
      title: node.title,
      detail: node.detail,
      href: node.href,
    });
    // Glide-zoom the camera to frame the discipline + its related nodes (dec-7).
    // Uses the same neighbourhood depth the highlight will apply.
    rendererRef.current?.frameFocus(node.id, focusDepth);
  };

  const totalDecisions = graph?.meta.counts.decisions ?? 0;
  // An empty vault must explain itself, not render a silent blank canvas: no
  // facets, no standards, and no decisions passing the filter = nothing to map.
  const isEmpty =
    graph !== null &&
    graph.nodes.facets.length === 0 &&
    graph.nodes.standards.length === 0 &&
    graph.nodes.specs.length === 0 &&
    graph.nodes.decisions.length === 0;
  // Special case: the vault HAS decisions, none of them resolved (the graph
  // shows resolved decisions) — say so instead of claiming the memex is empty.
  const emptyButUnresolved = isEmpty && totalDecisions > 0;

  return (
    <div className="h-full flex flex-col px-6 py-6">
      <PageHeader
        title="Brain"
        actions={
          <div className="flex items-center gap-3">
            {/* Drift navigator (the headline objective): step through every open
                drift, each glide-framed so its rose edge to the contradicted
                standard is unmissable. Idle → an entry pill; touring → ‹ i/N ›. */}
            {openDrifts.length > 0 &&
              (driftIndex === null ? (
                <button
                  type="button"
                  onClick={() => goToDrift(0)}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-status-danger-border bg-status-danger-bg text-status-danger-text font-medium cursor-pointer hover:brightness-110 whitespace-nowrap"
                  data-testid="brain-drift-nav"
                  title="Step through open drift — see how each contradicts a standard"
                >
                  <span aria-hidden>⚠</span>
                  {openDrifts.length} open drift
                </button>
              ) : (
                <div
                  className="inline-flex items-center rounded-md border border-status-danger-border bg-status-danger-bg text-status-danger-text overflow-hidden"
                  role="group"
                  aria-label="Drift navigator"
                  data-testid="brain-drift-nav"
                >
                  <button
                    type="button"
                    onClick={() => goToDrift(driftIndex - 1)}
                    className="px-2 py-1.5 text-sm leading-none cursor-pointer hover:brightness-110"
                    aria-label="Previous drift"
                    data-testid="brain-drift-prev"
                  >
                    ‹
                  </button>
                  <span
                    className="px-1.5 py-1.5 text-xs font-medium whitespace-nowrap"
                    data-testid="brain-drift-position"
                  >
                    Drift {driftIndex + 1} / {openDrifts.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => goToDrift(driftIndex + 1)}
                    className="px-2 py-1.5 text-sm leading-none cursor-pointer hover:brightness-110"
                    aria-label="Next drift"
                    data-testid="brain-drift-next"
                  >
                    ›
                  </button>
                </div>
              ))}
            <select
              value={focus?.kind === 'facet' ? focus.handle : ''}
              onChange={(e) => focusDiscipline(e.target.value)}
              aria-label="Focus a discipline"
              className="text-xs px-2.5 py-1.5 rounded-md border border-edge bg-transparent text-secondary cursor-pointer hover:border-edge-strong focus:outline-hidden focus:border-edge-strong"
              data-testid="brain-discipline-select"
            >
              <option value="">Focus a discipline…</option>
              {(graph?.nodes.facets ?? []).map((f) => (
                <option key={f.id} value={f.key}>
                  {f.name ?? f.key}
                </option>
              ))}
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

          {isEmpty && (
            <div
              className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"
              data-testid="brain-empty"
            >
              <div className="max-w-md text-center border border-edge-subtle rounded-lg p-8 bg-surface/40 pointer-events-auto">
                <p className="text-sm text-secondary mb-1">Nothing to map yet.</p>
                <p className="text-xs text-muted">
                  {emptyButUnresolved ? (
                    <>
                      This memex has {totalDecisions} decision
                      {totalDecisions === 1 ? '' : 's'}, but none are resolved yet — resolved
                      decisions join the map.
                    </>
                  ) : (
                    <>
                      The Brain draws how everything in a memex connects — specs own decisions,
                      decisions touch disciplines, disciplines govern standards, and open drift
                      shows up red. It lights up once this memex has standards, disciplines, or
                      decisions.
                    </>
                  )}
                </p>
              </div>
            </div>
          )}

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
                  {/* A facet's handle IS its name (key) — showing both reads
                      duplicated ("performance Performance"), so the mono
                      handle renders only for handle-bearing kinds (ac-15). */}
                  {focus.kind !== 'facet' && (
                    <span className="font-mono text-muted mr-1">{focus.handle}</span>
                  )}
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
                <div className="inline-flex items-center gap-1.5">
                  {/* "Depth" labels the otherwise-cryptic 1│2 toggle: how many hops
                      out from the focused node stay highlighted (1 = direct, 2 = two). */}
                  <span className="text-xs text-muted select-none">Depth</span>
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

          {/* The drift card (shown while touring) — a drift is a RELATIONSHIP, so
              it reads "decision ✗ contradicts standard", with the click-through to
              THAT exact drift item (not just the standard's inbox). */}
          {currentDrift && (
            <div
              className="absolute top-3 left-3 z-10 max-w-xs bg-panel border border-status-danger-border rounded-lg shadow-lg p-3"
              data-testid="brain-drift-card"
            >
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="uppercase tracking-wide text-[10px] font-medium text-status-danger-text">
                  Drift {(driftIndex ?? 0) + 1} of {openDrifts.length}
                </span>
                <button
                  type="button"
                  className="text-xs text-secondary hover:text-heading shrink-0"
                  onClick={() => setDriftIndex(null)}
                  aria-label="Exit drift tour"
                  data-testid="brain-drift-close"
                >
                  ✕
                </button>
              </div>
              <div className="text-xs space-y-1">
                <div className="flex items-baseline gap-1.5">
                  {currentDrift.decisionHref ? (
                    <button
                      type="button"
                      className="font-mono text-muted shrink-0 hover:text-heading hover:underline cursor-pointer"
                      onClick={() => navigateRef.current(tenantPath(currentDrift.decisionHref!))}
                      data-testid="brain-drift-decision-link"
                    >
                      {currentDrift.decisionHandle}
                    </button>
                  ) : (
                    <span className="font-mono text-muted shrink-0">{currentDrift.decisionHandle}</span>
                  )}
                  <span className="truncate">{currentDrift.decisionTitle}</span>
                </div>
                <div className="text-[11px] font-medium text-status-danger-text">✗ contradicts</div>
                <div className="flex items-baseline gap-1.5">
                  <button
                    type="button"
                    className="font-mono text-muted shrink-0 hover:text-heading hover:underline cursor-pointer"
                    onClick={() => navigateRef.current(tenantPath(currentDrift.standardHref))}
                    data-testid="brain-drift-standard-link"
                  >
                    {currentDrift.standardHandle}
                  </button>
                  <span className="truncate">{currentDrift.standardTitle}</span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 mt-2">
                <span className="text-[11px] text-muted whitespace-nowrap">
                  opened {timeAgo(currentDrift.openedAt)}
                </span>
                <button
                  type="button"
                  className="text-xs font-medium text-accent hover:underline shrink-0"
                  onClick={() => navigateRef.current(tenantPath(currentDrift.href))}
                  data-testid="brain-drift-open"
                >
                  Open drift →
                </button>
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
