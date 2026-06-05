import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';
import type { SessionPayload } from './api/client';

// spec-148 t-1 — hide the Pulse feature when 'pulse' is in hiddenFeatures,
// reusing spec-146's server-driven feature-hide mechanism (dec-1 / Option B):
//   ac-6: with hiddenFeatures ['pulse'], the Pulse nav link is ABSENT.
//   ac-7: with hiddenFeatures ['pulse'], /<ns>/<mx>/pulse does NOT render Pulse
//         and falls through to the catch-all RootRedirect → default tenant
//         (/specs).
//   ac-8: with hiddenFeatures [], the Pulse nav link is PRESENT and
//         /<ns>/<mx>/pulse renders Pulse (no regression).
//
// The nav half (ac-6 / ac-8-nav) mounts the real AppShell and asserts the
// `feature: 'pulse'` tag + hiddenFeatures filter drops/keeps the link. The route
// half (ac-7 / ac-8-route) mounts the real `PostLoginRouter` so the `&&` gate is
// exercised through actual react-router resolution — when the <Route> is omitted
// the path must reach `<Route path="*" element={<RootRedirect/>}>`. The heavy
// tenant shell + the data-fetching Pulse page are stubbed so the test isolates
// the feature gate, not chrome.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-148/acs/ac-${n}`;

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

// useAuth is read by PostLoginRouter (route gate), TenantLayout (membership),
// RootRedirect (default landing) and AppShell (nav). Stub it with the mutable
// fixture; keep the real computeDefaultLanding so the redirect target is the
// genuine /specs path.
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
// without dragging in ChatProvider / OrgConsentDialog. NOTE: the route tests
// rely on the real AppShell passthrough being cheap, so it is stubbed here too;
// the nav tests below import the real AppShell from a separate render path.
vi.mock('./components/ChatContext', () => ({
  ChatProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./components/OrgConsentDialog', () => ({
  OrgConsentDialog: () => null,
}));

// MemexSwitcher makes API calls when mounted — stub (the real AppShell renders it).
vi.mock('./components/MemexSwitcher', () => ({
  MemexSwitcher: () => <div data-testid="memex-switcher" />,
}));

// Sentinel for the gated page — the real Pulse fetches on mount, which is
// irrelevant to the route gate. Presence/absence of this testid is the signal.
vi.mock('./pages/Pulse', () => ({
  Pulse: () => <div data-testid="pulse-page">pulse</div>,
}));

import { PostLoginRouter } from './App';
import { AppShell } from './components/AppShell';
// The real AppShell calls useTheme(), which throws without a ThemeProvider — so
// both the route tree (AppShell mounts inside TenantLayout) and the nav surface
// are wrapped in a real ThemeProvider, matching AppShell.test.tsx.
import { ThemeProvider } from './components/ThemeContext';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="probe" data-path={loc.pathname} />;
}

// Render the real route tree at `path`, plus a probe at the default landing so we
// can assert where the catch-all redirect lands.
function renderAt(path: string) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/*" element={<PostLoginRouter />} />
          <Route path="/alice/personal/specs" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

// Render the real AppShell (the nav surface) at `initialEntries`.
function renderShell(initialEntries: string[]) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <AppShell>
          <div data-testid="page-content">page</div>
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('spec-148 t-1: Pulse feature-hide', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ac-6: hidden → the Pulse nav link is absent', () => {
    tagAc(AC(6));
    mockSession = makeSession(['pulse']);
    renderShell(['/specs']);

    const nav = screen.getByTestId('primary-nav');
    expect(within(nav).queryByRole('link', { name: 'Pulse' })).not.toBeInTheDocument();
    // A non-feature link is untouched by the filter.
    expect(within(nav).getByRole('link', { name: 'Specs' })).toBeInTheDocument();
  });

  it('ac-7: hidden → /pulse does not render Pulse and redirects to the default tenant', async () => {
    tagAc(AC(7));
    mockSession = makeSession(['pulse']);
    renderAt('/alice/personal/pulse');

    // The route was never registered, so the path falls through to the catch-all
    // RootRedirect → default landing (/alice/personal/specs).
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
        '/alice/personal/specs',
      );
    });
    expect(screen.queryByTestId('pulse-page')).not.toBeInTheDocument();
  });

  it('ac-8: not hidden → the Pulse nav link is present', () => {
    tagAc(AC(8));
    mockSession = makeSession([]);
    renderShell(['/specs']);

    const nav = screen.getByTestId('primary-nav');
    expect(within(nav).getByRole('link', { name: 'Pulse' })).toBeInTheDocument();
  });

  it('ac-8: not hidden → /pulse renders Pulse', async () => {
    tagAc(AC(8));
    mockSession = makeSession([]);
    renderAt('/alice/personal/pulse');

    expect(await screen.findByTestId('pulse-page')).toBeInTheDocument();
    // No catch-all redirect happened.
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
  });
});
