// spec-146 ac-9 — TAGGED test. Emits an AC event to PROD (mindset-prod
// namespace → https://memex.ai). DO NOT run locally; the human runs this.
//
// ac-9: "A client holding a cached session reflects an updated `hiddenFeatures`
// value after its next background session refresh (refreshSession / user-change
// SSE), with no sign-out/sign-in required."
//
// Shape: seed localStorage with a cached session whose hiddenFeatures is [] (so
// the feature is visible), mock fetchSessionApi to resolve a fresh session whose
// hiddenFeatures is ['scaffold'], let AuthProvider's mount-time background
// refresh fire (no logout/login), and assert useIsFeatureHidden('scaffold')
// flips false → true off the refreshed session.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { tagAc } from '@memex-ai-ac/vitest';

// Mock Google OAuth — the real provider needs a valid client ID and network.
vi.mock('@react-oauth/google', () => ({
  GoogleOAuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  GoogleLogin: () => <button data-testid="google-login">Mock Google Login</button>,
}));

// Override only fetchSessionApi; keep the rest of the client module intact.
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    fetchSessionApi: vi.fn(),
  };
});

import { AuthProvider } from '../components/AuthContext';
import { fetchSessionApi, type SessionPayload } from '../api/client';
import { useIsFeatureHidden } from './useIsFeatureHidden';

const AC_9 = 'mindset-prod/memex-building-itself/specs/spec-146/acs/ac-9';

function sessionWith(hiddenFeatures: string[]): SessionPayload {
  return {
    user: { id: 'u-1', email: 'a@b.com', name: 'A', status: 'active', emailVerified: true },
    memberships: [],
    currentMemexId: null,
    currentRole: null,
    needsOnboarding: false,
    hiddenFeatures,
  };
}

// Tiny probe component: surfaces the context's hidden verdict for `scaffold`.
function ScaffoldHiddenProbe() {
  const hidden = useIsFeatureHidden('scaffold');
  return <span data-testid="hidden">{hidden ? 'hidden' : 'visible'}</span>;
}

describe('useIsFeatureHidden — ac-9 background refresh', () => {
  beforeEach(() => {
    localStorage.clear();
    // Force the prod-auth branch so the provider doesn't dev-bootstrap a session.
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it('a cached session reflects an updated hiddenFeatures after background refresh, no re-login', async () => {
    tagAc(AC_9);

    // Cached session: scaffold visible. The token drives the mount-time refresh.
    localStorage.setItem('memex-auth-token', 'fake-jwt-token');
    localStorage.setItem('memex-session', JSON.stringify(sessionWith([])));

    // Next /api/auth/me (background refresh) now hides scaffold.
    vi.mocked(fetchSessionApi).mockResolvedValue(sessionWith(['scaffold']));

    render(
      <AuthProvider>
        <ScaffoldHiddenProbe />
      </AuthProvider>,
    );

    // First paint reflects the cached session: scaffold still visible.
    expect(screen.getByTestId('hidden').textContent).toBe('visible');

    // AuthProvider's mount-time refreshSession() replaced the session — no logout/login.
    await waitFor(() => {
      expect(screen.getByTestId('hidden').textContent).toBe('hidden');
    });
    expect(fetchSessionApi).toHaveBeenCalledWith('fake-jwt-token');
  });
});
