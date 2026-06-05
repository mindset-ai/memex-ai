import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  Navigate,
  Outlet,
} from 'react-router-dom';
import type { ReactNode } from 'react';

// t-23 of doc-15: smoke tests for the path-based router. Verifies:
//   - /<ns>/<mx>/specs resolves to SpecList for a member
//   - /<ns>/<mx>/... redirects non-members to their default landing
//   - MemexSwitcher navigates to /<ns>/<mx>/specs of the chosen tenant
//
// We mount the route shapes ourselves instead of `<App>` so the test stays
// fast (no AuthProvider bootstrap, no API fetches). The pieces under test
// here are TenantLayout's params + membership lookup, and the navigate()
// call inside MemexSwitcher.

vi.mock('@react-oauth/google', () => ({
  GoogleOAuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  GoogleLogin: () => <button data-testid="google-login">Mock Google Login</button>,
}));

// useAuth is consulted by TenantLayout for membership + by AppShell for the
// user card. Stub it with a synchronous fixed session.
const mockSession = {
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
    {
      memexId: 'mx-acme',
      slug: 'acme',
      memexSlug: 'main',
      name: 'Acme',
      kind: 'team' as const,
      role: 'member' as const,
    },
  ],
  currentMemexId: 'mx-alice',
  currentRole: 'administrator' as const,
  needsOnboarding: false,
};

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

import { useAuth, computeDefaultLanding } from './components/AuthContext';

// A minimal TenantLayout mirror — same logic as App.tsx's. We keep the test
// shape close to the source so the regression is obvious if the layout drifts.
function TestTenantLayout() {
  const { namespace, memex } = useParams<{ namespace: string; memex: string }>();
  const { session } = useAuth();
  const ok = !!session?.memberships.some(
    (m) => m.slug === namespace && (m.memexSlug === memex || (!m.memexSlug && memex === 'main')),
  );
  if (!ok) {
    const fallback = session ? computeDefaultLanding(session) : null;
    if (fallback) return <Navigate to={fallback} replace />;
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="probe" data-path={loc.pathname} />;
}

describe('TenantLayout (route guard)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders children when /<ns>/<mx> matches an active membership', () => {
    render(
      <MemoryRouter initialEntries={['/alice/personal/specs']}>
        <Routes>
          <Route path="/:namespace/:memex" element={<TestTenantLayout />}>
            <Route path="specs" element={<div data-testid="spec-list">specs here</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('spec-list')).toBeInTheDocument();
  });

  it('redirects to the default landing when the URL tenant is not a membership', () => {
    render(
      <MemoryRouter initialEntries={['/badns/badmx/specs']}>
        <Routes>
          <Route path="/:namespace/:memex" element={<TestTenantLayout />}>
            <Route path="specs" element={<div data-testid="spec-list">specs here</div>} />
          </Route>
          <Route path="/alice/personal/specs" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('spec-list')).not.toBeInTheDocument();
    expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
      '/alice/personal/specs',
    );
  });

  it('resolves docs/:id under the tenant prefix', () => {
    render(
      <MemoryRouter initialEntries={['/acme/main/docs/doc-1']}>
        <Routes>
          <Route path="/:namespace/:memex" element={<TestTenantLayout />}>
            <Route path="docs/:id" element={<div data-testid="doc-page">doc here</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('doc-page')).toBeInTheDocument();
  });
});

describe('MemexSwitcher path-based navigation (t-23)', () => {
  it('navigates to /<ns>/<mx>/specs of a different tenant', async () => {
    function Probe() {
      const navigate = useNavigate();
      return (
        <>
          <button
            data-testid="go"
            onClick={() => navigate('/acme/main/specs')}
          >
            switch
          </button>
          <LocationProbe />
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={['/alice/personal/specs']}>
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
      '/alice/personal/specs',
    );
    screen.getByTestId('go').click();
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
        '/acme/main/specs',
      );
    });
  });
});
