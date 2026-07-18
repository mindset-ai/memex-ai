// spec-496 — standards map v2: clustering + palette (dec-2), easing/ticker
// math (dec-3), directional flow selection (dec-4), local-graph focus (dec-5),
// plus the scope/licence guards (dec-1, dec-6). The pure model is tested
// directly; the WebGL renderer stays browser-only, so the React shell is
// tested with the renderer mocked (same posture as the spec-179 suite).

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  buildSimGraph,
  clusterAssignments,
  easeToward,
  EASE_EPSILON,
  flowEdgeIds,
  focusSetOf,
  MAP_PALETTES,
  mixColor,
  nodeColor,
  tickerShouldSleep,
} from './standards-map/model';
import { CHART_PALETTES } from './insights/theme';
import type { StandardsGraphData } from '../api/client';
import type { RendererCallbacks, RendererOptions } from './standards-map/renderer';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-496';
const AC_SCOPE_EASING = `${SPEC}/acs/ac-1`;
const AC_SCOPE_HOVER = `${SPEC}/acs/ac-2`;
const AC_SCOPE_CLUSTERS = `${SPEC}/acs/ac-3`;
const AC_SCOPE_ALIVE = `${SPEC}/acs/ac-4`;
const AC_SCOPE_DIRECTION = `${SPEC}/acs/ac-5`;
const AC_SCOPE_FOCUS = `${SPEC}/acs/ac-6`;
const AC_UI_CONFINED = `${SPEC}/acs/ac-8`;
const AC_CLUSTER_DETERMINISTIC = `${SPEC}/acs/ac-9`;
const AC_CLUSTER_PALETTE = `${SPEC}/acs/ac-10`;
const AC_EASING_SYSTEM = `${SPEC}/acs/ac-11`;
const AC_TICKER_SLEEP = `${SPEC}/acs/ac-12`;
const AC_FLOW_EMPHASIS = `${SPEC}/acs/ac-13`;
const AC_FOCUS_SET = `${SPEC}/acs/ac-14`;
const AC_FOCUS_UI = `${SPEC}/acs/ac-15`;
const AC_NO_EE = `${SPEC}/acs/ac-16`;

// Two mention communities (a1-a2-a3 and b1-b2) plus an isolated node.
// vi.hoisted: the api/client mock factory below closes over this fixture.
const GRAPH: StandardsGraphData = vi.hoisted(() => ({
  nodes: [
    { docId: 'a1', handle: 'std-1', title: 'Alpha one', clauseCount: 3 },
    { docId: 'a2', handle: 'std-2', title: 'Alpha two', clauseCount: 2 },
    { docId: 'a3', handle: 'std-3', title: 'Alpha three', clauseCount: 1 },
    { docId: 'b1', handle: 'std-4', title: 'Beta one', clauseCount: 5 },
    { docId: 'b2', handle: 'std-5', title: 'Beta two', clauseCount: 0 },
    { docId: 'lone', handle: 'std-6', title: 'Loner', clauseCount: 1 },
  ],
  mentionEdges: [
    { sourceDocId: 'a1', targetDocId: 'a2', count: 2, evidence: [] },
    { sourceDocId: 'a2', targetDocId: 'a3', count: 1, evidence: [] },
    { sourceDocId: 'a1', targetDocId: 'a3', count: 1, evidence: [] },
    { sourceDocId: 'b1', targetDocId: 'b2', count: 3, evidence: [] },
  ],
  semanticEdges: [{ sourceDocId: 'a1', targetDocId: 'b1', similarity: 0.7 }],
}));

describe('cluster detection (dec-2)', () => {
  it('partitions by mention connectivity, deterministically, singletons unclustered', () => {
    tagAc(AC_CLUSTER_DETERMINISTIC);
    tagAc(AC_SCOPE_CLUSTERS);
    const ids = GRAPH.nodes.map((n) => n.docId);
    const first = clusterAssignments(ids, GRAPH.mentionEdges);
    // The two mention components land in two distinct clusters.
    expect(first.get('a1')).toBeDefined();
    expect(first.get('a1')).toBe(first.get('a2'));
    expect(first.get('a1')).toBe(first.get('a3'));
    expect(first.get('b1')).toBe(first.get('b2'));
    expect(first.get('a1')).not.toBe(first.get('b1'));
    // No mention edges → unclustered (semantic similarity does not cluster).
    expect(first.has('lone')).toBe(false);
    // Deterministic: same input, same assignment, call after call.
    const again = clusterAssignments(ids, GRAPH.mentionEdges);
    expect([...again.entries()].sort()).toEqual([...first.entries()].sort());
    // Determinism holds under input-order permutation of the node list.
    const reversed = clusterAssignments([...ids].reverse(), GRAPH.mentionEdges);
    expect([...reversed.entries()].sort()).toEqual([...first.entries()].sort());
  });

  it('buildSimGraph carries the cluster onto sim nodes; empty graphs degrade', () => {
    tagAc(AC_CLUSTER_DETERMINISTIC);
    tagAc(AC_SCOPE_CLUSTERS);
    const { nodes } = buildSimGraph(GRAPH, { showSemantic: false });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get('a1')!.cluster).toBe(byId.get('a2')!.cluster);
    expect(byId.get('a1')!.cluster).not.toBe(byId.get('b1')!.cluster);
    expect(byId.get('lone')!.cluster).toBeUndefined();
    // A memex with no mention edges: everything unclustered, nothing throws.
    const bare = buildSimGraph(
      { nodes: GRAPH.nodes, mentionEdges: [], semanticEdges: [] },
      { showSemantic: false },
    );
    expect(bare.nodes.every((n) => n.cluster === undefined)).toBe(true);
  });
});

describe('cluster palette (dec-2 / std-27)', () => {
  it('cluster hues are the shared std-27 series hues, theme-aware, accent excluded', () => {
    tagAc(AC_CLUSTER_PALETTE);
    tagAc(AC_SCOPE_CLUSTERS);
    for (const theme of ['dark', 'light'] as const) {
      const { clusterHues } = MAP_PALETTES[theme];
      const p = CHART_PALETTES[theme].phase;
      const expected = [p.specify, p.build, p.verify, p.done].map((h) =>
        parseInt(h.slice(1), 16),
      );
      // Derived from CHART_PALETTES, so the map can never drift from std-27.
      expect(clusterHues).toEqual(expected);
      // The accent (violet) stays reserved for emphasis (std-27 cl-3).
      const accent = parseInt(CHART_PALETTES[theme].accent.slice(1), 16);
      expect(clusterHues).not.toContain(accent);
    }
  });

  it('nodeColor cycles hues and keeps slate for unclustered nodes', () => {
    tagAc(AC_CLUSTER_PALETTE);
    const palette = MAP_PALETTES.dark;
    expect(nodeColor({ cluster: undefined }, palette)).toBe(palette.node);
    expect(nodeColor({ cluster: 0 }, palette)).toBe(palette.clusterHues[0]);
    // More clusters than hues → cycle, never fall off the palette.
    expect(nodeColor({ cluster: palette.clusterHues.length + 1 }, palette)).toBe(
      palette.clusterHues[1],
    );
  });
});

describe('easing math (dec-3)', () => {
  it('easeToward converges exponentially, snaps at epsilon, and is instant at rate 1', () => {
    tagAc(AC_EASING_SYSTEM);
    tagAc(AC_SCOPE_EASING);
    // One step moves 15% of the distance.
    expect(easeToward(0, 1)).toBeCloseTo(0.15, 5);
    // Iterating genuinely arrives (snap) instead of asymptoting forever.
    let v = 0;
    for (let i = 0; i < 100; i++) v = easeToward(v, 1);
    expect(v).toBe(1);
    // Close enough → snap to target exactly.
    expect(easeToward(1 - EASE_EPSILON / 2, 1)).toBe(1);
    // rate=1 is the reduced-motion path: instant.
    expect(easeToward(0, 1, 1)).toBe(1);
  });

  it('mixColor lerps RGB channels between palette stroke and accent', () => {
    tagAc(AC_EASING_SYSTEM);
    tagAc(AC_SCOPE_HOVER);
    expect(mixColor(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mixColor(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(mixColor(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    // Out-of-range t clamps rather than overshooting the accent.
    expect(mixColor(0x102030, 0x405060, 2)).toBe(0x405060);
  });
});

describe('ticker sleep (dec-3 / ac-12)', () => {
  it('sleeps exactly when eased values settled, sim at rest, and no flow lit', () => {
    tagAc(AC_TICKER_SLEEP);
    tagAc(AC_SCOPE_ALIVE);
    expect(tickerShouldSleep(true, false, false)).toBe(true);
    // Any residual motion keeps the loop alive.
    expect(tickerShouldSleep(false, false, false)).toBe(false);
    expect(tickerShouldSleep(true, true, false)).toBe(false);
    expect(tickerShouldSleep(true, false, true)).toBe(false);
  });
});

describe('directional flow selection (dec-4)', () => {
  it('flows only mention edges with both endpoints inside the emphasis', () => {
    tagAc(AC_FLOW_EMPHASIS);
    tagAc(AC_SCOPE_DIRECTION);
    const { links } = buildSimGraph(GRAPH, { showSemantic: true });
    // Calm map: no emphasis, no flow.
    expect(flowEdgeIds(null, links).size).toBe(0);
    // Emphasis over the alpha community: exactly its mention edges flow.
    const emphasis = new Set(['a1', 'a2', 'a3']);
    expect(flowEdgeIds(emphasis, links)).toEqual(
      new Set(['mention:a1->a2', 'mention:a2->a3', 'mention:a1->a3']),
    );
    // One endpoint outside → no flow for that edge.
    expect(flowEdgeIds(new Set(['a1', 'a2']), links)).toEqual(new Set(['mention:a1->a2']));
    // Semantic edges never flow — similarity has no direction (a1/b1 are both
    // in this set via the semantic edge, which must still not flow).
    expect(flowEdgeIds(new Set(['a1', 'b1']), links).size).toBe(0);
  });
});

describe('local-graph focus set (dec-5)', () => {
  it('returns the 1-hop and 2-hop neighborhoods the depth chip switches between', () => {
    tagAc(AC_FOCUS_SET);
    tagAc(AC_SCOPE_FOCUS);
    const { links } = buildSimGraph(GRAPH, { showSemantic: true });
    // Depth 1 from b2: itself + its direct mention neighbor.
    expect(focusSetOf('b2', 1, links)).toEqual(new Set(['b2', 'b1']));
    // Depth 2 walks one hop further — through b1's semantic edge to a1.
    expect(focusSetOf('b2', 2, links)).toEqual(new Set(['b2', 'b1', 'a1']));
    // Depth 2 from a3 spans the alpha community and reaches b1 via a1's
    // semantic edge (focus walks ALL edge kinds).
    expect(focusSetOf('a3', 2, links)).toEqual(new Set(['a3', 'a1', 'a2', 'b1']));
    // An isolated node focuses to just itself at any depth.
    expect(focusSetOf('lone', 2, links)).toEqual(new Set(['lone']));
  });
});

// ── scope + licence guards (dec-1, dec-6) ────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));

describe('scope and licence guards', () => {
  it('the map consumes the unchanged StandardsGraphData payload — no server reach', () => {
    tagAc(AC_UI_CONFINED);
    // GRAPH above is typed as the existing StandardsGraphData shape and the
    // whole model runs on it — compile + runtime proof the payload contract
    // is untouched (dec-1: client-side only).
    const sim = buildSimGraph(GRAPH, { showSemantic: true });
    expect(sim.nodes).toHaveLength(GRAPH.nodes.length);
    expect(sim.links).toHaveLength(GRAPH.mentionEdges.length + GRAPH.semanticEdges.length);
    // The shell still fetches via the existing client function, and none of
    // the map sources import server code.
    const shell = readFileSync(join(here, 'StandardsMap.tsx'), 'utf8');
    expect(shell).toContain('fetchStandardsGraph');
    for (const file of ['StandardsMap.tsx', 'standards-map/model.ts', 'standards-map/renderer.ts']) {
      const src = readFileSync(join(here, file), 'utf8');
      expect(src).not.toMatch(/@memex\/server|packages\/server/);
    }
  });

  it('no standards-map file carries the .ee licence marker (fair-code, dec-6)', () => {
    tagAc(AC_NO_EE);
    const files = [
      'StandardsMap.tsx',
      'StandardsMap.spec-496.test.tsx',
      ...readdirSync(join(here, 'standards-map')).map((f) => `standards-map/${f}`),
    ];
    for (const f of files) {
      expect(f.includes('.ee')).toBe(false);
    }
  });
});

// ── the focus card UI (dec-5 / ac-15), renderer mocked ───────────────────────

const rendererInstances = vi.hoisted(
  () =>
    [] as Array<{
      callbacks: RendererCallbacks;
      options: RendererOptions;
      setFocus: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock('./standards-map/renderer', () => ({
  StandardsMapRenderer: class {
    setFocus = vi.fn();
    init = vi.fn().mockResolvedValue(undefined);
    destroy = vi.fn();
    setGraph = vi.fn();
    setSearch = vi.fn();
    setPalette = vi.fn();
    constructor(
      _palette: unknown,
      public callbacks: RendererCallbacks,
      public options: RendererOptions,
    ) {
      rendererInstances.push(this as never);
    }
  },
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, fetchStandardsGraph: vi.fn().mockResolvedValue(GRAPH) };
});

import { StandardsMap } from './StandardsMap';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

async function renderMap() {
  // tenantPath derives the /:namespace/:memex prefix from window.location
  // (std-2 path-based tenancy), not the MemoryRouter — set it explicitly.
  window.history.pushState({}, '', '/acme/team/standards');
  render(
    <MemoryRouter initialEntries={['/acme/team/standards']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <StandardsMap query="" showSemantic={false} />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(rendererInstances.length).toBeGreaterThan(0));
  return rendererInstances[rendererInstances.length - 1];
}

const NODE = {
  id: 'a1',
  handle: 'std-1',
  title: 'Alpha one',
  clauseCount: 3,
  degree: 2,
  radius: 9,
};

describe('click-to-focus shell (dec-5)', () => {
  beforeEach(() => {
    rendererInstances.length = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('single click focuses: card with handle, title, clause count and depth chip', async () => {
    tagAc(AC_FOCUS_UI);
    tagAc(AC_SCOPE_FOCUS);
    const renderer = await renderMap();
    expect(screen.queryByTestId('focus-card')).not.toBeInTheDocument();

    act(() => renderer.callbacks.onNodeFocus(NODE));
    const card = screen.getByTestId('focus-card');
    expect(card).toBeInTheDocument();
    expect(screen.getByTestId('focus-card-title').textContent).toContain('std-1');
    expect(screen.getByTestId('focus-card-title').textContent).toContain('Alpha one');
    expect(card.textContent).toContain('3 clauses');
    // The renderer is told to project the focus at depth 1.
    await waitFor(() => expect(renderer.setFocus).toHaveBeenCalledWith('a1', 1));
  });

  it('the depth chip switches the renderer between exactly 1 and 2 hops', async () => {
    tagAc(AC_FOCUS_UI);
    tagAc(AC_FOCUS_SET);
    const renderer = await renderMap();
    act(() => renderer.callbacks.onNodeFocus(NODE));
    fireEvent.click(screen.getByTestId('focus-depth-2'));
    await waitFor(() => expect(renderer.setFocus).toHaveBeenCalledWith('a1', 2));
    fireEvent.click(screen.getByTestId('focus-depth-1'));
    await waitFor(() => expect(renderer.setFocus).toHaveBeenCalledWith('a1', 1));
  });

  it('Open standard and double-click both navigate to the deep-link route', async () => {
    tagAc(AC_FOCUS_UI);
    tagAc(AC_SCOPE_FOCUS);
    const renderer = await renderMap();
    act(() => renderer.callbacks.onNodeFocus(NODE));
    fireEvent.click(screen.getByTestId('focus-card-open'));
    expect(screen.getByTestId('location').textContent).toBe('/acme/team/standards/std-1');

    // Double-click path: the renderer calls onNodeNavigate directly.
    act(() =>
      renderer.callbacks.onNodeNavigate({ ...NODE, id: 'b1', handle: 'std-4', title: 'Beta one' }),
    );
    expect(screen.getByTestId('location').textContent).toBe('/acme/team/standards/std-4');
  });

  it('Escape and background click both exit focus and restore the full map', async () => {
    tagAc(AC_FOCUS_UI);
    tagAc(AC_SCOPE_FOCUS);
    const renderer = await renderMap();
    act(() => renderer.callbacks.onNodeFocus(NODE));
    expect(screen.getByTestId('focus-card')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('focus-card')).not.toBeInTheDocument());
    expect(renderer.setFocus).toHaveBeenLastCalledWith(null, 1);

    act(() => renderer.callbacks.onNodeFocus(NODE));
    expect(screen.getByTestId('focus-card')).toBeInTheDocument();
    act(() => renderer.callbacks.onBackgroundClick());
    await waitFor(() => expect(screen.queryByTestId('focus-card')).not.toBeInTheDocument());
  });
});
