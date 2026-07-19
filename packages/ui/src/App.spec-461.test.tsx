// spec-461 t-1 (dec-1) — retire the automatic parked-Home-Canvas landing.
//
// SUPERSEDED PATH, PRESERVED INVARIANT: spec-461's guarantee was "RootRedirect must
// never strand an authenticated user on the parked /home onboarding tracker (the Home
// Canvas)". That invariant STILL holds — no test here ever renders home-canvas-page.
// What changed: the default-landing PATH is now the canonical tenant /home redirect
// (computeDefaultLanding → /alice/personal/home), a thin pass-through that forwards to
// the chosen default surface — today spec-498 Trails (/trails). So "never lands on
// /home" is reframed: RootRedirect routes THROUGH /home to Trails, and the old parked
// Home Canvas is never the destination. The build-prompt-hero auto-land (spec-470
// dec-9) was itself retired with the Home Canvas; every cohort now resolves to the
// default surface. The welcome-video re-show (spec-less + not-dismissed → /welcome)
// and the /onboarding name gate are unchanged.
//
//   ac-1 (scope) — no authenticated user is ever stranded on the parked Home Canvas;
//                  a has-spec user, and one whose journey read fails/loads, lands on
//                  the default surface (Trails) via the canonical /home redirect.
//   ac-2 (scope) — /home stays a reachable route — now the canonical redirect itself.
//   ac-3 (scope) — the welcome-video flow + /onboarding name gate are unchanged.
//   ac-4 (impl)  — RootRedirect's final target is computeDefaultLanding(session) for all;
//                  the old `landOnHome ? '/home'` (parked-Canvas) branch is gone.
//   ac-5 (impl)  — spec-less + dismissed lands on the default surface; the welcome
//                  re-show still fires for spec-less + not-dismissed.
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
        {/* Probe the final default-landing surface + /welcome so we can assert where
            RootRedirect sends the user without dragging in the real screens. The
            default landing is now the canonical /alice/personal/home, which forwards
            to the chosen surface (Trails/Brain); this exact probe out-ranks the `/*`
            splat, so it catches that final /trails hop. */}
        <Route path="/alice/personal/trails" element={<LocationProbe />} />
        <Route path="/welcome" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('spec-461 t-1: RootRedirect never strands the user on the parked Home Canvas (dec-1)', () => {
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

  // Every cohort now resolves to the default surface (Trails) via the canonical
  // /home redirect; the parked Home Canvas is never the destination — that is
  // spec-461's surviving guarantee (home-canvas-page must not render).
  it('ac-1 / ac-4: a has-spec user (dismissed) lands on the default surface (Trails), not the parked Home Canvas', async () => {
    tagAc(AC(1));
    tagAc(AC(4));
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/trails');
    });
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });

  it('ac-4: a has-spec user lands on the default surface (Trails)', async () => {
    tagAc(AC(4));
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/trails');
    });
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });

  // spec-470 dec-9 preserves this spec-461 safety: routing to /home requires a
  // CONFIRMED spec-less read (cached hasSpec=false). A FAILED read has no such cache,
  // so it still falls back to the default surface — a transient blip never drops a
  // possibly-engaged user onto the parked Home Canvas / build-prompt hero.
  it('ac-1 / ac-4: a FAILED journey read no longer strands the user on the parked Home Canvas — lands on the default surface', async () => {
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
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/trails');
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

  it('ac-5: a has-spec user (not-dismissed) is NOT sent to /welcome — lands on the default surface', async () => {
    tagAc(AC(5));
    sessionStorage.removeItem('welcomeVideoDismissed');
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/trails');
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

  // PARKED with the Home Canvas: /home no longer renders the tracker — it always
  // RootRedirects through the canonical landing to the default surface now (the
  // per-memex Brain/Trails replaces it). Restore the "renders HomeCanvas" assertion
  // when it comes back.
  it('/home redirects through the canonical landing to the default surface (Home Canvas parked)', async () => {
    mockSession = makeSession({ hiddenFeatures: [] }); // home visible
    journeyFetch = () => Promise.resolve(journeyState(true)); // has-spec → straight to the default surface
    renderAt('/home');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/trails');
    });
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
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
