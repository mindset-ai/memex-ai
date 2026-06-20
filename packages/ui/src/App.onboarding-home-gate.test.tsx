import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { SessionPayload } from './api/client';

// Regression — the universal /home landing must respect the Home Canvas feature gate.
//
// spec-312 dec-1/dec-3: RootRedirect now sends EVERY authenticated, email-verified user
// to /home (the universal landing) — needsOnboarding no longer routes. But /home is
// gated per-env: when 'home' is in HIDDEN_FEATURES (e.g. prod, before the journey is
// ready) the /home route renders <RootRedirect/>. If RootRedirect sent everyone to
// /home unconditionally, a hidden-home env would trap every signup in an infinite
// /home ⇄ RootRedirect loop. So RootRedirect's ONLY remaining branch is loop-avoidance:
// when 'home' is hidden it falls back to the default-tenant landing (computeDefaultLanding,
// the Specs board); when 'home' is visible everyone lands on the journey at /home.
//
// (The legacy standalone /onboarding fallback that spec-305 used is gone with the wall.)
//
// We mount the real PostLoginRouter so the gate + RootRedirect resolve through genuine
// react-router; the journey page and tenant chrome are stubbed to sentinels so the test
// isolates the routing decision, not the screens.

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

  it('home VISIBLE: an authenticated user lands on the Home Canvas (needsOnboarding is irrelevant now)', async () => {
    mockSession = makeSession({ needsOnboarding: true, hiddenFeatures: [] });
    renderAt('/');
    expect(await screen.findByTestId('home-canvas-page')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });

  it('home HIDDEN: lands on the default-tenant Specs board, never a /home loop', async () => {
    mockSession = makeSession({ needsOnboarding: true, hiddenFeatures: ['home'] });
    renderAt('/');
    // spec-312: with 'home' hidden RootRedirect falls back to the default tenant (no
    // loop), and there is no legacy /onboarding wall to land on anymore.
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
        '/alice/personal/specs',
      );
    });
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
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
