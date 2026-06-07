import { Fragment, useState, useEffect, useRef, useCallback } from 'react';
import { Routes, Route, useLocation, useParams, Navigate, Outlet } from 'react-router-dom';
import { Pulse } from './pages/Pulse';
import { Insights } from './pages/Insights';
import { Decisions } from './pages/Decisions';
import { SpecList } from './pages/SpecList';
import { IssuesList } from './pages/IssuesList';
import { NamespaceHome } from './pages/NamespaceHome';
import { StandardList } from './pages/StandardList';
import { Standard } from './pages/Standard';
import { DriftInbox } from './pages/DriftInbox';
import { DocumentList } from './pages/DocumentList';
import { DocDocument } from './pages/DocDocument';
import { InstallAuth } from './pages/InstallAuth';
import { OauthAuthorize } from './pages/OauthAuthorize';
// spec-141 dec-3: integrations consolidated into one open-core page.
// /settings/tokens, /installation and /install now redirect here.
import { SettingsIntegrations } from './pages/SettingsIntegrations';
import { Onboarding } from './pages/Onboarding';
import { InviteAccept } from './pages/InviteAccept';
import { OrgConfiguration } from './pages/OrgConfiguration';
import { ScaffoldInspect } from './pages/ScaffoldInspect';
import { MemexSettings } from './pages/MemexSettings';
import { MemexKeys } from './pages/MemexKeys';
import { VerifyDomain } from './pages/VerifyDomain';
import { SharedDocument } from './pages/SharedDocument';
import { Backstage } from './pages/Backstage';
import { VerifyEmail } from './pages/VerifyEmail';
import { VerifyEmailGate } from './pages/VerifyEmailGate';
import { MagicLinkConsume } from './pages/MagicLinkConsume';
import { ResetPassword } from './pages/ResetPassword';
import { AuthProvider, RequireAuth, useAuth, computeDefaultLanding } from './components/AuthContext';
import { ThemeProvider } from './components/ThemeContext';
import { ChatProvider } from './components/ChatContext';
import { AppShell } from './components/AppShell';
import { DocumentShell } from './components/DocumentShell';
import { OrgConsentDialog } from './components/OrgConsentDialog';
import { parseTenantFromPathname } from './utils/tenantUrl';
import { isFeatureHidden } from './utils/featureFlags';
import { probePublicMemex, type PublicMemexProbe } from './api/client';
import { PublicMemexProvider } from './components/PublicMemexContext';
import { VoiceSessionProvider } from './voice/session/VoiceSessionContext';
import { VoiceLayer } from './voice/session/VoiceLayer';
import { SearchPalette } from './components/SearchPalette';

declare const __BUILD_TIME__: string;

// t-23 of doc-15: the router is now path-based. Tenancy-scoped routes mount
// under a parent `/:namespace/:memex/*` layout. `TenantLayout` reads the
// params, validates them against the user's session memberships, and either
// renders the matched child route or redirects to a safe landing.
//
// Flat (caller-scoped) routes live outside the parent layout:
//   /login                  (rendered implicitly by RequireAuth's LoginScreen)
//   /onboarding             (post-signup flow before a tenant is chosen)
//   /share/:token           (public guests, no auth)
//   /invite/:token          (signed-in user accepts an invite for a tenant)
//   /verify-email           (token consumer)
//   /magic-link             (token consumer)
//   /reset-password         (token consumer)
//   /verify-domain/:token   (postmaster@ recipients)
//   /install, /installation,
//   /install/mcp/auth, /settings/tokens, /org, /account, /backstage, /invites
// VerifyEmailGate / Onboarding render INSIDE the relevant routes via the
// session-state checks below — they don't have their own URL.

// Anonymous readability probe for the current tenant Memex. `state` is 'loading'
// until known, then 'yes' (publicly readable) or 'no' (private / unknown / error);
// `memex` carries the probed Memex (name + visibility) on a 'yes'. `enabled` is
// false for authenticated users, so the hook is always called (rules of hooks)
// but only fetches for anonymous visitors.
type ReadableState = 'loading' | 'yes' | 'no';
function usePublicMemexProbe(
  namespace: string | undefined,
  memex: string | undefined,
  enabled: boolean,
): { state: ReadableState; memex: PublicMemexProbe | null } {
  const [result, setResult] = useState<{
    state: ReadableState;
    memex: PublicMemexProbe | null;
  }>({ state: 'loading', memex: null });
  useEffect(() => {
    if (!enabled || !namespace || !memex) {
      setResult({ state: 'loading', memex: null });
      return;
    }
    let cancelled = false;
    setResult({ state: 'loading', memex: null });
    probePublicMemex(namespace, memex).then((probed) => {
      if (!cancelled) {
        setResult(probed ? { state: 'yes', memex: probed } : { state: 'no', memex: null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, namespace, memex]);
  return result;
}

function TenantLayout() {
  const { namespace, memex } = useParams<{ namespace: string; memex: string }>();
  const { session, isAuthenticated } = useAuth();
  const location = useLocation();
  const anonymous = !isAuthenticated && !session;

  // spec-111 t-8 (ac-6/ac-7/ac-10): an ANONYMOUS visitor (no token, no session)
  // on a PUBLIC-Memex tenant route gets the read-only public shell. AppShell
  // renders the "Log in / Sign up" CTAs in place of the switcher (ac-7) and
  // DocumentShell shows the "Sign in to chat" placeholder (ac-10). Routed pages
  // gate every mutation behind useMemexAccess.canWrite (false for anonymous).
  //
  // But a PRIVATE (or unknown) Memex must NOT silently render an empty shell for
  // a visitor with no session — that was the regression where a lapsed session
  // dropped a real user onto a blank private Memex instead of the login screen.
  // We can't tell public from private without asking, so probe readability and:
  //   - public  → render the read-only shell
  //   - private/unknown → bounce to /login (returnTo brings them back)
  // The probe stays inert for authenticated users (enabled === false).
  const probe = usePublicMemexProbe(namespace, memex, anonymous);
  if (anonymous) {
    if (probe.state === 'loading') return null; // transient — avoid flashing the wrong UI
    if (probe.state === 'no') {
      const returnTo = encodeURIComponent(location.pathname + location.search);
      return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
    }
    // Public Memex: render the read-only shell. Provide the probed Memex so
    // PageHeader can show its name + 🌐 badge (no membership row to read them from).
    return (
      <PublicMemexProvider value={probe.memex}>
        <ChatProvider>
          <AppShell>
            <Fragment key={`${namespace}/${memex}`}>
              <Outlet />
            </Fragment>
          </AppShell>
        </ChatProvider>
      </PublicMemexProvider>
    );
  }

  // Wait for the session to bootstrap before deciding. Reading `session` while
  // null and routing on it leads to a "redirect to /, then redirect back once
  // session loads" double-bounce — and in the dev-mode + e2e path it also
  // makes membership checks race the SSO bootstrap. Render nothing for one
  // tick; the AuthContext useEffect runs synchronously after mount.
  if (!session) return null;

  // Onboarding/verification gates take precedence — even with a valid tenant
  // URL, an unverified user can't actually do anything yet.
  if (!session.user.emailVerified) {
    return <VerifyEmailGate />;
  }
  if (session.needsOnboarding) {
    return <Onboarding />;
  }

  // Membership check: redirect to the user's default tenant when they aren't
  // a member of the URL's namespace/memex. This replaces the host-based
  // PostLoginRouter redirect (which used to bounce non-members back to the
  // bare base domain).
  const ok = session.memberships.some(
    (m) => m.slug === namespace && (m.memexSlug === memex || (!m.memexSlug && memex === 'main')),
  );

  if (!ok) {
    const fallback = computeDefaultLanding(session);
    if (fallback) return <Navigate to={fallback} replace />;
    return <Navigate to="/" replace />;
  }

  // Force-remount the routed subtree when the tenant changes so each page's
  // initial-fetch effects + SSE subscriptions reconnect against the new
  // namespace/memex. Without the key, switching Memex updates the URL but
  // child pages keep their previous tenant's data (loadDocs is a stable
  // callback; useDocChangeStream captures tenantBase() once on connect).
  return (
    <ChatProvider>
      {/* spec-190 t-8: the voice guide is available on authed tenant routes (the
          guide-chat SSE leg needs a session). VoiceLayer is a fixed overlay
          rendered beside AppShell so the shell needs no edit and the public
          branch — which has no VoiceSessionProvider — never mounts it. */}
      <VoiceSessionProvider>
        <OrgConsentDialog />
        <AppShell>
          <Fragment key={`${namespace}/${memex}`}>
            <Outlet />
          </Fragment>
        </AppShell>
        <VoiceLayer />
      </VoiceSessionProvider>
    </ChatProvider>
  );
}

// `/` lands the authenticated user on their default tenant's specs page.
// Pre-auth users won't reach this (RequireAuth intercepts), but if the
// session loads with zero memberships we render the specs board behind
// no tenant (a legitimately rare case — every user has exactly one personal
// Memex by invariant; only stale local sessions hit this).
function RootRedirect() {
  const { session } = useAuth();
  if (!session) return null; // session bootstrap still pending
  if (session && !session.user.emailVerified) return <VerifyEmailGate />;
  if (session?.needsOnboarding) return <Onboarding />;
  const target = computeDefaultLanding(session);
  if (target) return <Navigate to={target} replace />;
  return null;
}

// Exported for the spec-146 t-4 route-gate tests (App.spec-146.test.tsx), which
// mount the real route tree to assert the `/scaffold` route is registered iff
// 'scaffold' isn't hidden.
export function PostLoginRouter() {
  // spec-146 t-4 (ac-10/ac-11): gate the `/scaffold` route on the server-driven
  // hide list. When 'scaffold' is hidden we don't register the route at all, so
  // `/:ns/:mx/scaffold` falls through to the catch-all `*` → RootRedirect →
  // default tenant (/specs). Conditional/falsy children of <Routes> are inert in
  // react-router 7, so the `&&` short-circuit is a valid, no-op child when hidden.
  const { session } = useAuth();
  return (
    <Routes>
      {/* Flat (caller-scoped) routes — no tenant prefix. */}
      <Route path="/" element={<RootRedirect />} />
      {/* `/login` is the LoginScreen path pre-auth (rendered by RequireAuth). Post-auth — or
          for users who hit it with a cached session — bounce to the default landing so it
          doesn't get caught by `/:namespace` below and resolved as a "login" namespace. */}
      <Route path="/login" element={<RootRedirect />} />
      <Route path="/onboarding" element={<Onboarding />} />
      <Route path="/invite/:token" element={<InviteAccept />} />
      {/* spec-141 dec-3: install instructions + MCP tokens folded into the one
          Integrations page. Old routes redirect (the /account→/org pattern).
          /install/mcp/auth (the device-authorize bootstrap) is untouched. */}
      <Route path="/install" element={<Navigate to="/settings/integrations" replace />} />
      <Route path="/installation" element={<Navigate to="/settings/integrations" replace />} />
      <Route path="/install/mcp/auth" element={<InstallAuth />} />
      <Route path="/oauth/authorize" element={<OauthAuthorize />} />
      <Route path="/settings/tokens" element={<Navigate to="/settings/integrations" replace />} />
      <Route path="/settings/integrations" element={<FlatShell><SettingsIntegrations /></FlatShell>} />
      <Route path="/invites" element={<Navigate to="/org?tab=invites" replace />} />
      <Route path="/org" element={<FlatShell><OrgConfiguration /></FlatShell>} />
      <Route path="/account" element={<Navigate to="/org" replace />} />

      {/* doc-19 t-10: namespace home — /<namespace>/ renders the kind-aware
          OrgHome / Personal Home. More specific /:namespace/:memex routes below
          take precedence (React Router 7 specificity). */}
      <Route path="/:namespace" element={<FlatShell><NamespaceHome /></FlatShell>} />

      {/* Tenancy-scoped routes — every path segment lives under /:ns/:mx. */}
      <Route path="/:namespace/:memex" element={<TenantLayout />}>
        <Route index element={<SpecList />} />
        {/* spec-148 t-1 (ac-6/ac-7/ac-8): gate the `/pulse` route on the
            server-driven hide list, mirroring the `/scaffold` gate below. When
            'pulse' is hidden the route isn't registered, so `/:ns/:mx/pulse`
            falls through to the catch-all `*` → RootRedirect → default tenant
            (/specs). The AppShell nav link is dropped by the same hiddenFeatures
            filter (the `feature: 'pulse'` tag on PRIMARY_NAV_LINKS). */}
        {!isFeatureHidden(session, 'pulse') && (
          <Route path="pulse" element={<Pulse />} />
        )}
        {/* spec-179 (ac-14): Insights — per-memex spec analytics. Same
            server-driven gate mechanism as /pulse above. */}
        {!isFeatureHidden(session, 'insights') && (
          <Route path="insights" element={<Insights />} />
        )}
        <Route path="decisions" element={<Decisions />} />
        <Route path="specs" element={<SpecList />} />
        {/* spec-158 t-4: the Memex-level Issues page — the cross-Spec roll-up of
            every open issue, grouped under its parent Spec. A plain member
            surface (no feature gate), mounted in the standard AppShell. */}
        <Route path="issues" element={<IssuesList />} />
        <Route path="standards" element={<StandardList />} />
        <Route path="standards/:id" element={<Standard />} />
        {/* spec-143 t-3: the Drift Inbox mounts in the same two-pane shell as
            the Spec page (`specs/:id`) — the agent ChatPanel beside the drift
            list — so the click-to-focus drift_item chip (handleFocus in
            DriftInbox) has a panel to land in. */}
        <Route
          path="drift"
          element={
            <DocumentShell>
              <DriftInbox />
            </DocumentShell>
          }
        />
        <Route path="docs" element={<DocumentList />} />
        <Route
          path="docs/:id"
          element={
            <DocumentShell>
              <DocDocument />
            </DocumentShell>
          }
        />
        {/* Per doc-30 dec-4 (post-b-105 rename): specs get a typed `/specs/:id`
            URL path that mirrors `/standards/:id`. Free-form documents and
            execution-plans keep `/docs/:id`. `DocDocument` is doc-type-agnostic;
            the URL difference is purely about the public surface. Legacy
            `/briefs/b-N` / `/missions/...` / `/strategies/...` URLs are
            301-redirected to `/specs/spec-N` by the server (b-105 t-5). */}
        <Route
          path="specs/:id"
          element={
            <DocumentShell>
              <DocDocument />
            </DocumentShell>
          }
        />
        {/* spec-64 i-3: Decision / Issue canonical deep-links (e.g. from the ⌘K
            palette) are `specs/:id/decisions/:decId` and `specs/:id/issues/:issueId`.
            They render the SAME Spec page; DocDocument reads the sub-param and opens
            the relevant tab + scrolls to the target. Without these routes the deeper
            path matched nothing under /:ns/:mx and fell through the catch-all `*` →
            RootRedirect → the caller's default (personal) Memex. Decisions/issues
            only ever hang off Specs, so only the `specs/...` shape is needed. */}
        <Route
          path="specs/:id/decisions/:decId"
          element={
            <DocumentShell>
              <DocDocument />
            </DocumentShell>
          }
        />
        <Route
          path="specs/:id/issues/:issueId"
          element={
            <DocumentShell>
              <DocDocument />
            </DocumentShell>
          }
        />
        <Route path="org" element={<OrgConfiguration />} />
        {/* spec-111 t-7: per-Memex settings — visibility (public ⇄ private)
            toggle. Owner/admin-gated server-side; non-admins get a 403 on the
            PATCH (the page renders for everyone but the flip is rejected). */}
        <Route path="settings" element={<MemexSettings />} />
        {/* spec-129 dec-8 t-12: per-Memex emission keys — own, member-visible
            page (Option B), separate from the admin-only settings page above.
            Any writing member can manage keys; the server role-scopes
            list/revoke (member: own; admin: all). */}
        <Route path="keys" element={<MemexKeys />} />
        {/* b-68 t-12/13/14: agent scaffold Inspect surface. Reads available to
            any active member; admin edits gated server-side (404 to non-admins).
            spec-146 t-4: omitted entirely when 'scaffold' is hidden so the path
            falls through to the catch-all below (→ default tenant). */}
        {!isFeatureHidden(session, 'scaffold') && (
          <Route path="scaffold" element={<ScaffoldInspect />} />
        )}
      </Route>

      {/* Anything else that doesn't match → bounce to the default tenant. */}
      <Route path="*" element={<RootRedirect />} />
    </Routes>
  );
}

// Wraps a flat (caller-scoped) page in the AppShell + ChatProvider so the
// sidebar still renders. The TenantLayout already provides these for tenant
// routes; flat routes that want chrome get them here.
function FlatShell({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  if (session && !session.user.emailVerified) return <VerifyEmailGate />;
  if (session?.needsOnboarding) return <Onboarding />;
  return (
    <ChatProvider>
      <OrgConsentDialog />
      <AppShell>{children}</AppShell>
    </ChatProvider>
  );
}

// spec-64 t-3 (ac-8/ac-16): the global ⌘K / Ctrl+K host. A THIN app-level
// keydown listener owns the hotkey — it toggles the palette and calls
// preventDefault() so the browser/cmdk never sees it (cmdk does NOT register the
// global shortcut, ac-16). It also owns focus-restoration (ac-8): because the
// palette opens programmatically (no Radix Dialog.Trigger), Radix has nothing to
// restore focus to on close and it would fall to <body>. So we capture the
// focused element when the palette opens and restore it on close — whether the
// close came from Esc, an overlay click, or a ⌘K toggle. (The jsdom component
// test can't model real focus restoration; journey-18 proves it.) Mounted
// app-wide so the omnibox is reachable from any route.
function GlobalSearchHost() {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const setOpenSafe = useCallback((next: boolean) => {
    if (next && !openRef.current) {
      // Opening: remember where focus was so we can hand it back on close.
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
    }
    openRef.current = next;
    setOpen(next);
    if (!next) {
      const el = restoreFocusRef.current;
      restoreFocusRef.current = null;
      // Restore on the next frame, after Radix's own close-autofocus (which
      // targets the absent trigger) has run — so our restore wins.
      if (el && typeof el.focus === 'function') {
        requestAnimationFrame(() => el.focus());
      }
    }
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpenSafe(!openRef.current);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpenSafe]);

  return <SearchPalette open={open} onOpenChange={setOpenSafe} />;
}

export function App() {
  console.log(`[memex.ai] deployed: ${__BUILD_TIME__}`);
  const location = useLocation();

  // Public routes rendered OUTSIDE AuthProvider (recipients may not be Memex users):
  //   /verify-domain/:token — admin@/postmaster@ inbox recipients (t-6)
  //   /share/:token         — external guests viewing shared docs (t-10)
  //   /backstage            — platform-admin workspace picker (dev-mode only on the backend)
  if (
    location.pathname.startsWith('/verify-domain/') ||
    location.pathname.startsWith('/share/') ||
    location.pathname === '/backstage' ||
    location.pathname.startsWith('/backstage/')
  ) {
    return (
      <ThemeProvider>
        <Routes>
          <Route path="/verify-domain/:token" element={<VerifyDomain />} />
          <Route path="/share/:token" element={<SharedDocument />} />
          <Route path="/backstage" element={<Backstage />} />
        </Routes>
      </ThemeProvider>
    );
  }

  // Token-bearing routes: these need AuthProvider (so `acceptSession` can store the
  // fresh JWT) but MUST NOT be blocked by RequireAuth — the user might not be signed in
  // when they click a magic link from their inbox.
  const isPublicAuthRoute =
    location.pathname === '/verify-email' ||
    location.pathname === '/magic-link' ||
    location.pathname === '/reset-password';

  return (
    <ThemeProvider>
      <AuthProvider>
        {isPublicAuthRoute ? (
          <Routes>
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route path="/magic-link" element={<MagicLinkConsume />} />
            <Route path="/reset-password" element={<ResetPassword />} />
          </Routes>
        ) : (
          <AuthGate>
            {/* spec-64 t-3: mount the ⌘K omnibox app-wide so it's reachable from
                every authenticated/public-tenant route. */}
            <GlobalSearchHost />
            <PostLoginRouter />
          </AuthGate>
        )}
      </AuthProvider>
    </ThemeProvider>
  );
}

// spec-111 t-8 (ac-6/ac-7): RequireAuth everywhere EXCEPT public tenant routes.
// An anonymous visitor on a `/:namespace/:memex/...` URL must NOT be shown the
// LoginScreen — they reach PostLoginRouter, where TenantLayout renders the
// read-only public shell (PublicAuthButtons + read-only content). Every other route
// keeps RequireAuth's login wall. The visibility decision (public vs private)
// is enforced server-side by the content reads (std-7), not here.
//
// Read `isAuthenticated` from context (so we re-render when a session lands) and
// the live pathname; `parseTenantFromPathname` returns null for caller-scoped
// routes (login, settings, share, …), so only true tenant URLs bypass the wall.
function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const isTenantRoute = parseTenantFromPathname(location.pathname) !== null;

  if (!isAuthenticated && isTenantRoute) {
    return <>{children}</>;
  }
  return <RequireAuth>{children}</RequireAuth>;
}

