// spec-421 issue-2 — the in-Home half of Barrie's clunkiness report.
//
// Barrie (Slack 2026-06-27): the journey state was "only assessed when the page is drawn,
// so you get the old state first and then a redraw." His fix — assess it BEFORE draw, as a
// quick read-only that is NOT stored. issue-1 did this for the LANDING decision in
// RootRedirect; this is the in-Home tracker.
//
// The first attempt (a skeleton over an after-draw fetch, PR #400) did NOT follow that — it
// still assessed after draw and still redrew (skeleton→tracker). The correct fix: the app
// assesses journey-state once, read-only, and shares it IN-MEMORY (journeyStateCache); when
// the user navigates to /home, HomeCanvas seeds its first paint from that shared assessment,
// so the tracker renders already-correct on the FIRST commit — no from-null redraw.
//
//   ac-21 — the issue-2 flicker no longer reproduces (first paint is the real tracker).
//   ac-22 — on navigation, the tracker paints from the shared assessment on first render.
//   ac-23 — completed user 100%+✓ / in-progress correct % on first paint; cold load shows
//           nothing (never a wrong/0% frame) until the read resolves.
//   ac-24 — assessed read-only from the API; never persisted to localStorage / a client store.
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
import { setCachedJourneyState, resetCachedJourneyState } from '../journeys/journeyStateCache';

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
    milestones: { hasSpec: attained.includes('create-first-spec') },
    roleCoords: null,
    currentStepId,
    steps: ALL_STEPS.map((id) => ({ id, attained: attained.includes(id) })),
    preview: false,
    canPreview: false,
  };
}

const GRADUATED = stateFor('create-first-spec', ['identity', 'create-spec', 'create-first-spec']);
const IN_PROGRESS = stateFor('create-spec', ['identity']);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
  resetCachedJourneyState();
});

describe('spec-421 issue-2 — assess journey-state before draw (in-memory, shared)', () => {
  it('navigating to /home paints the completed tracker on the FIRST render from the shared assessment — no redraw (ac-21, ac-22, ac-23)', () => {
    tagAc(AC(21));
    tagAc(AC(22));
    tagAc(AC(23));
    // The app already assessed journey-state at login (RootRedirect / useShouldLandOnHome)
    // and shared it in-memory. A graduated user now navigates to Home.
    setCachedJourneyState(GRADUATED);
    fetchJourneyStateApi.mockResolvedValue(GRADUATED);

    renderCanvas();

    // FIRST COMMIT — asserted synchronously, with NO await: the tracker is already correct.
    // (Pre-fix the component initialised state=null and only an empty/skeleton frame painted
    // here; this is the line that fails until first paint is seeded from the assessment.)
    expect(screen.getByTestId('journey-layer')).toBeInTheDocument();
    expect(screen.getByTestId('journey-progress')).toHaveTextContent('100% complete');
    expect(screen.getByTestId('journey-progress-bar').firstElementChild).toHaveStyle({ width: '100%' });
    // No skeleton placeholder is rendered (the old approach is gone).
    expect(screen.queryByTestId('journey-layer-skeleton')).toBeNull();
  });

  it('an in-progress user navigating to /home sees their correct partial state on first render (ac-22, ac-23)', () => {
    tagAc(AC(22));
    tagAc(AC(23));
    setCachedJourneyState(IN_PROGRESS);
    fetchJourneyStateApi.mockResolvedValue(IN_PROGRESS);

    renderCanvas();

    // 1 of 3 visible steps attained → 33%, painted on the first commit.
    expect(screen.getByTestId('journey-progress')).toHaveTextContent('33% complete');
    expect(screen.getByTestId('journey-rail-node-identity').getAttribute('data-attained')).toBe('true');
    expect(screen.getByTestId('journey-rail-node-create-spec').getAttribute('data-attained')).toBe('false');
  });

  it('cold load with no prior assessment shows no tracker (never a wrong/0% frame) until the read resolves (ac-23)', async () => {
    tagAc(AC(23));
    // No cache seeded → cold. Hold the read so we can observe the pre-resolve frame.
    const d = deferred<ReturnType<typeof stateFor>>();
    fetchJourneyStateApi.mockReturnValue(d.promise);

    renderCanvas();

    // Before the read resolves: the tracker region renders nothing — crucially NOT a stale
    // 0%/empty tracker that would later snap to the real value.
    expect(screen.queryByTestId('journey-layer')).toBeNull();
    expect(screen.queryByTestId('journey-progress')).toBeNull();

    d.resolve(GRADUATED);
    expect(await screen.findByTestId('journey-layer')).toBeInTheDocument();
    expect(screen.getByTestId('journey-progress')).toHaveTextContent('100% complete');
  });

  it('assesses journey-state read-only from the API and never persists it to a client store (ac-24)', async () => {
    tagAc(AC(24));
    setCachedJourneyState(GRADUATED);
    fetchJourneyStateApi.mockResolvedValue(GRADUATED);

    renderCanvas();
    await screen.findByTestId('journey-layer');

    // Read-only refresh on mount (authoritative live read).
    expect(fetchJourneyStateApi).toHaveBeenCalled();
    // Not persisted: the shared assessment lives in-memory (a module variable), never in
    // localStorage / sessionStorage / any client store (Barrie: "not stored"; ac-24).
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)!;
      const value = window.localStorage.getItem(key) ?? '';
      expect(value).not.toContain('currentStepId');
      expect(value).not.toContain('"steps"');
      expect(value).not.toContain('hasSpec');
    }
  });
});
