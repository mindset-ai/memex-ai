import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';
import type { SessionPayload } from './api/client';

// spec-146 t-4 — the `/scaffold` route gate (dec-1 / Option B):
//   ac-10: with hiddenFeatures ['scaffold'], /<ns>/<mx>/scaffold does NOT render
//          ScaffoldInspect and falls through to the catch-all RootRedirect, which
//          navigates to the default tenant (/specs).
//   ac-11: with hiddenFeatures [], /<ns>/<mx>/scaffold renders ScaffoldInspect.
//
// We mount the real `PostLoginRouter` (the route tree under test) so the gate is
// exercised through actual react-router resolution — when the <Route> is omitted
// the path must reach `<Route path="*" element={<RootRedirect/>}>`. The heavy
// tenant shell (AppShell / ChatProvider / OrgConsentDialog) and the data-fetching
// ScaffoldInspect page are stubbed so the test isolates routing, not chrome.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-146/acs/ac-${n}`;

// Mutable session fixture — each test sets `hiddenFeatures` before rendering.
// `alice/personal` is the personal membership, so computeDefaultLanding (kept
// real) resolves the default landing to /alice/personal/specs.
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

// useAuth is read by PostLoginRouter (route gate), TenantLayout (membership) and
// RootRedirect (default landing). Stub it with the mutable fixture; keep the real
// computeDefaultLanding so the redirect target is the genuine /specs path.
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

// Stub the tenant chrome to passthroughs so TenantLayout renders its <Outlet/>
// without dragging in AppShell (concurrently edited) or chat/consent providers.
vi.mock('./components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./components/ChatContext', () => ({
  ChatProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./components/OrgConsentDialog', () => ({
  OrgConsentDialog: () => null,
}));

// Sentinel for the gated page — the real ScaffoldInspect fetches on mount, which
// is irrelevant to the route gate. Presence/absence of this testid is the signal.
vi.mock('./pages/ScaffoldInspect', () => ({
  ScaffoldInspect: () => <div data-testid="scaffold-inspect-page">scaffold</div>,
}));

import { PostLoginRouter } from './App';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="probe" data-path={loc.pathname} />;
}

// Render the real route tree at `path`, plus a probe at the default landing so we
// can assert where the catch-all redirect lands.
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

describe('spec-146 t-4: /scaffold route gate', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ac-10: hidden → /scaffold does not render ScaffoldInspect and redirects to the default tenant', async () => {
    tagAc(AC(10));
    mockSession = makeSession(['scaffold']);
    renderAt('/alice/personal/scaffold');

    // The route was never registered, so the path falls through to the catch-all
    // RootRedirect → default landing (/alice/personal/specs).
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
        '/alice/personal/specs',
      );
    });
    expect(screen.queryByTestId('scaffold-inspect-page')).not.toBeInTheDocument();
  });

  it('ac-11: not hidden → /scaffold renders ScaffoldInspect', async () => {
    tagAc(AC(11));
    mockSession = makeSession([]);
    renderAt('/alice/personal/scaffold');

    expect(await screen.findByTestId('scaffold-inspect-page')).toBeInTheDocument();
    // No catch-all redirect happened.
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
  });
});
