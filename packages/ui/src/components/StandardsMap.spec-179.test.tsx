// spec-179 t-8 — the standards map model + the list ⇄ map toggle.
//
// The map's pure model (standards-map/model.ts) is tested directly — the
// PIXI/d3-force renderer needs a real WebGL canvas, so jsdom tests own the
// mapping and interaction math (sizing, weights, label fade, neighborhood),
// not the rendering. Same posture as the React Flow mapper this replaces
// (amended dec-1). The StandardList toggle is tested with the map mocked.

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  buildSimGraph,
  labelAlphaForZoom,
  neighborhoodOf,
  nodeRadius,
  searchHits,
} from './standards-map/model';
import type { StandardsGraphData } from '../api/client';

const AC_MAP = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-3';
const AC_STACK = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-7';
const AC_SEMANTIC = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-13';
const AC_TOGGLE = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-16';

const GRAPH: StandardsGraphData = {
  nodes: [
    { docId: 'd9', handle: 'std-9', title: 'Infrastructure', clauseCount: 10 },
    { docId: 'd2', handle: 'std-2', title: 'Routing', clauseCount: 5 },
    { docId: 'd7', handle: 'std-7', title: '404 not 403', clauseCount: 0 },
  ],
  mentionEdges: [
    {
      sourceDocId: 'd9',
      targetDocId: 'd2',
      count: 4,
      evidence: [{ clauseSeq: 100, snippet: 'It pairs with std-2.' }],
    },
    { sourceDocId: 'd9', targetDocId: 'd7', count: 1, evidence: [{ clauseSeq: 7, snippet: 's' }] },
  ],
  semanticEdges: [{ sourceDocId: 'd2', targetDocId: 'd7', similarity: 0.82 }],
};

describe('buildSimGraph (pure mapping)', () => {
  it('maps standards to sim nodes sized by connectedness, with handles for deep-linking', () => {
    tagAc(AC_MAP);
    const { nodes } = buildSimGraph(GRAPH, { showSemantic: false });
    expect(nodes.map((n) => n.id).sort()).toEqual(['d2', 'd7', 'd9']);
    // Node click navigates by handle (ac-16 deep-link) — the handle rides the node.
    expect(nodes.find((n) => n.id === 'd9')!.handle).toBe('std-9');
    // Connectedness: d9 cites two standards (degree 2), the others have degree 1.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get('d9')!.degree).toBe(2);
    expect(byId.get('d2')!.degree).toBe(1);
    expect(byId.get('d9')!.radius).toBeGreaterThan(byId.get('d2')!.radius);
  });

  it('weights mention links by citing count and carries evidence for the click-through', () => {
    tagAc(AC_MAP);
    const { links } = buildSimGraph(GRAPH, { showSemantic: false });
    expect(links).toHaveLength(2);
    const heavy = links.find((l) => l.id === 'mention:d9->d2')!;
    const light = links.find((l) => l.id === 'mention:d9->d7')!;
    expect(heavy.width).toBeGreaterThan(light.width);
    expect(heavy.evidence).toHaveLength(1);
    expect(heavy.kind).toBe('mention');
  });

  it('includes semantic links only when toggled, tagged as a distinct kind', () => {
    tagAc(AC_SEMANTIC);
    const off = buildSimGraph(GRAPH, { showSemantic: false });
    expect(off.links.some((l) => l.kind === 'semantic')).toBe(false);

    const on = buildSimGraph(GRAPH, { showSemantic: true });
    const semantic = on.links.find((l) => l.id === 'semantic:d2->d7')!;
    expect(semantic).toBeTruthy();
    expect(semantic.kind).toBe('semantic'); // renderer draws this kind dashed
    expect(semantic.similarity).toBe(0.82);
    // Mention links keep their kind — solid in the renderer.
    expect(on.links.find((l) => l.id === 'mention:d9->d2')!.kind).toBe('mention');
  });

  it('node radius grows monotonically with degree and stays bounded', () => {
    tagAc(AC_MAP);
    expect(nodeRadius(0)).toBeLessThan(nodeRadius(1));
    expect(nodeRadius(1)).toBeLessThan(nodeRadius(9));
    expect(nodeRadius(1000)).toBeLessThanOrEqual(18);
  });
});

describe('interaction math (hover neighborhood + label fade)', () => {
  it('label cards are fully present at the initial fit and fade away zooming out', () => {
    tagAc(AC_MAP);
    // Fully legible at the initial fit (autoFit caps at 1×)…
    expect(labelAlphaForZoom(1)).toBe(1);
    expect(labelAlphaForZoom(0.9)).toBe(1);
    expect(labelAlphaForZoom(4)).toBe(1);
    // …fading as you zoom out toward the constellation view.
    expect(labelAlphaForZoom(0.7)).toBeGreaterThan(0);
    expect(labelAlphaForZoom(0.7)).toBeLessThan(1);
    expect(labelAlphaForZoom(0.8)).toBeGreaterThan(labelAlphaForZoom(0.6));
    expect(labelAlphaForZoom(0.5)).toBe(0);
    expect(labelAlphaForZoom(0.2)).toBe(0);
  });

  it('searchHits matches handle and title case-insensitively; empty query = no search', () => {
    tagAc(AC_MAP);
    expect(searchHits(GRAPH, '')).toBeNull();
    expect(searchHits(GRAPH, '   ')).toBeNull();
    expect(searchHits(GRAPH, 'ROUTING')).toEqual(new Set(['d2']));
    expect(searchHits(GRAPH, 'std-9')).toEqual(new Set(['d9']));
    // Substring across both fields; no match → empty set (everything dims).
    expect(searchHits(GRAPH, '40')).toEqual(new Set(['d7']));
    expect(searchHits(GRAPH, 'zzz')).toEqual(new Set());
  });

  it('neighborhoodOf returns the node plus everything one link away', () => {
    tagAc(AC_MAP);
    const { links } = buildSimGraph(GRAPH, { showSemantic: true });
    expect(neighborhoodOf('d9', links)).toEqual(new Set(['d9', 'd2', 'd7']));
    // d2 touches d9 by mention and d7 by semantic overlay.
    expect(neighborhoodOf('d2', links)).toEqual(new Set(['d2', 'd9', 'd7']));
  });
});

describe('rendering stack (amended ac-7: pixi.js + d3-force, no @xyflow)', () => {
  it('the standards map is built on pixi.js + d3-force and no longer imports @xyflow', () => {
    tagAc(AC_STACK);
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    const component = read('./StandardsMap.tsx');
    const renderer = read('./standards-map/renderer.ts');
    const model = read('./standards-map/model.ts');

    expect(renderer).toContain("from 'pixi.js'");
    expect(renderer).toContain("from 'd3-force'");
    for (const src of [component, renderer, model]) {
      expect(src).not.toContain('@xyflow');
    }
  });
});

// ── list ⇄ map toggle on /standards (ac-16) ──────────────────────────────────

// Stub the whole map component: the toggle owns list⇄map switching, and the
// real component would pull pixi.js into jsdom.
vi.mock('./StandardsMap', () => ({
  StandardsMap: () => <div data-testid="mock-standards-map" />,
}));
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    fetchDocs: vi.fn().mockResolvedValue([
      {
        id: 'd1',
        handle: 'std-1',
        title: 'A standard',
        docType: 'standard',
        status: 'approved',
        createdAt: '2026-06-01T00:00:00Z',
        driftCount: 0,
      },
    ]),
  };
});
vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));
vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Tester', email: 't@acme.test' },
    session: {
      user: { name: 'Tester', email: 't@acme.test' },
      memberships: [
        {
          memexId: 'm1',
          slug: 'acme',
          memexSlug: 'team',
          name: 'Acme Inc',
          memexName: 'Team',
          kind: 'team',
          role: 'administrator',
        },
      ],
      currentMemexId: 'm1',
    },
    logout: vi.fn(),
  }),
}));

import { StandardList } from '../pages/StandardList';

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/acme/team/standards']}>
      <StandardList />
    </MemoryRouter>,
  );
}

describe('StandardList view toggle (ac-16)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to list, switches to map on click, and persists the choice', async () => {
    tagAc(AC_TOGGLE);
    const { unmount } = renderList();
    await waitFor(() => expect(screen.getByTestId('standards-view-toggle')).toBeInTheDocument());
    expect(screen.queryByTestId('mock-standards-map')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('standard-card').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('standards-view-map'));
    expect(screen.getByTestId('mock-standards-map')).toBeInTheDocument();
    expect(screen.queryByTestId('standard-card')).not.toBeInTheDocument();

    // Persistence: a fresh mount restores map mode.
    unmount();
    renderList();
    await waitFor(() => expect(screen.getByTestId('mock-standards-map')).toBeInTheDocument());
  });

  it('the search box is present in both views; the semantic toggle only on the map', async () => {
    tagAc(AC_TOGGLE);
    tagAc(AC_SEMANTIC);
    renderList();
    await waitFor(() => expect(screen.getByTestId('standards-view-toggle')).toBeInTheDocument());
    // List view: search yes, semantic no.
    expect(screen.getByTestId('standards-search')).toBeInTheDocument();
    expect(screen.queryByTestId('semantic-toggle')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('standards-view-map'));
    // Map view: same search input (state survives the switch), semantic appears.
    expect(screen.getByTestId('standards-search')).toBeInTheDocument();
    expect(screen.getByTestId('semantic-toggle')).toBeInTheDocument();
  });

  it('switching back to list restores the cards', async () => {
    tagAc(AC_TOGGLE);
    renderList();
    await waitFor(() => expect(screen.getByTestId('standards-view-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('standards-view-map'));
    expect(screen.getByTestId('mock-standards-map')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('standards-view-list'));
    await waitFor(() => expect(screen.getAllByTestId('standard-card').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('mock-standards-map')).not.toBeInTheDocument();
  });
});
