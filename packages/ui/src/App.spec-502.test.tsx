import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SessionPayload } from './api/client';
import type { JourneyStateResponse } from './api/journey';
import { resetCachedJourneyState } from './journeys/journeyStateCache';

// spec-502 ac-1: value-first onboarding. A spec-less new signup lands on the
// featured demo Memex (building-itself) FIRST — where the Explore companion invites
// them to create their own — instead of their own empty board. Gated on the
// onboarding-wizard kill-switch, and only when the server has surfaced a featured
// demo membership (spec-500) and the user hasn't authored a spec yet.
const AC_SEE_IT = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-1';

const FEATURED = {
  memexId: 'mx-bi',
  slug: 'mindset-prod',
  memexSlug: 'memex-building-itself',
  name: 'memex-building-itself',
  kind: 'team' as const,
  role: 'member' as const,
  source: 'featured' as const,
};

let mockSession: SessionPayload;
function makeSession(opts: { hiddenFeatures: string[]; withFeatured: boolean }): SessionPayload {
  return {
    user: {
      id: 'u-1',
      email: 'alice@example.com',
      name: 'Alice',
      status: 'active',
      emailVerified: true,
      videoWelcomedAt: new Date(),
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
      ...(opts.withFeatured ? [FEATURED] : []),
    ],
    currentMemexId: 'mx-alice',
    currentRole: 'administrator' as const,
    needsOnboarding: false,
    hiddenFeatures: opts.hiddenFeatures,
  } as unknown as SessionPayload;
}

function journeyState(hasSpec: boolean): JourneyStateResponse {
  return {
    milestones: {
      identityConfirmed: true,
      mcpConnected: false,
      mcpToolCalled: false,
      hasSpec,
      hasResolvedDecision: false,
      hasAc: false,
      acVerified: false,
      planGrounded: false,
    },
    roleCoords: null,
    currentStepId: hasSpec ? 'done' : 'create-first-spec',
    steps: [],
    preview: false,
    canPreview: false,
  };
}

let journeyFetch: () => Promise<JourneyStateResponse> = () => new Promise(() => {});
const fetchJourneyStateApi = vi.fn(() => journeyFetch());

vi.mock('./api/journey', async () => {
  const real = await vi.importActual<typeof import('./api/journey')>('./api/journey');
  return { ...real, fetchJourneyStateApi: () => fetchJourneyStateApi() };
});
vi.mock('./hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track: vi.fn(), optedOut: false, setOptOut: vi.fn() }),
  useTrackRouteChange: () => {},
  trackAnonymous: () => {},
  isOptedOut: () => false,
  telemetryEnabled: () => true,
  routeTemplate: (p: string) => p,
}));
vi.mock('./components/AuthContext', async () => {
  const real = await vi.importActual<typeof import('./components/AuthContext')>('./components/AuthContext');
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
vi.mock('./components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./components/ChatContext', () => ({ ChatProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./components/OrgConsentDialog', () => ({ OrgConsentDialog: () => null }));

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
        <Route path="/mindset-prod/memex-building-itself/home" element={<LocationProbe />} />
        <Route path="/alice/personal/trails" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('spec-502 ac-1: value-first landing on the featured demo Memex', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
    sessionStorage.setItem('welcomeVideoDismissed', '1');
    resetCachedJourneyState();
    fetchJourneyStateApi.mockClear();
    journeyFetch = () => new Promise(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    sessionStorage.removeItem('welcomeVideoDismissed');
  });

  it('a spec-less new signup lands on building-itself first', async () => {
    tagAc(AC_SEE_IT);
    mockSession = makeSession({ hiddenFeatures: [], withFeatured: true });
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
        '/mindset-prod/memex-building-itself/home',
      );
    });
  });

  it('a user who already has a spec is NOT rerouted (lands on their own board)', async () => {
    tagAc(AC_SEE_IT);
    mockSession = makeSession({ hiddenFeatures: [], withFeatured: true });
    journeyFetch = () => Promise.resolve(journeyState(true));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/trails');
    });
  });

  it('the kill-switch flag disables the reroute (falls back to the prior landing)', async () => {
    tagAc(AC_SEE_IT);
    mockSession = makeSession({ hiddenFeatures: ['onboarding-wizard'], withFeatured: true });
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/trails');
    });
  });
});
