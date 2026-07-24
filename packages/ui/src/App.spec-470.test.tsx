// spec-470 t-3 (dec-9) — auto-land spec-less users on /home so they reach the
// build-prompt hero. RootRedirect sends an authenticated, email-verified,
// spec-less (hasSpec=false) user to /home; a has-spec user still lands on their
// Specs board (spec-461 behaviour preserved for that cohort). This REVERSES
// spec-461 dec-1 for the spec-less cohort only, approved by spec-461's owner.
//
//   ac-13 — spec-less → /home after the welcome gate; has-spec → Specs board.
//   ac-14 — 'home' feature-hidden → spec-less falls back to the board (rollback).
//   ac-10 — upstream gates fire AHEAD of the /home landing. (The welcome-video half
//           of this was removed by spec-507; the isFeatureHidden 'home' ordering stands.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SessionPayload } from './api/client';
import type { JourneyStateResponse } from './api/journey';
import { resetCachedJourneyState } from './journeys/journeyStateCache';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-470/acs/ac-${n}`;

let mockSession: SessionPayload;
function makeSession(opts: { hiddenFeatures?: string[] }): SessionPayload {
  return {
    user: {
      id: 'u-1',
      email: 'alice@example.com',
      name: 'Alice',
      status: 'active',
      emailVerified: true,
      videoWelcomedAt: null,
    },
    memberships: [
      {
        memexId: 'mx-alice',
        slug: 'alice',
        memexSlug: 'personal',
        name: 'Personal Memex',
        kind: 'personal' as const,
        role: 'administrator' as const,
      },
    ],
    currentMemexId: 'mx-alice',
    currentRole: 'administrator' as const,
    needsOnboarding: false,
    hiddenFeatures: opts.hiddenFeatures ?? [],
  };
}

function journeyState(hasSpec: boolean): JourneyStateResponse {
  return {
    milestones: {
      identityConfirmed: true,
      mcpConnected: true,
      mcpToolCalled: false,
      hasSpec,
      hasResolvedDecision: false,
      hasAc: false,
      acVerified: false,
      planGrounded: false,
    },
    roleCoords: null,
    currentStepId: hasSpec ? 'done' : 'create-first-spec',
    steps: [
      { id: 'identity', attained: true },
      { id: 'create-first-spec', attained: hasSpec },
    ],
    preview: false,
    canPreview: false,
  };
}

let journeyFetch: () => Promise<JourneyStateResponse> = () => new Promise(() => {});
const fetchJourneyStateApi = vi.fn(() => journeyFetch());
const trackMock = vi.fn();
const trackAnonymousMock = vi.fn();

vi.mock('./api/journey', async () => {
  const real = await vi.importActual<typeof import('./api/journey')>('./api/journey');
  return { ...real, fetchJourneyStateApi: () => fetchJourneyStateApi() };
});
vi.mock('./hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track: trackMock, optedOut: false, setOptOut: vi.fn() }),
  useTrackRouteChange: () => {},
  trackAnonymous: (...args: unknown[]) => trackAnonymousMock(...args),
  isOptedOut: () => false,
  telemetryEnabled: () => true,
  routeTemplate: (p: string) => p,
}));
vi.mock('./components/AuthContext', async () => {
  const real = await vi.importActual<typeof import('./components/AuthContext')>(
    './components/AuthContext',
  );
  return {
    ...real,
    useAuth: () => ({
      session: mockSession,
      user: { name: 'Alice', email: 'alice@example.com', picture: '' },
      token: 'fake-token',
      isAuthenticated: true,
      authError: null,
      logout: vi.fn(),
      updateSession: vi.fn(),
      acceptSession: vi.fn(),
    }),
  };
});
vi.mock('./components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./components/ChatContext', () => ({
  ChatProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./components/OrgConsentDialog', () => ({ OrgConsentDialog: () => null }));
vi.mock('./pages/HomeCanvas', () => ({
  HomeCanvas: () => <div data-testid="home-canvas-page">home</div>,
}));
vi.mock('./pages/SpecList', () => ({
  SpecList: () => <div data-testid="specs-page">specs</div>,
}));

import { PostLoginRouter } from './App';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="probe" data-path={loc.pathname} />;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/*" element={<PostLoginRouter />} />
        <Route path="/alice/personal/specs" element={<LocationProbe />} />
        <Route path="/welcome" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

// PARKED with the Home Canvas: the per-memex Brain replaces the flat /home surface, so
// the spec-470 dec-9 "auto-land spec-less users on /home" behaviour (and its
// destination:'home' telemetry) is retired — everyone now falls through to their
// default Specs board. Un-skip this whole block when the Home Canvas is restored (also
// restore the confirmedSpecLess → /home branch + telemetry in App.tsx RootRedirect).
describe.skip('spec-470 t-3: RootRedirect auto-lands spec-less users on /home (dec-9)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
    resetCachedJourneyState(); // isolate the confirmedSpecLess cache read between tests
    fetchJourneyStateApi.mockClear();
    trackMock.mockClear();
    trackAnonymousMock.mockClear();
    journeyFetch = () => new Promise(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ac-13: a spec-less user (past the welcome gate) auto-lands on /home', async () => {
    tagAc(AC(13));
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/');
    expect(await screen.findByTestId('home-canvas-page')).toBeInTheDocument();
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
  });

  it('ac-13: a has-spec user still lands on their Specs board (spec-461 preserved)', async () => {
    tagAc(AC(13));
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await waitFor(() =>
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
        '/alice/personal/specs',
      ),
    );
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });

  it('ac-13: the home.landing_routed telemetry reports destination:home for a spec-less user', async () => {
    tagAc(AC(13));
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/');
    await waitFor(() => {
      const call =
        trackMock.mock.calls.find((c) => c[0] === 'home.landing_routed') ??
        trackAnonymousMock.mock.calls.find((c) => c[0] === 'home.landing_routed');
      expect(call, 'home.landing_routed should fire').toBeTruthy();
      expect(call?.[1]).toEqual({ destination: 'home', graduated: false });
    });
  });

  it('ac-14 / ac-10: with the home flag hidden, a spec-less user falls back to the Specs board', async () => {
    tagAc(AC(14));
    tagAc(AC(10));
    mockSession = makeSession({ hiddenFeatures: ['home'] });
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/');
    await waitFor(() =>
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
        '/alice/personal/specs',
      ),
    );
    // The /home route itself renders RootRedirect when hidden → also bounces to board.
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });

  // spec-470 ac-10 ("the welcome-video gate fires ahead of the /home landing") is
  // SUPERSEDED by spec-507: there is no gate to order any more. The assertion was
  // deleted rather than inverted — App.spec-507.test.tsx owns the no-gate claim.
});
