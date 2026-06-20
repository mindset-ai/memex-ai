import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';
import type { SessionPayload } from './api/client';

// spec-312 t-1 — the universal /home landing and the removal of the needsOnboarding
// wall (dec-1, dec-3). We mount the real `PostLoginRouter` so RootRedirect, the
// tenant-route gate and FlatShell all resolve through genuine react-router. The heavy
// chrome and data-fetching pages are stubbed to sentinels so the test isolates the
// routing decision, not the screens.
//
//   ac-1  (scope) — / routes an authenticated, email-verified user to /home regardless
//                   of onboarding/identity state.
//   ac-3  (scope) — an incomplete-onboarding user is never force-redirected back to
//                   onboarding when navigating to Specs or elsewhere.
//   ac-6  (scope) — an unverified user is still blocked by the email gate.
//   ac-7  (impl)  — RootRedirect, needsOnboarding=true → /home.
//   ac-8  (impl)  — RootRedirect, needsOnboarding=false → /home.
//   ac-9  (impl)  — a needsOnboarding user reaches a tenant route (gate at 172 gone).
//   ac-10 (impl)  — a needsOnboarding user reaches a FlatShell flat route (bounce gone).
//   ac-14 (impl)  — needsOnboarding does not change routing (true and false land same).
//   ac-15 (impl)  — the email gate fires before any landing redirect.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-312/acs/ac-${n}`;

let mockSession: SessionPayload;
function makeSession(opts: {
  needsOnboarding: boolean;
  emailVerified?: boolean;
  hiddenFeatures?: string[];
}): SessionPayload {
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
    needsOnboarding: opts.needsOnboarding,
    hiddenFeatures: opts.hiddenFeatures ?? [],
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

// Tenant chrome → passthroughs so TenantLayout/FlatShell render their content
// without the AppShell + chat/consent providers.
vi.mock('./components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./components/ChatContext', () => ({
  ChatProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./components/OrgConsentDialog', () => ({ OrgConsentDialog: () => null }));

// Sentinels for the landing surfaces — presence/absence of the testid is the signal.
vi.mock('./pages/HomeCanvas', () => ({
  HomeCanvas: () => <div data-testid="home-canvas-page">home</div>,
}));
vi.mock('./pages/SpecList', () => ({
  SpecList: () => <div data-testid="specs-page">specs</div>,
}));
vi.mock('./pages/SettingsIntegrations', () => ({
  SettingsIntegrations: () => <div data-testid="integrations-page">integrations</div>,
}));
vi.mock('./pages/VerifyEmailGate', () => ({
  VerifyEmailGate: () => <div data-testid="verify-email-gate">verify your email</div>,
}));
vi.mock('./pages/Onboarding', () => ({
  Onboarding: () => <div data-testid="onboarding-page">legacy onboarding</div>,
}));

import { PostLoginRouter } from './App';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/*" element={<PostLoginRouter />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('spec-312 t-1: universal /home landing (dec-1)', () => {
  it('ac-1 / ac-8: an email-verified, already-onboarded user visiting / lands on /home', async () => {
    tagAc(AC(1));
    tagAc(AC(8));
    mockSession = makeSession({ needsOnboarding: false });
    renderAt('/');
    expect(await screen.findByTestId('home-canvas-page')).toBeInTheDocument();
    expect(screen.queryByTestId('specs-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });

  it('ac-1 / ac-7: an email-verified, NOT-yet-onboarded user visiting / lands on /home', async () => {
    tagAc(AC(1));
    tagAc(AC(7));
    mockSession = makeSession({ needsOnboarding: true });
    renderAt('/');
    expect(await screen.findByTestId('home-canvas-page')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });

  it('ac-14: needsOnboarding does not change where / lands (true and false both → /home)', async () => {
    tagAc(AC(14));
    for (const needsOnboarding of [true, false]) {
      mockSession = makeSession({ needsOnboarding });
      const { unmount } = renderAt('/');
      expect(await screen.findByTestId('home-canvas-page')).toBeInTheDocument();
      unmount();
    }
  });
});

describe('spec-312 t-1: the needsOnboarding wall is gone (dec-1 / dec-3)', () => {
  it('ac-3 / ac-9: a NOT-yet-onboarded user reaches a tenant route, not bounced to onboarding/home', async () => {
    tagAc(AC(3));
    tagAc(AC(9));
    mockSession = makeSession({ needsOnboarding: true });
    renderAt('/alice/personal/specs');
    expect(await screen.findByTestId('specs-page')).toBeInTheDocument();
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });

  it('ac-10: a NOT-yet-onboarded user reaches a FlatShell flat route, not bounced', async () => {
    tagAc(AC(10));
    mockSession = makeSession({ needsOnboarding: true });
    renderAt('/settings/integrations');
    expect(await screen.findByTestId('integrations-page')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });
});

describe('spec-312 t-1: the email-verification gate is unchanged (dec-3)', () => {
  it('ac-6 / ac-15: an unverified user visiting / hits the email gate before any landing', async () => {
    tagAc(AC(6));
    tagAc(AC(15));
    mockSession = makeSession({ needsOnboarding: false, emailVerified: false });
    renderAt('/');
    expect(await screen.findByTestId('verify-email-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });

  it('ac-15: an unverified user on a FlatShell route hits the email gate', async () => {
    tagAc(AC(15));
    mockSession = makeSession({ needsOnboarding: false, emailVerified: false });
    renderAt('/settings/integrations');
    expect(await screen.findByTestId('verify-email-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('integrations-page')).not.toBeInTheDocument();
  });
});
