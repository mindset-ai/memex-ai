// spec-179 t-6 — the standards map data mapping + the list ⇄ map toggle.
//
// buildStandardsMapData is tested as a pure function (same posture as
// TaskGraph's buildTaskGraphData — React Flow's canvas needs real layout, so
// jsdom tests own the mapping, not the rendering). The StandardList toggle is
// tested with the map component mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { buildStandardsMapData } from './StandardsMap';
import type { StandardsGraphData } from '../api/client';

const AC_MAP = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-3';
const AC_XYFLOW = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-7';
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

describe('buildStandardsMapData (pure mapping)', () => {
  it('maps standards to nodes (handle-ordered, deterministic ring) with handles for deep-linking', () => {
    tagAc(AC_MAP);
    tagAc(AC_XYFLOW);
    const { nodes } = buildStandardsMapData(GRAPH, { showSemantic: false });
    expect(nodes.map((n) => n.id)).toEqual(['d2', 'd7', 'd9']); // numeric handle order
    // Node click navigates by handle (ac-16 deep-link) — the handle must ride the node data.
    expect(nodes.map((n) => (n.data as { handle: string }).handle)).toEqual([
      'std-2',
      'std-7',
      'std-9',
    ]);
    // Deterministic: same input → same positions.
    const again = buildStandardsMapData(GRAPH, { showSemantic: false });
    expect(again.nodes.map((n) => n.position)).toEqual(nodes.map((n) => n.position));
  });

  it('weights mention edges by citing count and carries evidence for the click-through', () => {
    tagAc(AC_MAP);
    const { edges } = buildStandardsMapData(GRAPH, { showSemantic: false });
    expect(edges).toHaveLength(2);
    const heavy = edges.find((e) => e.id === 'mention:d9->d2')!;
    const light = edges.find((e) => e.id === 'mention:d9->d7')!;
    const width = (e: typeof heavy) => Number((e.style as { strokeWidth: number }).strokeWidth);
    expect(width(heavy)).toBeGreaterThan(width(light));
    expect((heavy.data as { evidence: unknown[] }).evidence).toHaveLength(1);
  });

  it('includes semantic edges only when toggled, visually distinct (dashed)', () => {
    tagAc(AC_SEMANTIC);
    const off = buildStandardsMapData(GRAPH, { showSemantic: false });
    expect(off.edges.some((e) => e.id.startsWith('semantic:'))).toBe(false);

    const on = buildStandardsMapData(GRAPH, { showSemantic: true });
    const semantic = on.edges.find((e) => e.id === 'semantic:d2->d7')!;
    expect(semantic).toBeTruthy();
    expect((semantic.style as { strokeDasharray: string }).strokeDasharray).toBeTruthy();
    expect((semantic.data as { similarity: number }).similarity).toBe(0.82);
    // Mention edges are solid — no dash.
    const mention = on.edges.find((e) => e.id === 'mention:d9->d2')!;
    expect((mention.style as { strokeDasharray?: string }).strokeDasharray).toBeUndefined();
  });
});

// ── list ⇄ map toggle on /standards (ac-16) ──────────────────────────────────

vi.mock('./StandardsMap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./StandardsMap')>();
  return { ...actual, StandardsMap: () => <div data-testid="mock-standards-map" /> };
});
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
