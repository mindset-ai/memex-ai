// spec-461 t-1 (dec-1) — retire the automatic Home landing.
//
// NARROWED BY spec-470 dec-9 (2026-07-08, approved by spec-461's owner): spec-461's
// "never auto-land on /home" now holds ONLY for the HAS-SPEC cohort. A CONFIRMED
// spec-less user (a successful journey read with hasSpec=false) now AUTO-LANDS on
// /home — the build-prompt hero — so they reach it (covered by App.spec-470.test.tsx).
// The failed/unknown-read fallback is NOT treated as confirmed spec-less, so it still
// lands on the Specs board (that safety is preserved — see the failed-read test below).
// The tests here assert spec-461's surviving guarantee: a HAS-SPEC user is never
// auto-landed on Home (they get their Specs board), the welcome re-show still fires,
// and /home stays reachable by explicit navigation.
//
// Original intent: RootRedirect must never navigate to /home on its own; every
// authenticated, verified, named user past the welcome gate lands on their
// default-tenant Specs board. The spec-444 welcome-video re-show (spec-less +
// not-dismissed → /welcome) is preserved, keyed on !hasSpec. Reverses spec-421 dec-5.
//
//   ac-1 (scope) — no authenticated user is ever auto-redirected to /home; a spec-less
//                  user, and one whose journey read fails/loads, lands on Specs.
//   ac-2 (scope) — Home remains reachable by explicit navigation (visiting /home).
//   ac-3 (scope) — the welcome-video flow + /onboarding name gate are unchanged.
//   ac-4 (impl)  — RootRedirect's final target is computeDefaultLanding(session) for all;
//                  the `landOnHome ? '/home'` branch is gone, so it never returns
//                  <Navigate to="/home">, incl. hasSpec=false or a failed read.
//   ac-5 (impl)  — spec-less + dismissed lands on Specs; the welcome re-show still fires
//                  for spec-less + not-dismissed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SessionPayload } from './api/client';
import type { JourneyStateResponse } from './api/journey';
import { resetCachedJourneyState } from './journeys/journeyStateCache';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-461/acs/ac-${n}`;

let mockSession: SessionPayload;
function makeSession(opts: {
  hiddenFeatures?: string[];
  emailVerified?: boolean;
  name?: string | null;
}): SessionPayload {
  return {
    user: {
      id: 'u-1',
      email: 'alice@example.com',
      name: opts.name === undefined ? 'Alice' : (opts.name as string),
      status: 'active',
      emailVerified: opts.emailVerified ?? true,
      videoWelcomedAt: new Date(), // spec-444: suppress the first-run welcome fast-path
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

// Controllable journey-state read (default: never-resolving = "still assessing").
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
vi.mock('./pages/Onboarding', () => ({
  Onboarding: () => <div data-testid="onboarding-page">legacy name page</div>,
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
        {/* Probe the default-landing tenant path + /welcome so we can assert where
            RootRedirect sends the user without dragging in the real screens. */}
        <Route path="/alice/personal/specs" element={<LocationProbe />} />
        <Route path="/welcome" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('spec-461 t-1: RootRedirect never auto-lands on /home (dec-1)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
    sessionStorage.setItem('welcomeVideoDismissed', '1'); // spec-444: suppress the re-show gate by default
    resetCachedJourneyState(); // isolate the spec-470 confirmedSpecLess cache read between tests
    fetchJourneyStateApi.mockClear();
    trackMock.mockClear();
    trackAnonymousMock.mockClear();
    journeyFetch = () => new Promise(() => {}); // default: never resolves
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    sessionStorage.removeItem('welcomeVideoDismissed');
  });

  // spec-470 dec-9: spec-less users now auto-land on /home (App.spec-470.test.tsx).
  // spec-461's surviving guarantee is for the HAS-SPEC cohort — they still land on
  // their Specs board, never on Home.
  it('ac-1 / ac-4: a has-spec user (dismissed) lands on the Specs board, NOT /home', async () => {
    tagAc(AC(1));
    tagAc(AC(4));
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/specs');
    });
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });

  it('ac-4: a has-spec user lands on the Specs board', async () => {
    tagAc(AC(4));
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/specs');
    });
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });

  // spec-470 dec-9 preserves this spec-461 safety: routing to /home requires a
  // CONFIRMED spec-less read (cached hasSpec=false). A FAILED read has no such cache,
  // so it still falls back to the Specs board — a transient blip never drops a
  // possibly-engaged user onto the build-prompt hero.
  it('ac-1 / ac-4: a FAILED journey read no longer strands the user on /home — lands on Specs', async () => {
    tagAc(AC(1));
    tagAc(AC(4));
    vi.useFakeTimers();
    try {
      mockSession = makeSession({ hiddenFeatures: [] });
      journeyFetch = () => Promise.reject(new Error('journey read blew up'));
      renderAt('/');
      // useShouldLandOnHome retries with backoff before falling back; drain the timers.
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/specs');
      expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ac-3 / ac-5: the spec-444 welcome re-show still fires (spec-less + not-dismissed → /welcome)', async () => {
    tagAc(AC(3));
    tagAc(AC(5));
    sessionStorage.removeItem('welcomeVideoDismissed'); // NOT dismissed this session
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/welcome');
    });
  });

  it('ac-5: a has-spec user (not-dismissed) is NOT sent to /welcome — lands on Specs', async () => {
    tagAc(AC(5));
    sessionStorage.removeItem('welcomeVideoDismissed');
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/specs');
    });
  });

  it('ac-1: the home.landing_routed telemetry reports destination:specs for a has-spec user', async () => {
    tagAc(AC(1));
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await waitFor(() => {
      const viaTrack = trackMock.mock.calls.find((c) => c[0] === 'home.landing_routed');
      const viaAnon = trackAnonymousMock.mock.calls.find((c) => c[0] === 'home.landing_routed');
      const call = viaTrack ?? viaAnon;
      expect(call, 'home.landing_routed should fire').toBeTruthy();
      // spec-470 dec-9: a has-spec user still lands on Specs → destination 'specs',
      // graduated true. (Spec-less → destination 'home', see App.spec-470.test.tsx.)
      expect(call?.[1]).toEqual({ destination: 'specs', graduated: true });
    });
  });

  it('ac-2 / ac-3: Home stays reachable by explicit navigation (visiting /home renders HomeCanvas)', async () => {
    tagAc(AC(2));
    tagAc(AC(3));
    mockSession = makeSession({ hiddenFeatures: [] }); // home visible
    renderAt('/home');
    expect(await screen.findByTestId('home-canvas-page')).toBeInTheDocument();
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
  });

  it('ac-3: the /onboarding name gate still fires before any landing (unnamed user)', async () => {
    tagAc(AC(3));
    mockSession = makeSession({ hiddenFeatures: [], name: null });
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/');
    expect(await screen.findByTestId('onboarding-page')).toBeInTheDocument();
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });
});
