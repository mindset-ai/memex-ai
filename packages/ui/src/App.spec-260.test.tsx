// spec-260 t-7 — the /qa-reports route gate (ac-18), mirroring the spec-146
// Option-B mechanism: the route is registered only when 'qa-reports' is absent
// from the session's hiddenFeatures; hidden → the path falls through to the
// catch-all RootRedirect. (The nav-link half of the gate is the same
// PRIMARY_NAV_LINKS `feature` filter Pulse/Insights use.)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';
import type { SessionPayload } from './api/client';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-260/acs/ac-${n}`;

let mockSession: SessionPayload;
function makeSession(hiddenFeatures: string[]): SessionPayload {
  return {
    user: {
      id: 'u-1',
      email: 'alice@example.com',
      name: 'Alice',
      status: 'active',
      emailVerified: true,
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
    hiddenFeatures,
  };
}

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
vi.mock('./components/OrgConsentDialog', () => ({
  OrgConsentDialog: () => null,
}));

// Sentinel for the gated page — the real QaReports fetches on mount, which is
// irrelevant to the route gate.
vi.mock('./pages/QaReports', () => ({
  QaReports: () => <div data-testid="qa-reports-page">qa reports</div>,
}));

// spec-461 dec-1: RootRedirect never auto-lands on /home — every authenticated user
// falls through to their default-tenant Specs board. This gate test only cares that a
// hidden feature route falls through to that universal landing; the journey read no
// longer changes the target (kept here as a realistic fixture).
vi.mock('./api/journey', async () => {
  const real = await vi.importActual<typeof import('./api/journey')>('./api/journey');
  return {
    ...real,
    fetchJourneyStateApi: () =>
      Promise.resolve({
        milestones: { identityConfirmed: true, mcpConnected: false, mcpToolCalled: false, hasSpec: false, hasResolvedDecision: false, hasAc: false, acVerified: false, planGrounded: false },
        roleCoords: null,
        currentStepId: 'create-spec',
        steps: [{ id: 'identity', attained: true }, { id: 'create-spec', attained: false }],
        preview: false,
        canPreview: false,
      }),
  };
});

import { PostLoginRouter } from './App';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="probe" data-path={loc.pathname} />;
}

// spec-461: RootRedirect sends every authenticated user to their default-tenant Specs
// board (never /home), so the catch-all fallthrough lands on /alice/personal/specs.
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/*" element={<PostLoginRouter />} />
        <Route path="/alice/personal/specs" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('spec-260 t-7: /qa-reports route gate (ac-18)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
    sessionStorage.setItem('welcomeVideoDismissed', '1'); // spec-444: suppress gate so tests isolate routing
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    sessionStorage.removeItem('welcomeVideoDismissed');
  });

  it("hidden → /qa-reports does not render the page and redirects to the universal landing", async () => {
    tagAc(AC(18));
    mockSession = makeSession(['qa-reports']);
    renderAt('/alice/personal/qa-reports');

    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/specs');
    });
    expect(screen.queryByTestId('qa-reports-page')).not.toBeInTheDocument();
  });

  it('not hidden → /qa-reports renders the QA Reports page', async () => {
    tagAc(AC(18));
    mockSession = makeSession([]);
    renderAt('/alice/personal/qa-reports');

    expect(await screen.findByTestId('qa-reports-page')).toBeInTheDocument();
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
  });
});
