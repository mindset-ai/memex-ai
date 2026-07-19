import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SessionPayload } from './api/client';
import type { JourneyStateResponse } from './api/journey';
import { resetCachedJourneyState } from './journeys/journeyStateCache';

// spec-421 dec-5 / issue-1 — RootRedirect decides the first-load landing from a
// READ-ONLY onboarding-state check. spec-461 dec-1 RETIRED the auto-Home landing;
// spec-470 dec-9 then re-introduced it for the CONFIRMED spec-less cohort, so the
// current truth is:
//   - not-yet-graduated (confirmed spec-less), 'home' visible → /home (spec-470 dec-9)
//   - graduated, 'home' visible          → the default surface (Trails) via canonical /home
//   - 'home' hidden per-env              → default-tenant Specs (loop-avoidance, NO journey read)
// (Home is now reachable only by explicit nav; the welcome-video re-show gate for spec-less
// users survives — see App.spec-461.test.tsx.) The decision is made in the app router before
// drawing (the journey-state read resolves first), so there is no stale-state flash. We mount
// the real PostLoginRouter so the gate + RootRedirect resolve through genuine react-router; the
// journey page / tenant chrome are stubbed to sentinels so the test isolates the routing decision.

const ACS = 'mindset-prod/memex-building-itself/specs/spec-421/acs';

let mockSession: SessionPayload;
function makeSession(opts: { hiddenFeatures: string[]; emailVerified?: boolean }): SessionPayload {
  return {
    user: {
      id: 'u-1',
      email: 'alice@example.com',
      name: 'Alice',
      status: 'active',
      emailVerified: opts.emailVerified ?? true,
      videoWelcomedAt: new Date(), // spec-444: suppress welcome-video gate so tests isolate routing logic
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
    hiddenFeatures: opts.hiddenFeatures,
  };
}

function journeyState(graduated: boolean): JourneyStateResponse {
  // graduated ⇔ every derived step attained (the isJourneyGraduated seam).
  return {
    milestones: {
      identityConfirmed: true,
      mcpConnected: true,
      mcpToolCalled: false,
      hasSpec: graduated,
      hasResolvedDecision: false,
      hasAc: false,
      acVerified: false,
      planGrounded: false,
    },
    roleCoords: null,
    currentStepId: graduated ? 'done' : 'create-first-spec',
    steps: [
      { id: 'identity', attained: true },
      { id: 'create-first-spec', attained: graduated },
    ],
    preview: false,
    canPreview: false,
  };
}

// Controllable journey-state read + a spy so we can assert it is NOT called when 'home'
// is hidden (ac-17). Default: a never-resolving promise (the "still assessing" state).
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
  HomeCanvas: () => <div data-testid="home-canvas-page">home journey</div>,
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
        {/* Probe the default-landing tenant path so we can assert RootRedirect's
            graduated → default surface (Trails) without dragging in TenantLayout/SpecList. */}
        <Route path="/alice/personal/brain" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RootRedirect lands users by a read-only onboarding-state check (spec-421 dec-5)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
    sessionStorage.setItem('welcomeVideoDismissed', '1'); // spec-444: suppress gate so tests isolate routing
    resetCachedJourneyState(); // spec-470: isolate the confirmedSpecLess cache read between tests
    fetchJourneyStateApi.mockClear();
    trackMock.mockClear();
    trackAnonymousMock.mockClear();
    journeyFetch = () => new Promise(() => {}); // default: never resolves
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    sessionStorage.removeItem('welcomeVideoDismissed');
  });

  // The Home Canvas is PARKED — the per-memex Brain replaces the flat /home surface as
  // the default landing. The spec-470 dec-9 auto-Home landing for the CONFIRMED
  // spec-less cohort is therefore retired: a not-graduated user now also falls through
  // to the default surface (Trails) via /home (never stranded), same as the graduated cohort.
  // Restore the spec-470 ac-13 assertion (auto-lands on /home) when the Home Canvas
  // comes back.
  it('home VISIBLE + NOT graduated: now falls through to the default surface (Trails) via /home (Home Canvas parked)', async () => {
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/brain');
    });
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });

  it('home VISIBLE + graduated: goes straight to the default surface (Trails) via /home, not the parked Home Canvas', async () => {
    tagAc(`${ACS}/ac-14`);
    tagAc(`${ACS}/ac-16`);
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/brain');
    });
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });

  it('while the onboarding state is still being assessed, RootRedirect renders nothing (no stale-state flash)', async () => {
    tagAc(`${ACS}/ac-16`);
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => new Promise(() => {}); // never resolves — perpetual "assessing"
    renderAt('/');
    await Promise.resolve();
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
  });

  it('home HIDDEN: lands on the default surface (Trails) via /home WITHOUT reading journey-state (loop-avoidance)', async () => {
    tagAc(`${ACS}/ac-17`);
    mockSession = makeSession({ hiddenFeatures: ['home'] });
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/brain');
    });
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
    // No Home-vs-Specs choice to make when home is hidden → the journey-state read is skipped.
    expect(fetchJourneyStateApi).not.toHaveBeenCalled();
  });

  it('/login routes through the SAME RootRedirect decision: a returning graduated user lands on the default surface', async () => {
    tagAc(`${ACS}/ac-18`);
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/login');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/brain');
    });
  });

  it('fires the home.landing_routed engagement event with destination + graduated', async () => {
    tagAc(`${ACS}/ac-20`);
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    // The event fires via track() when a tenant resolves, else the trackAnonymous()
    // fallback — assert it landed through whichever path with the right props.
    await waitFor(() => {
      const viaTrack = trackMock.mock.calls.find((c) => c[0] === 'home.landing_routed');
      const viaAnon = trackAnonymousMock.mock.calls.find((c) => c[0] === 'home.landing_routed');
      const call = viaTrack ?? viaAnon;
      expect(call, 'home.landing_routed should fire via track or trackAnonymous').toBeTruthy();
      expect(call?.[1]).toEqual({ destination: 'specs', graduated: true });
    });
  });

  it('email-verification gate still fires before any landing redirect', async () => {
    tagAc(`${ACS}/ac-16`);
    mockSession = makeSession({ hiddenFeatures: [], emailVerified: false });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await Promise.resolve();
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
  });
});
