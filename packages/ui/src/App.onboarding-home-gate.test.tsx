import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { SessionPayload } from './api/client';

// Regression — the onboarding destination must respect the Home Canvas feature gate.
//
// THE BUG: spec-305 routes every `needsOnboarding` user to /home (the Home Canvas
// journey). But /home is gated per-env: when 'home' is in HIDDEN_FEATURES (e.g. prod,
// before the journey is ready) the /home route renders <RootRedirect/> instead of the
// journey. RootRedirect's FIRST check sends `needsOnboarding` users straight back to
// /home — so a brand-new signup is trapped in an infinite /home ⇄ RootRedirect loop and
// can never reach the app. Hiding the tab silently soft-locks every new prod signup.
//
// THE FIX: when 'home' is hidden, onboarding falls back to the still-present legacy
// /onboarding page (which stamps identity_confirmed_at and clears needsOnboarding just
// the same). When 'home' is visible, the journey at /home is used exactly as today.
//
// We mount the real PostLoginRouter so the gate + RootRedirect resolve through genuine
// react-router; the journey page, legacy page, and tenant chrome are stubbed to sentinels
// so the test isolates the routing decision, not the screens.

let mockSession: SessionPayload;
function makeSession(opts: { needsOnboarding: boolean; hiddenFeatures: string[] }): SessionPayload {
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
    needsOnboarding: opts.needsOnboarding,
    hiddenFeatures: opts.hiddenFeatures,
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
            non-onboarding target without dragging in TenantLayout/SpecList. */}
        <Route path="/alice/personal/specs" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('onboarding destination respects the Home Canvas feature gate', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('home VISIBLE: a needs-onboarding user lands on the Home Canvas journey', async () => {
    mockSession = makeSession({ needsOnboarding: true, hiddenFeatures: [] });
    renderAt('/');
    expect(await screen.findByTestId('home-canvas-page')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });

  it('home HIDDEN: a needs-onboarding user lands on the legacy /onboarding page (no /home loop)', async () => {
    mockSession = makeSession({ needsOnboarding: true, hiddenFeatures: ['home'] });
    renderAt('/');
    // Before the fix this renders nothing (the /home ⇄ RootRedirect loop); after the
    // fix the user lands on the working legacy onboarding page.
    expect(await screen.findByTestId('onboarding-page')).toBeInTheDocument();
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });

  it('home HIDDEN, already onboarded: a deliberate /home visit still bounces to the default tenant', async () => {
    mockSession = makeSession({ needsOnboarding: false, hiddenFeatures: ['home'] });
    renderAt('/home');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
        '/alice/personal/specs',
      );
    });
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });
});
