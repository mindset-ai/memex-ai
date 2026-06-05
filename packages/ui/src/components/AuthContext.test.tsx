import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

// Mock Google OAuth — the real provider needs a valid client ID and network
vi.mock('@react-oauth/google', () => ({
  GoogleOAuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  GoogleLogin: () => <button data-testid="google-login">Mock Google Login</button>,
}));

import { AuthProvider, RequireAuth, useAuth, computeDefaultLanding } from './AuthContext';
import type { SessionPayload, MembershipSummary } from '../api/client';

function sessionFor(
  email: string,
  name = 'Test User',
  memberships: MembershipSummary[] = [],
): SessionPayload {
  return {
    user: {
      id: 'u-1',
      email,
      name,
      status: 'active',
      emailVerified: true,
    },
    memberships,
    currentMemexId: null,
    currentRole: null,
    needsOnboarding: false,
    hiddenFeatures: [],
  };
}

function personalMembership(slug: string, memexSlug = 'personal'): MembershipSummary {
  return {
    memexId: `mx-${slug}`,
    slug,
    memexSlug,
    name: 'Personal Memex',
    kind: 'personal',
    role: 'administrator',
  };
}

function orgMembership(slug: string, name: string, memexSlug = 'main'): MembershipSummary {
  return {
    memexId: `mx-${slug}-${memexSlug}`,
    slug,
    memexSlug,
    name,
    kind: 'team',
    role: 'member',
  };
}

describe('AuthContext', () => {
  let localStorageData: Record<string, string>;

  beforeEach(() => {
    localStorageData = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => localStorageData[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageData[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete localStorageData[key];
      }),
      clear: vi.fn(() => {
        localStorageData = {};
      }),
    });
    // Force prod-auth branch (GOOGLE_CLIENT_ID present) so tests aren't auto-bootstrapped
    // as the dev user.
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('restores session from localStorage when both token and session are present', () => {
    localStorageData['memex-auth-token'] = 'fake-jwt-token';
    localStorageData['memex-session'] = JSON.stringify(sessionFor('test@example.com'));

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.name).toBe('Test User');
    expect(result.current.user?.email).toBe('test@example.com');
    expect(result.current.session).not.toBeNull();
  });

  it('RequireAuth shows login screen when no token is stored', () => {
    render(
      <AuthProvider>
        <RequireAuth>
          <div data-testid="protected">Protected</div>
        </RequireAuth>
      </AuthProvider>,
    );

    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
    // LoginScreen renders the email + password fields.
    expect(screen.getByPlaceholderText('you@company.com')).toBeInTheDocument();
  });

  it('RequireAuth renders children once authenticated', () => {
    localStorageData['memex-auth-token'] = 'fake-jwt-token';
    localStorageData['memex-session'] = JSON.stringify(sessionFor('test@example.com'));

    render(
      <AuthProvider>
        <RequireAuth>
          <div data-testid="protected">Protected</div>
        </RequireAuth>
      </AuthProvider>,
    );

    expect(screen.getByTestId('protected')).toBeInTheDocument();
  });

  it('logout clears token and localStorage', () => {
    localStorageData['memex-auth-token'] = 'fake-jwt-token';
    localStorageData['memex-session'] = JSON.stringify(sessionFor('test@example.com'));

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isAuthenticated).toBe(true);

    // jsdom throws on window.location.href = '...' because it defaults to a read-only
    // location. Stub it so logout's full-page navigation doesn't blow up.
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, href: '' },
      writable: true,
    });

    act(() => {
      result.current.logout();
    });

    expect(localStorageData['memex-auth-token']).toBeUndefined();
    expect(localStorageData['memex-session']).toBeUndefined();
  });

  it('handles malformed session JSON gracefully', () => {
    localStorageData['memex-auth-token'] = 'fake-jwt-token';
    localStorageData['memex-session'] = '{not valid json';

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    // Should not throw — restore returns null and the auth provider treats us as logged out.
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isAuthenticated).toBe(false);
  });
});

describe('computeDefaultLanding (t-23)', () => {
  it('returns null when memberships is empty', () => {
    const s = sessionFor('a@b.com', 'A', []);
    expect(computeDefaultLanding(s)).toBeNull();
  });

  it('prefers the personal membership when one exists', () => {
    const s = sessionFor('a@b.com', 'A', [
      orgMembership('acme', 'Acme', 'main'),
      personalMembership('alice', 'personal'),
    ]);
    expect(computeDefaultLanding(s)).toBe('/alice/personal/specs');
  });

  it('falls back to the first membership when no personal exists', () => {
    const s = sessionFor('a@b.com', 'A', [orgMembership('acme', 'Acme', 'main')]);
    expect(computeDefaultLanding(s)).toBe('/acme/main/specs');
  });

  it('uses memexSlug "main" fallback when slug is missing on a team membership', () => {
    const m: MembershipSummary = {
      memexId: 'mx-1',
      slug: 'acme',
      // memexSlug intentionally undefined (back-compat cache from pre-t-18)
      memexSlug: undefined as unknown as string,
      name: 'Acme',
      kind: 'team',
      role: 'member',
    };
    const s = sessionFor('a@b.com', 'A', [m]);
    expect(computeDefaultLanding(s)).toBe('/acme/main/specs');
  });
});
