// spec-372 t-11 (dec-7) — the post-login landing: a plain sign-up / login lands the user on
// /home (the onboarding), NOT the Kanban/specs board, for first-time AND returning users alike
// (builds on spec-312 dec-1's universal /home landing). The explicit-returnTo deep link is
// honoured by AuthContext.acceptSession (code-reviewed; window.location based, not route-tree).
//   ac-25 (scope) — first-time → Home; returning → Home; off-home indicator (the dot, ac-28).
//   ac-26 (impl)  — a plain login lands on /home, not the board, regardless of onboarding state.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';
import type { SessionPayload } from './api/client';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

let mockSession: SessionPayload;
function makeSession(needsOnboarding: boolean): SessionPayload {
  return {
    user: { id: 'u-1', email: 'alice@example.com', name: 'Alice', status: 'active', emailVerified: true },
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
    needsOnboarding,
    hiddenFeatures: [],
  };
}

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
vi.mock('./pages/HomeCanvas', () => ({ HomeCanvas: () => <div data-testid="home-canvas-page">home</div> }));
vi.mock('./pages/SpecList', () => ({ SpecList: () => <div data-testid="specs-page">specs</div> }));
vi.mock('./pages/VerifyEmailGate', () => ({ VerifyEmailGate: () => <div data-testid="verify-email-gate">verify</div> }));
vi.mock('./pages/Onboarding', () => ({ Onboarding: () => <div data-testid="onboarding-page">legacy</div> }));

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

describe('spec-372 t-11: post-login landing is /home, never the board (dec-7)', () => {
  it('ac-25 / ac-26: a first-time (not-yet-onboarded) login lands on /home, not the specs board', async () => {
    tagAc(AC(25));
    tagAc(AC(26));
    mockSession = makeSession(true);
    renderAt('/');
    expect(await screen.findByTestId('home-canvas-page')).toBeInTheDocument();
    expect(screen.queryByTestId('specs-page')).not.toBeInTheDocument();
  });

  it('ac-26: a returning (already-onboarded) login also lands on /home, not the board', async () => {
    tagAc(AC(26));
    mockSession = makeSession(false);
    renderAt('/');
    expect(await screen.findByTestId('home-canvas-page')).toBeInTheDocument();
    expect(screen.queryByTestId('specs-page')).not.toBeInTheDocument();
  });

  it('ac-26: hitting /login post-auth bounces to /home (not caught as a tenant route)', async () => {
    tagAc(AC(26));
    mockSession = makeSession(false);
    renderAt('/login');
    expect(await screen.findByTestId('home-canvas-page')).toBeInTheDocument();
  });
});
