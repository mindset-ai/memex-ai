import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SessionPayload } from './api/client';
import type { JourneyStateResponse } from './api/journey';

// spec-421 dec-5 / issue-1 — RootRedirect decides the first-load landing from a
// READ-ONLY onboarding-state check (supersedes spec-312 dec-1's universal /home):
//   - not-yet-graduated, 'home' visible  → /home (the onboarding journey)
//   - graduated, 'home' visible          → the default-tenant Specs board
//   - 'home' hidden per-env              → default-tenant Specs (loop-avoidance, NO journey read)
// The decision is made in the app router before drawing (the journey-state read resolves
// first), so there is no stale-state flash. We mount the real PostLoginRouter so the gate +
// RootRedirect resolve through genuine react-router; the journey page / tenant chrome are
// stubbed to sentinels so the test isolates the routing decision, not the screens.

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
            graduated → Specs target without dragging in TenantLayout/SpecList. */}
        <Route path="/alice/personal/specs" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RootRedirect lands users by a read-only onboarding-state check (spec-421 dec-5)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
    fetchJourneyStateApi.mockClear();
    trackMock.mockClear();
    trackAnonymousMock.mockClear();
    journeyFetch = () => new Promise(() => {}); // default: never resolves
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('home VISIBLE + NOT graduated: lands on the Home Canvas onboarding journey', async () => {
    tagAc(`${ACS}/ac-16`);
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/');
    expect(await screen.findByTestId('home-canvas-page')).toBeInTheDocument();
  });

  it('home VISIBLE + graduated: goes straight to the default-tenant Specs board, not Home', async () => {
    tagAc(`${ACS}/ac-14`);
    tagAc(`${ACS}/ac-16`);
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/specs');
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

  it('home HIDDEN: lands on the default-tenant Specs board WITHOUT reading journey-state (loop-avoidance)', async () => {
    tagAc(`${ACS}/ac-17`);
    mockSession = makeSession({ hiddenFeatures: ['home'] });
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/specs');
    });
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
    // No Home-vs-Specs choice to make when home is hidden → the journey-state read is skipped.
    expect(fetchJourneyStateApi).not.toHaveBeenCalled();
  });

  it('/login routes through the SAME RootRedirect decision: a returning graduated user lands on Specs', async () => {
    tagAc(`${ACS}/ac-18`);
    mockSession = makeSession({ hiddenFeatures: [] });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/login');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/specs');
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
