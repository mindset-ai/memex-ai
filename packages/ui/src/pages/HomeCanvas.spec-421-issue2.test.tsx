// spec-421 issue-2 — the in-Home half of Barrie's clunkiness report.
//
// Navigating to /home, the "Getting started on Memex" tracker used to first render in a
// pre-data state (the whole journey layer absent while `state === null`) and then POP into
// existence once GET /api/me/journey-state resolved — the visible flicker Barrie reported
// (sibling to issue-1, which fixed the routing half in RootRedirect).
//
// The fix applies Barrie's "assess read-only before draw" discipline to HomeCanvas: while
// the journey-state fetch is in flight, a stable-height SKELETON holds the first paint
// (no empty→populated layer pop); when state resolves the real tracker swaps in at its true
// progress. Because the skeleton (not a 0% layer) occupies the loading frame, the progress
// bar mounts fresh at its true width — no 0%→fill enter animation.
//
//   ac-21 (bug)  — the issue-2 flicker no longer reproduces (skeleton holds first paint).
//   ac-22        — skeleton shown while loading; no real layer / no 0% frame; swaps cleanly.
//   ac-23        — on resolve, true progress on first data frame (graduated 100% + ✓s;
//                  in-progress correct partial %).
//   ac-24        — journey state read fresh from the API, never persisted as source of truth.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
const postJourneyEventApi = vi.hoisted(() => vi.fn());
const fetchDocs = vi.hoisted(() => vi.fn());

vi.mock('../api/journey', () => ({ fetchJourneyStateApi, postJourneyEventApi }));
vi.mock('../api/docs', async (orig) => ({
  ...(await orig<typeof import('../api/docs')>()),
  fetchDocs,
}));
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', name: 'John Doe', email: 'john@example.com' },
    session: { memberships: [{ slug: 'john', memexSlug: 'personal', kind: 'personal' }] },
    token: 'fake',
  }),
}));
vi.mock('../hooks/useUserChangeStream', () => ({ useUserChangeStream: () => undefined }));

import { HomeCanvas } from './HomeCanvas';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-421/acs/ac-${n}`;

const ALL_STEPS = [
  'identity',
  'create-spec',
  'create-first-spec',
  'resolve-decision',
  'add-ac',
  'specs-match-reality',
  'agents-build',
] as const;

function stateFor(currentStepId: string, attained: readonly string[] = []) {
  return {
    milestones: {},
    roleCoords: null,
    currentStepId,
    steps: ALL_STEPS.map((id) => ({ id, attained: attained.includes(id) })),
    preview: false,
    canPreview: false,
  };
}

// A promise we resolve by hand, so we can observe the render WHILE the fetch is in flight.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderCanvas(entry = '/home') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <HomeCanvas />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  postJourneyEventApi.mockReset();
  postJourneyEventApi.mockResolvedValue(undefined);
  fetchDocs.mockReset();
  fetchDocs.mockResolvedValue([]);
  window.localStorage.clear();
});

describe('spec-421 issue-2 — no flicker: assess journey-state before paint', () => {
  it('holds first paint behind a skeleton while journey-state is loading — no layer pop, no 0% frame (ac-21, ac-22)', async () => {
    tagAc(AC(21));
    tagAc(AC(22));
    const d = deferred<ReturnType<typeof stateFor>>();
    fetchJourneyStateApi.mockReturnValue(d.promise);

    renderCanvas();

    // WHILE the fetch is in flight: a stable-height skeleton holds the tracker's place.
    // The real journey layer must NOT be mounted, and there must be no transient progress
    // frame (no "0% complete") that would later snap to the real value.
    expect(screen.getByTestId('journey-layer-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('journey-layer')).toBeNull();
    expect(screen.queryByTestId('journey-progress')).toBeNull();

    // Resolve to an in-progress user → the real tracker swaps in, the skeleton is gone.
    d.resolve(stateFor('create-spec', ['identity']));
    expect(await screen.findByTestId('journey-layer')).toBeInTheDocument();
    expect(screen.queryByTestId('journey-layer-skeleton')).toBeNull();
  });

  it('a completed (graduated) user sees the completed tracker on first data frame — 100% + ✓ steps (ac-23)', async () => {
    tagAc(AC(23));
    // All three visible steps attained → graduated; develop shows the completed rail (PR #382).
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('create-first-spec', ['identity', 'create-spec', 'create-first-spec']),
    );

    renderCanvas();

    await screen.findByTestId('journey-layer');
    expect(screen.getByTestId('journey-progress')).toHaveTextContent('100% complete');
    // The progress bar fill carries its true width (100%), not a 0% that animates up.
    const fill = screen.getByTestId('journey-progress-bar').firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('100%');
    // Every visible rail node shows its ✓ (attained) state.
    for (const id of ['identity', 'create-spec', 'create-first-spec']) {
      expect(screen.getByTestId(`journey-rail-node-${id}`).getAttribute('data-attained')).toBe('true');
    }
  });

  it('an in-progress user sees their correct partial state on first data frame — no empty→populated pop (ac-22, ac-23)', async () => {
    tagAc(AC(22));
    tagAc(AC(23));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', ['identity']));

    renderCanvas();

    await screen.findByTestId('journey-layer');
    // 1 of 3 visible steps attained → 33%.
    expect(screen.getByTestId('journey-progress')).toHaveTextContent('33% complete');
    expect(screen.getByTestId('journey-rail-node-identity').getAttribute('data-attained')).toBe('true');
    expect(screen.getByTestId('journey-rail-node-create-spec').getAttribute('data-attained')).toBe('false');
  });

  it('assesses journey-state read-only from the API and never persists it as source of truth (ac-24)', async () => {
    tagAc(AC(24));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', ['identity']));

    renderCanvas();
    await screen.findByTestId('journey-layer');

    // Read-only: the tracker derives from a fresh API read on load.
    expect(fetchJourneyStateApi).toHaveBeenCalled();

    // Not persisted: no journey/attainment state is written to localStorage as the source of
    // truth. (The spec-336 per-user viewing cursor is a separate, allowed concern — it stores
    // only a bare step id, never the journey-state shape.)
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)!;
      const value = window.localStorage.getItem(key) ?? '';
      expect(value).not.toContain('currentStepId');
      expect(value).not.toContain('"steps"');
      expect(value).not.toContain('attained');
    }
  });
});
