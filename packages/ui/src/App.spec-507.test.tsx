import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SessionPayload } from './api/client';
import type { JourneyStateResponse } from './api/journey';
import { resetCachedJourneyState, setCachedJourneyState } from './journeys/journeyStateCache';

// spec-507 — the spec-444 welcome-video gate is retired. Four independent redirect
// checks used to send users to /welcome (TenantLayout, the RootRedirect fast path,
// the RootRedirect ac-17 re-show, and FlatShell); a user with videoWelcomedAt=null
// hit one of them on every entry path, every session, until they created a spec.
// These tests pin the ABSENCE of that routing — the failure they exist to catch is
// someone reinstating a gate, most plausibly the quiet FlatShell one.
const AC_GATES_GONE = 'mindset-prod/memex-building-itself/specs/spec-507/acs/ac-7';
const AC_NO_REDIRECT = 'mindset-prod/memex-building-itself/specs/spec-507/acs/ac-8';
const AC_VALUE_FIRST = 'mindset-prod/memex-building-itself/specs/spec-507/acs/ac-16';

const FEATURED = {
  memexId: 'mx-bi',
  slug: 'mindset-prod',
  memexSlug: 'memex-building-itself',
  name: 'memex-building-itself',
  kind: 'team' as const,
  role: 'member' as const,
  source: 'featured' as const,
};

let mockSession: SessionPayload;

/** A brand-new user: no name-capture pending, but never shown the video. */
function makeSession(): SessionPayload {
  return {
    user: {
      id: 'u-1',
      email: 'alice@example.com',
      name: 'Alice',
      status: 'active',
      emailVerified: true,
      // The gate's trigger condition. Pre-spec-507 every test in this repo had to
      // set this to a Date (or stub sessionStorage) just to get past the wall.
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
      FEATURED,
    ],
    currentMemexId: 'mx-alice',
    currentRole: 'administrator' as const,
    needsOnboarding: false,
    hiddenFeatures: [],
  } as unknown as SessionPayload;
}

function journeyState(hasSpec: boolean): JourneyStateResponse {
  return {
    milestones: {
      identityConfirmed: true,
      mcpConnected: false,
      mcpToolCalled: false,
      hasSpec,
      hasResolvedDecision: false,
      hasAc: false,
      acVerified: false,
      planGrounded: false,
    },
    roleCoords: null,
    currentStepId: hasSpec ? 'done' : 'create-first-spec',
    steps: [],
    preview: false,
    canPreview: false,
  };
}

let journeyFetch: () => Promise<JourneyStateResponse> = () => new Promise(() => {});
const fetchJourneyStateApi = vi.fn(() => journeyFetch());

vi.mock('./api/journey', async () => {
  const real = await vi.importActual<typeof import('./api/journey')>('./api/journey');
  return { ...real, fetchJourneyStateApi: () => fetchJourneyStateApi() };
});
vi.mock('./hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track: vi.fn(), optedOut: false, setOptOut: vi.fn() }),
  useTrackRouteChange: () => {},
  trackAnonymous: () => {},
  isOptedOut: () => false,
  telemetryEnabled: () => true,
  routeTemplate: (p: string) => p,
}));
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
vi.mock('./components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./components/ChatContext', () => ({
  ChatProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./components/OrgConsentDialog', () => ({ OrgConsentDialog: () => null }));
// The Integrations page is the cheapest real FlatShell route to probe; stub the page
// itself so the test isolates the shell's routing decision, not the page's fetches.
vi.mock('./pages/SettingsIntegrations', () => ({
  SettingsIntegrations: () => <div data-testid="integrations-page" />,
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
        <Route path="/mindset-prod/memex-building-itself/home" element={<LocationProbe />} />
        <Route path="/alice/personal/trails" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('spec-507: no code path routes a user to the welcome video', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
    resetCachedJourneyState();
    fetchJourneyStateApi.mockClear();
    journeyFetch = () => new Promise(() => {});
    mockSession = makeSession();
    // Deliberately NOT set: sessionStorage 'welcomeVideoDismissed'. Every one of
    // these assertions is made by a user the old gate would have intercepted.
    sessionStorage.removeItem('welcomeVideoDismissed');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetCachedJourneyState();
  });

  it('a spec-less new signup lands on the featured demo Memex, not /welcome', async () => {
    tagAc(AC_NO_REDIRECT);
    tagAc(AC_VALUE_FIRST);
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
        '/mindset-prod/memex-building-itself/home',
      );
    });
  });

  it('a returning spec-less user is not re-walled (the ac-17 re-show is gone)', async () => {
    tagAc(AC_NO_REDIRECT);
    // Second session: video never dismissed, still no spec — the exact state that
    // used to force the video again on every single login.
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/');
    await waitFor(() => {
      expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
        '/mindset-prod/memex-building-itself/home',
      );
    });
    expect(screen.getByTestId('probe').getAttribute('data-path')).not.toContain('/welcome');
  });

  it('a flat-route deep link renders that route (the quiet FlatShell gate is gone)', async () => {
    tagAc(AC_NO_REDIRECT);
    // The FlatShell gate keyed off the cached journey state, so seed it spec-less —
    // the condition under which it used to fire.
    setCachedJourneyState(journeyState(false));
    journeyFetch = () => Promise.resolve(journeyState(false));
    renderAt('/settings/integrations');
    await waitFor(() => {
      expect(screen.getByTestId('integrations-page')).toBeTruthy();
    });
  });
});

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(SRC_DIR, 'App.tsx'), 'utf8');

describe('spec-507 ac-7: the four gate sites are gone from the router source', () => {
  it('nothing navigates to /welcome', () => {
    tagAc(AC_GATES_GONE);
    expect(appSource).not.toMatch(/Navigate\s+to="\/welcome"/);
  });

  it('no gate predicate survives (videoWelcomedAt / welcomeVideoDismissed reads)', () => {
    tagAc(AC_GATES_GONE);
    expect(appSource).not.toContain('videoWelcomedAt');
    expect(appSource).not.toContain('welcomeVideoDismissed');
  });

  it('the /welcome route itself is still registered — the page survives as opt-in', () => {
    tagAc(AC_GATES_GONE);
    expect(appSource).toMatch(/path="\/welcome"[\s\S]*?WelcomePage/);
  });
});

// spec-507 ac-10 / std-34 (the honest-CTA rule): the account menu is now the ONLY
// in-app way to reach the video, so the entry and the router must agree. A menu item
// pointing at an unregistered path would 404 into the catch-all and bounce silently —
// which is exactly the kind of quiet breakage that survives code review.
const appShellSource = readFileSync(join(SRC_DIR, 'components', 'AppShell.tsx'), 'utf8');

describe('spec-507 ac-10: the "Watch intro video" entry still resolves', () => {
  it('links to a path the router actually registers', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-507/acs/ac-10');
    const menuTarget = appShellSource.match(/to="(\/welcome[^"]*)"/)?.[1];
    expect(menuTarget, 'the account-menu entry must still exist').toBeDefined();
    // Strip any query string before comparing against the registered route path.
    const path = menuTarget!.split('?')[0];
    expect(appSource).toContain(`path="${path}"`);
  });

  it('promises a video the page can still show', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-507/acs/ac-10');
    expect(appShellSource).toContain('Watch intro video');
    const welcomePageSource = readFileSync(join(SRC_DIR, 'pages', 'WelcomePage.tsx'), 'utf8');
    expect(welcomePageSource).toContain('welcome-video-player');
  });
});
