import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import {
  ssoLoginApi,
  signupApi,
  loginApi,
  magicLinkRequestApi,
  passwordResetRequestApi,
  fetchSessionApi,
  AuthApiError,
  type SessionPayload,
} from '../api/client';
import { LoginScreen } from './LoginScreen';
import { buildBareDomainUrl } from '../utils/tenantUrl';
import { useUserChangeStreamWithToken } from '../hooks/useUserChangeStream';

// t-23 of doc-15: the React UI router is path-based now, so every tenant
// shares one origin (localStorage works across all of them). The legacy
// cross-origin auth handoff (URL fragment `memex-auth=…`) and the
// `?returnTo=` SSO bounce have been retired — they only existed to bridge
// different subdomain origins under the host-based router.

// Restrict `?returnTo=` to the memex.ai host family so an external link can't bounce a
// just-authenticated user off to a third-party site. Kept as a safety net for any legacy
// links that still arrive carrying `?returnTo=` after the path-based rollout — when the
// host check passes we navigate same-origin via window.location.href to the path part.
function isSafeReturnUrl(url: string): boolean {
  try {
    const u = new URL(url, window.location.origin);
    const host = u.hostname.toLowerCase();
    return (
      host === 'memex.ai' ||
      host.endsWith('.memex.ai') ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === window.location.hostname
    );
  } catch {
    return false;
  }
}

// Sentinel that survives one reload in dev mode to suppress the automatic session
// bootstrap after a user explicitly clicks "Sign out".
const DEV_LOGOUT_KEY = 'memex-dev-logout';
function consumeDevLogoutSentinel(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  const v = sessionStorage.getItem(DEV_LOGOUT_KEY);
  if (v) sessionStorage.removeItem(DEV_LOGOUT_KEY);
  return v === '1';
}

interface User {
  /** User id — needed to gate "delete your own comment" (spec-100). */
  id: string;
  name: string;
  email: string;
  picture: string;
}

export interface AuthState {
  token: string | null;
  user: User | null;
  session: SessionPayload | null;
  isAuthenticated: boolean;
  authError: string | null;
  logout: () => void;
  updateSession: (session: SessionPayload) => void;
  /** After signup/login/SSO/magic-link: store token + session, update derived user. */
  acceptSession: (session: SessionPayload) => void;
  /**
   * Re-fetch /api/auth/me and replace the cached session. Use after a mutation
   * that changes the caller's memberships/namespaces (e.g. creating a Memex)
   * when you need the updated session BEFORE proceeding — the user-change SSE
   * also triggers this, but the SSE round-trip can lose a race against a
   * user click that depends on the new membership.
   */
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

// Read at call-time (not module-load) so tests using vi.stubEnv after import
// still control the dev-bypass branch. Vite replaces import.meta.env.VITE_*
// at build time, so production behaviour is identical to a module-level const.
function getGoogleClientId(): string | undefined {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID;
}

function userFromSession(session: SessionPayload): User {
  return {
    id: session.user.id,
    name: session.user.name ?? '',
    email: session.user.email,
    picture: '',
  };
}

// Pick the path the user should land on after authenticating. Prefers the
// personal membership (every user has exactly one); falls back to the first
// available membership. Returns null when the session carries no memberships
// at all — caller decides what to do in that case (today: stay on /).
export function computeDefaultLanding(session: SessionPayload): string | null {
  const memberships = session.memberships;
  if (!memberships || memberships.length === 0) return null;
  const personal = memberships.find((m) => m.kind === 'personal') ?? memberships[0];
  // The wire schema names `slug` = namespace slug; `memexSlug` was added in t-18.
  // Fall back to "main" for back-compat with sessions cached before t-18 (no test
  // expectations on the fallback shape — it's the documented server default).
  const ns = personal.slug;
  const mx = personal.memexSlug ?? (personal.kind === 'personal' ? 'personal' : 'main');
  return `/${ns}/${mx}/specs`;
}

function restoreFromStorage(): { token: string; session: SessionPayload | null } | null {
  try {
    const token = localStorage.getItem('memex-auth-token');
    if (!token) return null;
    const sessionRaw = localStorage.getItem('memex-session');
    const session = sessionRaw ? (JSON.parse(sessionRaw) as SessionPayload) : null;
    return { token, session };
  } catch {
    localStorage.removeItem('memex-auth-token');
    localStorage.removeItem('memex-session');
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [restored] = useState(() => restoreFromStorage());
  const [token, setToken] = useState<string | null>(restored?.token ?? null);
  const [session, setSession] = useState<SessionPayload | null>(restored?.session ?? null);
  const [user, setUser] = useState<User | null>(
    restored?.session ? userFromSession(restored.session) : null,
  );
  const [authError, setAuthError] = useState<string | null>(null);

  const updateSession = useCallback((s: SessionPayload) => {
    setSession(s);
    setUser(userFromSession(s));
    localStorage.setItem('memex-session', JSON.stringify(s));
  }, []);

  const acceptSession = useCallback((s: SessionPayload) => {
    if (s.token) {
      setToken(s.token);
      localStorage.setItem('memex-auth-token', s.token);
    }
    updateSession(s);
    setAuthError(null);

    // t-23 of doc-15: same-origin path-based routing means we no longer need a
    // cross-subdomain handoff. After a successful login we route the user to
    // their default tenant's /specs page. The default is the personal
    // membership (every signed-in user has exactly one).
    //
    // If the URL carries a `?returnTo=…` (legacy SSO bounce parameter), we
    // honour it when it points at our own host. Otherwise pick the personal
    // membership, falling back to the first available membership.
    if (s.token && typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get('returnTo');
      if (raw && isSafeReturnUrl(raw)) {
        try {
          const u = new URL(raw, window.location.origin);
          window.location.href = u.pathname + u.search + u.hash;
          return;
        } catch {
          // fall through
        }
      }

      const landing = computeDefaultLanding(s);
      if (landing && window.location.pathname === '/') {
        window.location.href = landing;
      }
    }
  }, [updateSession]);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setSession(null);
    localStorage.removeItem('memex-auth-token');
    localStorage.removeItem('memex-session');
    // In dev mode the bootstrap useEffect re-auths immediately; drop a sentinel so the
    // next page load skips it and the user sees the login screen.
    if (!getGoogleClientId()) {
      sessionStorage.setItem(DEV_LOGOUT_KEY, '1');
    }
    window.location.href = buildBareDomainUrl();
  }, []);

  const isAuthenticated = token !== null;

  // Honour ?returnTo=<path> on the bare URL for users who arrive already
  // authenticated (cached session from a previous visit). Path-based routing
  // means this is just a same-origin navigation — no token in the URL, no
  // cross-subdomain handoff dance.
  useEffect(() => {
    if (!token || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('returnTo');
    if (raw && isSafeReturnUrl(raw)) {
      try {
        const u = new URL(raw, window.location.origin);
        window.location.href = u.pathname + u.search + u.hash;
      } catch {
        /* ignore malformed */
      }
    }
  }, [token]);

  // Session bootstrap + background refresh. Fires once per token change:
  //   - If no session is cached, blocks rendering until /api/auth/me returns.
  //   - If a session IS cached (fast first paint), we still refresh in the background so
  //     schema changes shipped since the cache was written (new fields, new memberships)
  //     propagate without requiring the user to sign out and back in.
  // Token failures clear local state so the login screen takes over.
  const refreshSession = useCallback(async (): Promise<void> => {
    if (!token) return;
    try {
      const fresh = await fetchSessionApi(token);
      updateSession(fresh);
    } catch (err) {
      console.warn('Session refresh failed:', err);
      if (err instanceof AuthApiError && (err.status === 401 || err.status === 403)) {
        localStorage.removeItem('memex-auth-token');
        localStorage.removeItem('memex-session');
        setToken(null);
      }
    }
  }, [token, updateSession]);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  // doc-16 Phase 2: any user-scoped change that affects the membership list
  // (new memex created, joined a new org, role flipped, namespace renamed)
  // arrives on /api/me/events with userId-scoped events. Refetch the session
  // when those land so the MemexSwitcher, OrgConsentDialog and tenant
  // membership checks all stay current without a manual reload.
  useUserChangeStreamWithToken(token, refreshSession, [
    'memex',
    'org',
    'org_membership',
    'user_namespace',
  ]);

  // Dev-mode bootstrap: when no Google client is configured, mint a dev session by calling
  // /api/auth/sso/google with an empty idToken (the server's dev-mode fallback accepts it).
  const [devLoggedOut] = useState(() => !getGoogleClientId() && consumeDevLogoutSentinel());
  useEffect(() => {
    if (getGoogleClientId()) return;
    if (session) return;
    if (devLoggedOut) return;
    if (token) return; // rehydration effect will handle it
    ssoLoginApi('')
      .then(acceptSession)
      .catch((err) => console.warn('Dev session bootstrap failed:', err));
  }, [session, devLoggedOut, acceptSession, token]);

  // Dev-mode auto-bootstrap: assume the dev user is logged in unless they explicitly logged out.
  // The bootstrap useEffect above populates session; until it does, we still expose the context.
  const devUser: User = { id: '', name: 'Dev User', email: 'dev@memex.ai', picture: '' };

  const providedValue: AuthState = !getGoogleClientId() && !devLoggedOut
    ? {
        token,
        user: user ?? devUser,
        session,
        isAuthenticated: true,
        authError,
        logout,
        updateSession,
        acceptSession,
        refreshSession,
      }
    : {
        token,
        user,
        session,
        isAuthenticated,
        authError,
        logout,
        updateSession,
        acceptSession,
        refreshSession,
      };

  return (
    <AuthContext.Provider value={providedValue}>
      {children}
    </AuthContext.Provider>
  );
}

// The login screen moved out of AuthProvider so public-token-consuming routes (verify-email,
// magic-link, reset-password) can render under the provider without being blocked. App.tsx
// composes RequireAuth around authenticated routes.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, acceptSession } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const wrap = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      setError(null);
      try {
        return await fn();
      } catch (err) {
        setError(err instanceof AuthApiError ? err.message : err instanceof Error ? err.message : 'Failed');
        throw err;
      }
    },
    [],
  );

  const handleSignup = useCallback(
    (email: string, password: string) =>
      wrap(async () => {
        const s = await signupApi(email, password);
        acceptSession(s);
      }).then(() => undefined),
    [wrap, acceptSession],
  );
  const handleLogin = useCallback(
    (email: string, password: string) =>
      wrap(async () => {
        const s = await loginApi(email, password);
        acceptSession(s);
      }).then(() => undefined),
    [wrap, acceptSession],
  );
  const handleMagicLink = useCallback(
    (email: string) => wrap(async () => magicLinkRequestApi(email)).then(() => undefined),
    [wrap],
  );
  const handlePasswordReset = useCallback(
    (email: string) => wrap(async () => passwordResetRequestApi(email)).then(() => undefined),
    [wrap],
  );
  const handleGoogle = useCallback(
    (credential: string) =>
      wrap(async () => {
        const s = await ssoLoginApi(credential);
        acceptSession(s);
      }).then(() => undefined),
    [wrap, acceptSession],
  );

  if (isAuthenticated) return <>{children}</>;

  return (
    <LoginScreen
      authError={error}
      googleClientId={getGoogleClientId() ?? null}
      onSignup={handleSignup}
      onLogin={handleLogin}
      onMagicLink={handleMagicLink}
      onPasswordReset={handlePasswordReset}
      onGoogleCredential={handleGoogle}
    />
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
