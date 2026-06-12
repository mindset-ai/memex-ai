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
      </Routes>
    </MemoryRouter>,
  );
}

describe('spec-260 t-7: /qa-reports route gate (ac-18)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hidden → /qa-reports does not render the page and redirects to the default tenant", async () => {
    tagAc(AC(18));
    mockSession = makeSession(['qa-reports']);
    renderAt('/alice/personal/qa-reports');

    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
        '/alice/personal/specs',
      );
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
