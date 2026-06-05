import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useParams } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';
import type { SessionPayload } from './api/client';

// spec-64 i-3 / ac-23 — Decision / Issue canonical deep-links must resolve to the
// Spec page, NOT fall through the catch-all to the user's default (personal) Memex.
//
// The ⌘K palette navigates a Decision hit to `…/specs/spec-N/decisions/dec-M` and
// an Issue hit to `…/specs/spec-N/issues/issue-N`. Before the fix the router had only
// `specs/:id`, so those deeper paths matched no nested route, hit
// `<Route path="*" element={<RootRedirect/>}>`, and bounced to /alice/personal/specs.
//
// We mount the real `PostLoginRouter` so the route resolution under test is the
// genuine react-router tree; the tenant chrome and the heavy DocDocument page are
// stubbed so the test isolates ROUTING. A sentinel page + a probe at the default
// landing tell us whether we landed on the Spec or got redirected.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-64/acs/ac-${n}`;

// `alice/personal` is the only membership, so computeDefaultLanding (kept real)
// resolves the catch-all redirect to /alice/personal/specs — the wrong landing
// this bug produced.
let mockSession: SessionPayload;
function makeSession(): SessionPayload {
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

// Tenant chrome → passthroughs so TenantLayout renders its <Outlet/> without the
// AppShell / chat / consent providers.
vi.mock('./components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./components/ChatContext', () => ({
  ChatProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./components/OrgConsentDialog', () => ({
  OrgConsentDialog: () => null,
}));
// DocumentShell wraps the routed DocDocument with the chat panel; passthrough it.
vi.mock('./components/DocumentShell', () => ({
  DocumentShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Sentinel for the Spec page. It echoes the route params so we can prove the
// decision/issue handle threaded through to the page (not just that we avoided
// the redirect).
vi.mock('./pages/DocDocument', () => ({
  DocDocument: () => {
    const params = useParams();
    return (
      <div
        data-testid="doc-document-page"
        data-id={params.id}
        data-dec={params.decId ?? ''}
        data-issue={params.issueId ?? ''}
      />
    );
  },
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

describe('spec-64 i-3: Decision/Issue deep-link routes (ac-23)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
    mockSession = makeSession();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a Decision deep-link renders the Spec page, not a redirect to the personal Memex', async () => {
    tagAc(AC(23));
    renderAt('/alice/personal/specs/spec-7/decisions/dec-2');

    const page = await screen.findByTestId('doc-document-page');
    expect(page.getAttribute('data-id')).toBe('spec-7');
    expect(page.getAttribute('data-dec')).toBe('dec-2');
    // The catch-all → RootRedirect → /alice/personal/specs must NOT have fired.
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
  });

  it('an Issue deep-link renders the Spec page, not a redirect to the personal Memex', async () => {
    tagAc(AC(23));
    renderAt('/alice/personal/specs/spec-7/issues/issue-1');

    const page = await screen.findByTestId('doc-document-page');
    expect(page.getAttribute('data-id')).toBe('spec-7');
    expect(page.getAttribute('data-issue')).toBe('issue-1');
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
  });
});
