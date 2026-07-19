// spec-498 — Brain: the whole-vault knowledge graph view. The pure mapper
// (components/brain/model.ts) is tested directly; the shared WebGL engine
// stays browser-only, so the page shell is tested with the renderer mocked
// (the spec-496 posture). Scope + licence guards close the file.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { brainPalette, buildBrainGraph, type BrainNode } from '../components/brain/model';
import { MAP_PALETTES, nodeColor } from '../components/standards-map/model';
import { CHART_PALETTES } from '../components/insights/theme';
import type { KnowledgeGraphData } from '../api/insights';
import type { RendererCallbacks, RendererOptions } from '../components/standards-map/renderer';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-498';
const AC_SCOPE_SURFACE = `${SPEC}/acs/ac-1`;
const AC_SCOPE_COLOURS = `${SPEC}/acs/ac-2`;
const AC_SCOPE_DRIFT_RED = `${SPEC}/acs/ac-3`;
const AC_SCOPE_CLICK_THROUGH = `${SPEC}/acs/ac-4`;
const AC_SCOPE_FILTER_REUSE = `${SPEC}/acs/ac-5`;
const AC_MAPPER = `${SPEC}/acs/ac-6`;
const AC_OVERRIDES = `${SPEC}/acs/ac-7`;
const AC_PALETTE_BINDING = `${SPEC}/acs/ac-8`;
const AC_DRIFT_OVERRIDE = `${SPEC}/acs/ac-9`;
const AC_EDGESET_FILTER = `${SPEC}/acs/ac-10`;
const AC_NO_EE = `${SPEC}/acs/ac-13`;
const AC_DISCIPLINE_LABEL = `${SPEC}/acs/ac-14`;
const AC_DRIFT_INBOX = `${SPEC}/acs/ac-15`;
const AC_DISCIPLINE_SELECT = `${SPEC}/acs/ac-16`;

// A small vault: two facets, two standards (one drifted), one spec owning two
// decisions (one drifted), a mention edge, a semantic edge (must be dropped),
// and one linked drift edge. The api mock below closes over it (vi.hoisted).
const KG: KnowledgeGraphData = vi.hoisted(() => ({
  nodes: {
    facets: [
      {
        id: 'f-sec',
        key: 'security',
        name: 'Security',
        description: 'Auth, tenancy, secrets.',
        ord: 0,
        standardCount: 1,
        decisionCount: 1,
      },
      {
        id: 'f-perf',
        key: 'performance',
        name: null,
        description: '',
        ord: 1,
        standardCount: 0,
        decisionCount: 0,
      },
    ],
    standards: [
      {
        docId: 's-clean',
        handle: 'std-1',
        title: 'Clean standard',
        clauseCount: 4,
        taggedClauseCount: 2,
        openDriftCount: 0,
      },
      {
        docId: 's-drift',
        handle: 'std-2',
        title: 'Drifted standard',
        clauseCount: 2,
        taggedClauseCount: 0,
        openDriftCount: 1,
      },
    ],
    specs: [
      { docId: 'sp-1', handle: 'spec-9', title: 'The owning spec', status: 'build', decisionCount: 2 },
    ],
    decisions: [
      {
        id: 'd-ok',
        handle: 'dec-1',
        title: 'A settled decision',
        status: 'resolved',
        resolvedAt: '2026-07-01T00:00:00.000Z',
      },
      { id: 'd-bad', handle: 'dec-2', title: 'A drifting decision', status: 'resolved', resolvedAt: null },
    ],
  },
  edges: {
    specDecision: [
      { specDocId: 'sp-1', decisionId: 'd-ok' },
      { specDocId: 'sp-1', decisionId: 'd-bad' },
    ],
    standardFacet: [
      {
        standardDocId: 's-clean',
        facetId: 'f-sec',
        clauseCount: 2,
        evidence: [{ clauseHandle: 'cl-3', snippet: 'Rotate the tokens.' }],
      },
    ],
    decisionFacet: [{ decisionId: 'd-ok', facetId: 'f-sec' }],
    mentions: [
      { sourceDocId: 's-clean', targetDocId: 's-drift', count: 2, evidence: [] },
    ],
    semantic: [{ sourceDocId: 's-clean', targetDocId: 's-drift', similarity: 0.8 }],
    drift: [
      {
        decisionId: 'd-bad',
        standardDocId: 's-drift',
        sectionId: 'sec-1',
        commentId: 'c-1',
        openedAt: '2026-07-10T00:00:00.000Z',
      },
    ],
  },
  meta: {
    decisionFilter: 'resolved' as const,
    truncated: false,
    counts: { facets: 2, standards: 2, specs: 5, decisions: 7 },
  },
}));

const PALETTE = brainPalette('dark');

// ── the pure mapper (dec-1 / ac-6) ───────────────────────────────────────────

describe('buildBrainGraph (dec-1)', () => {
  it('projects every entity type with stable ids, labels, and per-type hrefs', () => {
    tagAc(AC_MAPPER);
    tagAc(AC_SCOPE_CLICK_THROUGH);
    const { nodes } = buildBrainGraph(KG, PALETTE);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(nodes).toHaveLength(7); // 2 facets + 2 standards + 1 spec + 2 decisions

    const facet = byId.get('f-sec')!;
    expect(facet.kind).toBe('facet');
    expect(facet.handle).toBe('security');
    expect(facet.title).toBe('Security');
    // A facet's key IS its name, so the engine's default `handle · title`
    // label would duplicate ("security · Security") — facets carry a label
    // override of the display name alone; other kinds keep the default.
    expect(facet.label).toBe('Security');
    expect(byId.get('s-clean')!.label).toBeUndefined();
    expect(facet.href).toBeNull(); // no facet page — no dead deep link (std-34)
    expect(facet.detail).toContain('1 standard');
    expect(facet.detail).toContain('1 decision');
    // A null facet name degrades to the key.
    expect(byId.get('f-perf')!.title).toBe('performance');
    expect(byId.get('f-perf')!.label).toBe('performance');

    expect(byId.get('s-clean')!.href).toBe('/standards/std-1');
    expect(byId.get('sp-1')!.href).toBe('/specs/spec-9');
    // Decisions deep-link through their owning spec (the specDecision join).
    expect(byId.get('d-ok')!.href).toBe('/specs/spec-9/decisions/dec-1');
    expect(byId.get('d-bad')!.href).toBe('/specs/spec-9/decisions/dec-2');
  });

  it('links carry containment, ballots, clause tags, mentions, and drift — endpoints always present', () => {
    tagAc(AC_MAPPER);
    const { links, nodes } = buildBrainGraph(KG, PALETTE);
    const rels = links.map((l) => l.rel).sort();
    expect(rels).toEqual(
      ['decision-facet', 'drift', 'mention', 'spec-decision', 'spec-decision', 'standard-facet'].sort(),
    );
    // standard→facet evidence is adapted to the shared EvidenceItem shape.
    const sf = links.find((l) => l.rel === 'standard-facet')!;
    expect(sf.evidence).toEqual([{ clauseSeq: 3, snippet: 'Rotate the tokens.' }]);
    // Every link endpoint resolves to a node the sim will know about.
    const present = new Set(nodes.map((n) => n.id));
    for (const l of links) {
      expect(present.has(l.source as string)).toBe(true);
      expect(present.has(l.target as string)).toBe(true);
    }
    // A drift edge whose decision the filter excluded is skipped, not dangling.
    const filtered: KnowledgeGraphData = {
      ...KG,
      nodes: { ...KG.nodes, decisions: [], specs: [] },
      edges: { ...KG.edges, specDecision: [], decisionFacet: [] },
    };
    const sparse = buildBrainGraph(filtered, PALETTE);
    expect(sparse.links.some((l) => l.rel === 'drift')).toBe(false);
    // …and the drifted standard still reads rose via openDriftCount.
    expect(sparse.nodes.find((n) => n.id === 's-drift')!.color).toBe(PALETTE.drift);
  });

  it('drops semantic-similarity edges entirely (dec-3)', () => {
    tagAc(AC_EDGESET_FILTER);
    tagAc(AC_SCOPE_FILTER_REUSE);
    const { links } = buildBrainGraph(KG, PALETTE);
    // The payload carries a semantic edge; the Brain graph must not.
    expect(KG.edges.semantic).toHaveLength(1);
    expect(links.some((l) => l.id.startsWith('semantic'))).toBe(false);
    // The one mention link is the only standard↔standard edge drawn.
    expect(links.filter((l) => l.rel === 'mention')).toHaveLength(1);
  });
});

// ── colour encoding (dec-2 / ac-8, ac-9) ─────────────────────────────────────

describe('colour encoding (dec-2)', () => {
  it('brainPalette binds every hue to CHART_PALETTES, both themes (std-27)', () => {
    tagAc(AC_PALETTE_BINDING);
    tagAc(AC_SCOPE_COLOURS);
    const hex = (s: string) => parseInt(s.slice(1), 16);
    for (const theme of ['dark', 'light'] as const) {
      const p = CHART_PALETTES[theme];
      expect(brainPalette(theme)).toEqual({
        facet: hex(p.phase.specify),
        spec: hex(p.phase.build),
        decision: hex(p.phase.verify),
        standard: hex(p.phase.done),
        drift: hex(p.verification.failing),
      });
    }
    // The five hues are pairwise distinct — the legend is readable.
    const values = Object.values(brainPalette('dark'));
    expect(new Set(values).size).toBe(values.length);
  });

  it('open drift turns both endpoints and the edge rose, overriding type hues', () => {
    tagAc(AC_DRIFT_OVERRIDE);
    tagAc(AC_SCOPE_DRIFT_RED);
    tagAc(AC_DRIFT_INBOX);
    const { nodes, links } = buildBrainGraph(KG, PALETTE);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // Clean nodes wear their type hues…
    expect(byId.get('f-sec')!.color).toBe(PALETTE.facet);
    expect(byId.get('sp-1')!.color).toBe(PALETTE.spec);
    expect(byId.get('d-ok')!.color).toBe(PALETTE.decision);
    expect(byId.get('s-clean')!.color).toBe(PALETTE.standard);
    // …drift turns the touched standard AND the sourcing decision rose.
    expect(byId.get('s-drift')!.color).toBe(PALETTE.drift);
    expect(byId.get('s-drift')!.drifted).toBe(true);
    expect(byId.get('d-bad')!.color).toBe(PALETTE.drift);
    expect(byId.get('d-bad')!.drifted).toBe(true);
    // The drift edge is the only colour-overridden link, in rose, and wider —
    // and it carries the Drift-Inbox deep link to THAT drift item: the standard
    // filter (?doc=std-2) plus the specific comment (&drift=c-1) (ac-15).
    const drift = links.find((l) => l.rel === 'drift')!;
    expect(drift.color).toBe(PALETTE.drift);
    expect(drift.width).toBeGreaterThan(1);
    expect(drift.href).toBe('/drift?doc=std-2&drift=c-1');
    for (const l of links) {
      if (l.rel !== 'drift') {
        expect(l.color).toBeUndefined();
        expect(l.href).toBeUndefined();
      }
    }
  });

  it('the engine honours colour overrides and is untouched without them (dec-1)', () => {
    tagAc(AC_OVERRIDES);
    const palette = MAP_PALETTES.dark;
    // Override wins over cluster and neutral…
    expect(nodeColor({ cluster: 0, color: 0x123456 }, palette)).toBe(0x123456);
    expect(nodeColor({ color: PALETTE.drift }, palette)).toBe(PALETTE.drift);
    // …absent, the spec-496 behaviour is bit-identical.
    expect(nodeColor({ cluster: undefined }, palette)).toBe(palette.node);
    expect(nodeColor({ cluster: 1 }, palette)).toBe(palette.clusterHues[1]);
  });
});

// ── the page shell (renderer mocked) ─────────────────────────────────────────

const rendererInstances = vi.hoisted(
  () =>
    [] as Array<{
      callbacks: RendererCallbacks;
      options: RendererOptions;
      setGraph: ReturnType<typeof vi.fn>;
      setFocus: ReturnType<typeof vi.fn>;
      frameFocus: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock('../components/standards-map/renderer', () => ({
  StandardsMapRenderer: class {
    setFocus = vi.fn();
    init = vi.fn().mockResolvedValue(undefined);
    destroy = vi.fn();
    setGraph = vi.fn();
    setSearch = vi.fn();
    setPalette = vi.fn();
    frameFocus = vi.fn();
    nodeScreenPosition = vi.fn().mockReturnValue(null);
    nodeFill = vi.fn().mockReturnValue(null);
    constructor(
      _palette: unknown,
      public callbacks: RendererCallbacks,
      public options: RendererOptions,
    ) {
      rendererInstances.push(this as never);
    }
  },
}));

vi.mock('../api/insights', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/insights')>();
  return { ...actual, fetchKnowledgeGraph: vi.fn().mockResolvedValue(KG) };
});

// PageHeader pulls auth/tenant context this suite doesn't exercise — stub it
// to its structural contract (title + actions slot).
vi.mock('../components/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div>
      <span>{title}</span>
      {actions}
    </div>
  ),
}));

import { Brain } from './Brain';
import { fetchKnowledgeGraph } from '../api/insights';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

async function renderBrain() {
  // tenantPath derives the /:namespace/:memex prefix from window.location
  // (std-2 path-based tenancy), not the MemoryRouter — set it explicitly.
  window.history.pushState({}, '', '/acme/team/brain');
  render(
    <MemoryRouter initialEntries={['/acme/team/brain']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Brain />
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

const DECISION_NODE: BrainNode = {
  id: 'd-ok',
  kind: 'decision',
  handle: 'dec-1',
  title: 'A settled decision',
  clauseCount: 0,
  degree: 2,
  radius: 8,
  color: PALETTE.decision,
  href: '/specs/spec-9/decisions/dec-1',
  detail: 'decision — resolved',
  drifted: false,
};

const FACET_NODE: BrainNode = {
  id: 'f-sec',
  kind: 'facet',
  handle: 'security',
  title: 'Security',
  clauseCount: 0,
  degree: 2,
  radius: 8,
  color: PALETTE.facet,
  href: null,
  detail: 'Auth, tenancy, secrets. — 1 standard, 1 decision',
  drifted: false,
};

describe('Brain page shell', () => {
  beforeEach(() => {
    rendererInstances.length = 0;
    vi.mocked(fetchKnowledgeGraph).mockClear();
    // A fresh object per call — a refetch must produce a new state value
    // (React bails out on identical references), exactly as the real client does.
    vi.mocked(fetchKnowledgeGraph).mockImplementation(async () => ({ ...KG }));
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the map surface with the always-visible five-entry legend', async () => {
    tagAc(AC_SCOPE_SURFACE);
    tagAc(AC_SCOPE_COLOURS);
    tagAc(AC_DISCIPLINE_LABEL);
    await renderBrain();
    expect(screen.getByTestId('brain-map-canvas')).toBeTruthy();
    const legend = screen.getByTestId('brain-legend');
    // dec-6: the facet entity displays as "Discipline" on this surface.
    for (const label of ['Discipline', 'Spec', 'Decision', 'Standard', 'Drift (open)']) {
      expect(legend.textContent).toContain(label);
    }
    expect(legend.textContent).not.toContain('Facet');
  });

  it('the discipline selector focuses like a click and glides the node into view (dec-7)', async () => {
    tagAc(AC_DISCIPLINE_SELECT);
    tagAc(AC_EDGESET_FILTER);
    tagAc(AC_SCOPE_FILTER_REUSE);
    const renderer = await renderBrain();
    // The decisions filter is pinned to the API's resolved default — no
    // filter control exists.
    expect(fetchKnowledgeGraph).toHaveBeenCalledWith();
    expect(screen.queryByTestId('brain-decision-filter')).toBeNull();

    // The one dropdown lists every discipline by display name.
    const select = screen.getByTestId('brain-discipline-select') as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toContain('Security');
    expect(labels).toContain('performance'); // null name degrades to the key

    // Selecting runs the click path: focus card + renderer projection + glide.
    fireEvent.change(select, { target: { value: 'security' } });
    const card = screen.getByTestId('brain-focus-card');
    expect(card.textContent).toContain('Discipline');
    expect(card.textContent).toContain('Security');
    await waitFor(() => expect(renderer.setFocus).toHaveBeenCalledWith('f-sec', 1));
    // The selector glide-zooms to frame the discipline + its neighbourhood (depth 1).
    expect(renderer.frameFocus).toHaveBeenCalledWith('f-sec', 1);
    expect(select.value).toBe('security');

    // Escape clears focus AND returns the selector to its placeholder.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('brain-focus-card')).toBeNull();
    expect(select.value).toBe('');
  });

  it('single click focuses: type-labelled card, detail line, depth chip; Open deep-links per type', async () => {
    tagAc(AC_SCOPE_CLICK_THROUGH);
    const renderer = await renderBrain();
    act(() => renderer.callbacks.onNodeFocus(DECISION_NODE));

    const card = screen.getByTestId('brain-focus-card');
    expect(card.textContent).toContain('Decision');
    expect(card.textContent).toContain('dec-1');
    expect(card.textContent).toContain('A settled decision');
    expect(screen.getByTestId('brain-focus-detail').textContent).toContain('resolved');

    // Depth chip flips 1 ⇄ 2 and projects into the renderer.
    fireEvent.click(screen.getByTestId('brain-focus-depth-2'));
    expect(screen.getByTestId('brain-focus-depth-2').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(renderer.setFocus).toHaveBeenCalledWith('d-ok', 2));

    // Open lands on the decision's canonical deep link, tenant-prefixed (std-2/std-10).
    fireEvent.click(screen.getByTestId('brain-focus-open'));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/acme/team/specs/spec-9/decisions/dec-1',
      ),
    );
  });

  it('facets show as Discipline with description + counts and no Open action (no page to open)', async () => {
    tagAc(AC_SCOPE_CLICK_THROUGH);
    tagAc(AC_DISCIPLINE_LABEL);
    tagAc(AC_DRIFT_INBOX);
    const renderer = await renderBrain();
    act(() => renderer.callbacks.onNodeFocus(FACET_NODE));
    // dec-6: the kind label reads "Discipline" (display-only rename).
    const card = screen.getByTestId('brain-focus-card');
    expect(card.textContent).toContain('Discipline');
    expect(card.textContent).not.toContain('Facet');
    // The mono handle is hidden for facets — the key would just repeat the
    // name ("security Security"), so only the display name renders (ac-15).
    expect(screen.getByTestId('brain-focus-title').textContent).not.toContain('security');
    expect(screen.getByTestId('brain-focus-title').textContent).toContain('Security');
    expect(screen.getByTestId('brain-focus-detail').textContent).toContain('1 standard');
    expect(screen.queryByTestId('brain-focus-open')).toBeNull();
  });

  it('clicking a drift edge lands on THAT drift item in the Drift Inbox', async () => {
    tagAc(AC_DRIFT_INBOX);
    tagAc(AC_SCOPE_DRIFT_RED);
    const renderer = await renderBrain();
    const driftLink = {
      id: 'drift:d-bad->s-drift',
      source: 'd-bad',
      target: 's-drift',
      kind: 'mention' as const,
      width: 1.6,
      rel: 'drift' as const,
      color: PALETTE.drift,
      href: '/drift?doc=std-2&drift=c-1',
    };
    act(() => renderer.callbacks.onEdgeClick(driftLink));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/acme/team/drift?doc=std-2&drift=c-1',
      ),
    );
    // No evidence panel opens for a drift edge — the inbox IS the detail view.
    expect(screen.queryByTestId('brain-edge-evidence')).toBeNull();
  });

  it('drift tour: the navigator frames each open drift and the card deep-links to THAT item', async () => {
    tagAc(AC_SCOPE_DRIFT_RED);
    tagAc(AC_SCOPE_CLICK_THROUGH);
    tagAc(AC_DRIFT_INBOX);
    const renderer = await renderBrain();

    // The navigator headlines the open-drift count; no card until the tour starts.
    const nav = screen.getByTestId('brain-drift-nav');
    expect(nav.textContent).toContain('1 open drift');
    expect(screen.queryByTestId('brain-drift-card')).toBeNull();

    // Starting the tour frames + pins the drifting DECISION (so its rose edge to
    // the contradicted standard is the hero) and opens the drift card.
    fireEvent.click(nav);
    await waitFor(() => expect(renderer.frameFocus).toHaveBeenCalledWith('d-bad', 1));
    expect(renderer.setFocus).toHaveBeenCalledWith('d-bad', 1);

    // The card reads as a relationship: decision ✗ contradicts standard.
    const card = screen.getByTestId('brain-drift-card');
    expect(card.textContent).toContain('Drift 1 of 1');
    expect(card.textContent).toContain('dec-2');
    expect(card.textContent).toContain('A drifting decision');
    expect(card.textContent).toContain('contradicts');
    expect(card.textContent).toContain('std-2');
    expect(card.textContent).toContain('Drifted standard');
    expect(screen.getByTestId('brain-drift-position').textContent).toContain('Drift 1 / 1');

    // Open drift → lands on THAT exact item: standard filter + specific comment.
    fireEvent.click(screen.getByTestId('brain-drift-open'));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/acme/team/drift?doc=std-2&drift=c-1'),
    );
  });

  it('drift tour: stepper + arrow keys re-frame, ✕ exits, and a discipline select leaves the tour', async () => {
    tagAc(AC_SCOPE_DRIFT_RED);
    const renderer = await renderBrain();
    fireEvent.click(screen.getByTestId('brain-drift-nav'));
    expect(screen.getByTestId('brain-drift-card')).toBeTruthy();

    // Next button and → key both re-frame (a single drift wraps to itself).
    renderer.frameFocus.mockClear();
    fireEvent.click(screen.getByTestId('brain-drift-next'));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(renderer.frameFocus).toHaveBeenCalledWith('d-bad', 1);
    expect(renderer.frameFocus).toHaveBeenCalledTimes(2);

    // ✕ exits the tour → card gone, navigator back to its entry pill.
    fireEvent.click(screen.getByTestId('brain-drift-close'));
    expect(screen.queryByTestId('brain-drift-card')).toBeNull();
    expect(screen.getByTestId('brain-drift-nav').textContent).toContain('1 open drift');

    // Selecting a discipline while touring leaves the tour (mutually exclusive).
    fireEvent.click(screen.getByTestId('brain-drift-nav'));
    fireEvent.change(screen.getByTestId('brain-discipline-select'), {
      target: { value: 'security' },
    });
    expect(screen.queryByTestId('brain-drift-card')).toBeNull();
    expect(screen.getByTestId('brain-focus-card')).toBeTruthy();
  });

  it('an empty vault explains itself instead of rendering a blank canvas', async () => {
    tagAc(AC_SCOPE_SURFACE);
    const EMPTY: KnowledgeGraphData = {
      nodes: { facets: [], standards: [], specs: [], decisions: [] },
      edges: { specDecision: [], standardFacet: [], decisionFacet: [], mentions: [], semantic: [], drift: [] },
      meta: { decisionFilter: 'resolved', truncated: false, counts: { facets: 0, standards: 0, specs: 0, decisions: 0 } },
    };
    vi.mocked(fetchKnowledgeGraph).mockImplementation(async () => ({ ...EMPTY }));
    await renderBrain();
    const empty = await screen.findByTestId('brain-empty');
    expect(empty.textContent).toContain('Nothing to map yet');
    // No graph → nothing for the discipline selector to list, just the placeholder.
    const select = screen.getByTestId('brain-discipline-select') as HTMLSelectElement;
    expect(select.options).toHaveLength(1);
    cleanup();

    // With unresolved-only decisions, the copy says so (resolved ones join).
    rendererInstances.length = 0;
    vi.mocked(fetchKnowledgeGraph).mockImplementation(async () => ({
      ...EMPTY,
      meta: { ...EMPTY.meta, counts: { ...EMPTY.meta.counts, decisions: 3 } },
    }));
    await renderBrain();
    expect(screen.getByTestId('brain-empty').textContent).toContain('none are resolved yet');
    cleanup();

    // A populated graph shows no empty-state veil.
    rendererInstances.length = 0;
    vi.mocked(fetchKnowledgeGraph).mockImplementation(async () => ({ ...KG }));
    await renderBrain();
    expect(screen.queryByTestId('brain-empty')).toBeNull();
  });

  it('double-click navigates directly; Escape and background click restore', async () => {
    tagAc(AC_SCOPE_CLICK_THROUGH);
    const renderer = await renderBrain();
    act(() => renderer.callbacks.onNodeNavigate(DECISION_NODE));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/acme/team/specs/spec-9/decisions/dec-1',
      ),
    );

    act(() => renderer.callbacks.onNodeFocus(FACET_NODE));
    expect(screen.getByTestId('brain-focus-card')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('brain-focus-card')).toBeNull();

    act(() => renderer.callbacks.onNodeFocus(FACET_NODE));
    act(() => renderer.callbacks.onBackgroundClick());
    expect(screen.queryByTestId('brain-focus-card')).toBeNull();
  });
});

// ── licence guard (dec-5 / ac-13) ────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));

describe('licence guard', () => {
  it('no Brain file carries the .ee licence marker (fair-code, dec-5)', () => {
    tagAc(AC_NO_EE);
    const files = [
      'Brain.tsx',
      'Brain.spec-498.test.tsx',
      '../components/brain/model.ts',
    ];
    for (const f of files) {
      expect(f.includes('.ee')).toBe(false);
      // The file genuinely exists where the guard claims it does.
      expect(readFileSync(join(here, f), 'utf8').length).toBeGreaterThan(0);
    }
  });
});
