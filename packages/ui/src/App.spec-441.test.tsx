import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';
import type { SessionPayload } from './api/client';

// spec-441 — Restore /onboarding name-capture gate for email/password signups
//
// Tests the nameless-user guard in RootRedirect, FlatShell, and TenantLayout
// (dec-1). ac-9 (Onboarding named-user redirect, dec-2) is in Onboarding.spec-441.test.tsx.
//
//   ac-1  (scope) — nameless user redirected to /onboarding regardless of which route they load
//   ac-3  (scope) — named user (Google SSO) never sent to /onboarding
//   ac-4  (scope) — returning named user's landing unchanged
//   ac-5  (scope) — after name is set, / does not redirect back to /onboarding
//   ac-7  (impl)  — FlatShell redirects nameless user to /onboarding
//   ac-8  (impl)  — TenantLayout redirects nameless user to /onboarding
//   impl  —        fetchJourneyStateApi never called for a nameless user
//   impl  —        email gate takes priority over name gate

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-441/acs/ac-${n}`;

let mockSession: SessionPayload;

function makeSession(opts: {
  name?: string;
  emailVerified?: boolean;
}): SessionPayload {
  return {
    user: {
      id: 'u-1',
      email: 'alice@example.com',
      name: opts.name ?? 'Alice',
      status: 'active',
      emailVerified: opts.emailVerified ?? true,
      videoWelcomedAt: null,
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
    hiddenFeatures: [],
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
      user: mockSession?.user
        ? { name: mockSession.user.name, email: mockSession.user.email, picture: '' }
        : null,
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
  HomeCanvas: () => <div data-testid="home-canvas-page">home</div>,
}));
vi.mock('./pages/SpecList', () => ({
  SpecList: () => <div data-testid="specs-page">specs</div>,
}));
// The canonical default surface behind /home (spec-498 Trails) — stubbed so the
// default landing resolves to a light node, not the real pixi graph.
vi.mock('./pages/Brain', () => ({
  Brain: () => <div data-testid="brain-page">trails</div>,
}));
vi.mock('./pages/SettingsIntegrations', () => ({
  SettingsIntegrations: () => <div data-testid="integrations-page">integrations</div>,
}));
vi.mock('./pages/VerifyEmailGate', () => ({
  VerifyEmailGate: () => <div data-testid="verify-email-gate">verify your email</div>,
}));
vi.mock('./pages/Onboarding', () => ({
  Onboarding: () => <div data-testid="onboarding-page">onboarding</div>,
}));

const fetchJourneyStateSpy = vi.fn().mockResolvedValue({
  milestones: {
    identityConfirmed: false,
    mcpConnected: false,
    mcpToolCalled: false,
    hasSpec: true, /* spec-470 dec-9: a has-spec user lands deterministically on the Specs board; spec-less now auto-lands on /home */
    hasResolvedDecision: false,
    hasAc: false,
    acVerified: false,
    planGrounded: false,
  },
  roleCoords: null,
  currentStepId: 'create-spec',
  steps: [],
  preview: false,
  canPreview: false,
});

vi.mock('./api/journey', async () => {
  const real = await vi.importActual<typeof import('./api/journey')>('./api/journey');
  return { ...real, fetchJourneyStateApi: (...args: unknown[]) => fetchJourneyStateSpy(...args) };
});

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
  fetchJourneyStateSpy.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('spec-441: RootRedirect name gate', () => {
  it('ac-1: nameless user at / is redirected to /onboarding', async () => {
    tagAc(AC(1));
    mockSession = makeSession({ name: '' });
    renderAt('/');
    expect(await screen.findByTestId('onboarding-page')).toBeInTheDocument();
    expect(screen.queryByTestId('home-canvas-page')).not.toBeInTheDocument();
  });

  it('ac-1: nameless user — fetchJourneyStateApi is never called (needDecision skipped)', async () => {
    tagAc(AC(1));
    mockSession = makeSession({ name: '' });
    renderAt('/');
    await screen.findByTestId('onboarding-page');
    expect(fetchJourneyStateSpy).not.toHaveBeenCalled();
  });

  // A named user lands on the canonical /home → the default surface (Trails/Brain),
  // not /onboarding. These name-gate ACs only assert the user is NOT bounced to
  // /onboarding; the landing sentinel is the default surface (brain-page).
  it('ac-3: named user (e.g. Google SSO) at / is NOT redirected to /onboarding', async () => {
    tagAc(AC(3));
    mockSession = makeSession({ name: 'Alice' });
    renderAt('/');
    expect(await screen.findByTestId('brain-page')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });

  it('ac-4: returning named user landing (/ → the default surface) is unchanged by the name gate', async () => {
    tagAc(AC(4));
    mockSession = makeSession({ name: 'Alice' });
    renderAt('/');
    expect(await screen.findByTestId('brain-page')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });

  it('ac-5: named session at / does not redirect to /onboarding ("not asked again")', async () => {
    tagAc(AC(5));
    mockSession = makeSession({ name: 'Alice' });
    renderAt('/');
    expect(await screen.findByTestId('brain-page')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });

  it('email gate fires before name gate — unverified nameless user sees VerifyEmailGate', async () => {
    mockSession = makeSession({ name: '', emailVerified: false });
    renderAt('/');
    expect(await screen.findByTestId('verify-email-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });

  it('email gate fires before name gate — unverified named user sees VerifyEmailGate', async () => {
    mockSession = makeSession({ name: 'Alice', emailVerified: false });
    renderAt('/');
    expect(await screen.findByTestId('verify-email-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });
});

describe('spec-441: FlatShell name gate (dec-1 / ac-7)', () => {
  it('ac-7: nameless user deep-linking to /settings/integrations is redirected to /onboarding', async () => {
    tagAc(AC(7));
    mockSession = makeSession({ name: '' });
    renderAt('/settings/integrations');
    expect(await screen.findByTestId('onboarding-page')).toBeInTheDocument();
    expect(screen.queryByTestId('integrations-page')).not.toBeInTheDocument();
  });

  it('ac-7: named user deep-linking to a FlatShell route is NOT redirected to /onboarding', async () => {
    tagAc(AC(7));
    mockSession = makeSession({ name: 'Alice' });
    renderAt('/settings/integrations');
    expect(await screen.findByTestId('integrations-page')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });
});

describe('spec-441: TenantLayout name gate (dec-1 / ac-8)', () => {
  it('ac-8: nameless user deep-linking to a tenant route is redirected to /onboarding', async () => {
    tagAc(AC(8));
    mockSession = makeSession({ name: '' });
    renderAt('/alice/personal/specs');
    expect(await screen.findByTestId('onboarding-page')).toBeInTheDocument();
    expect(screen.queryByTestId('specs-page')).not.toBeInTheDocument();
  });

  it('ac-8: named user deep-linking to a tenant route is NOT redirected to /onboarding', async () => {
    tagAc(AC(8));
    mockSession = makeSession({ name: 'Alice' });
    renderAt('/alice/personal/specs');
    expect(await screen.findByTestId('specs-page')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument();
  });
});
