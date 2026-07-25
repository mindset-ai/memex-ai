import {
  Fragment,
  Suspense,
  lazy,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { Routes, Route, useLocation, useParams, Navigate, Outlet } from 'react-router-dom';
import { emailPreviewEnabled } from './utils/devTools';
// spec-351: route-level code-splitting. Every top-level routed page is loaded
// as its own lazy chunk so the entry bundle no longer eagerly pulls all ~35
// page surfaces (and their heavy transitive deps — nivo charts, pixi, the
// markdown stack, the LangGraph runtime). The pages export named symbols, so
// each lazy import re-maps the named export onto `default` (what React.lazy
// expects). Non-route building blocks (AppShell, DocumentShell, the providers,
// and the VerifyEmailGate that several layouts render inline)
// stay eagerly imported below — splitting them would only add Suspense
// boundaries on the critical path with no payload win.
const Pulse = lazy(() => import('./pages/Pulse').then((m) => ({ default: m.Pulse })));
// spec-458 (PROTOTYPE) — the public live proof-of-life page. Fully public
// (rendered outside AuthProvider below, the /share pattern) and lazy so its
// world-map asset never rides the authenticated bundles.
const LivePage = lazy(() => import('./pages/live/LivePage').then((m) => ({ default: m.LivePage })));
const Insights = lazy(() => import('./pages/Insights').then((m) => ({ default: m.Insights })));
const QaReports = lazy(() => import('./pages/QaReports').then((m) => ({ default: m.QaReports })));
const Decisions = lazy(() => import('./pages/Decisions').then((m) => ({ default: m.Decisions })));
const SpecList = lazy(() => import('./pages/SpecList').then((m) => ({ default: m.SpecList })));
const IssuesList = lazy(() => import('./pages/IssuesList').then((m) => ({ default: m.IssuesList })));
const NamespaceHome = lazy(() =>
  import('./pages/NamespaceHome').then((m) => ({ default: m.NamespaceHome })),
);
const NamespaceSettings = lazy(() =>
  import('./pages/NamespaceSettings').then((m) => ({ default: m.NamespaceSettings })),
);
// The global Home Canvas (flat /home onboarding tracker) is PARKED for now — the
// per-memex Brain (the knowledge-graph landing) replaces it as the default surface.
// Kept in the tree, commented out, so it can be revived without re-plumbing.
// const HomeCanvas = lazy(() => import('./pages/HomeCanvas').then((m) => ({ default: m.HomeCanvas })));
// spec-502: the onboarding wizard (name → console demo → connect the agent →
// land populated). Reached from the Explore companion's "Create your own Memex".
const Wizard = lazy(() => import('./onboarding/Wizard').then((m) => ({ default: m.Wizard })));
const StandardList = lazy(() =>
  import('./pages/StandardList').then((m) => ({ default: m.StandardList })),
);
const Standard = lazy(() => import('./pages/Standard').then((m) => ({ default: m.Standard })));
// spec-498 — Brain: the whole-vault knowledge graph (facets/standards/specs/decisions).
const Brain = lazy(() => import('./pages/Brain').then((m) => ({ default: m.Brain })));
// The surface the tenant `/home` redirect forwards to — the single knob for "the
// default landing". Today it's the Trails route; change this one string to
// re-point every default landing (nothing else references the surface directly).
const DEFAULT_TENANT_SURFACE = 'trails';
// spec-300 t-6 — the in-app Skills surface (list + detail).
const SkillList = lazy(() => import('./pages/SkillList').then((m) => ({ default: m.SkillList })));
const Skill = lazy(() => import('./pages/Skill').then((m) => ({ default: m.Skill })));
// spec-226 t-6 — internal email-preview gallery (gated off prod, see emailPreviewEnabled).
const EmailPreview = lazy(() =>
  import('./pages/EmailPreview').then((m) => ({ default: m.EmailPreview })),
);
const DriftInbox = lazy(() => import('./pages/DriftInbox').then((m) => ({ default: m.DriftInbox })));
const DocumentList = lazy(() =>
  import('./pages/DocumentList').then((m) => ({ default: m.DocumentList })),
);
const DocDocument = lazy(() =>
  import('./pages/DocDocument').then((m) => ({ default: m.DocDocument })),
);
const InstallAuth = lazy(() => import('./pages/InstallAuth').then((m) => ({ default: m.InstallAuth })));
const OauthAuthorize = lazy(() =>
  import('./pages/OauthAuthorize').then((m) => ({ default: m.OauthAuthorize })),
);
// spec-141 dec-3: integrations consolidated into one open-core page.
// /settings/tokens, /installation and /install now redirect here.
const SettingsIntegrations = lazy(() =>
  import('./pages/SettingsIntegrations').then((m) => ({ default: m.SettingsIntegrations })),
);
const Onboarding = lazy(() => import('./pages/Onboarding').then((m) => ({ default: m.Onboarding })));
const WelcomePage = lazy(() =>
  import('./pages/WelcomePage').then((m) => ({ default: m.WelcomePage })),
);
const InviteAccept = lazy(() =>
  import('./pages/InviteAccept').then((m) => ({ default: m.InviteAccept })),
);
const OrgConfiguration = lazy(() =>
  import('./pages/OrgConfiguration').then((m) => ({ default: m.OrgConfiguration })),
);
const ScaffoldInspect = lazy(() =>
  import('./pages/ScaffoldInspect').then((m) => ({ default: m.ScaffoldInspect })),
);
const MemexSettings = lazy(() =>
  import('./pages/MemexSettings').then((m) => ({ default: m.MemexSettings })),
);
const MemexKeys = lazy(() => import('./pages/MemexKeys').then((m) => ({ default: m.MemexKeys })));
// spec-418 t-5 — the Manage-tags surface (tag catalogue admin). Renders in the
// normal AppShell sidebar layout (NOT the doc-page chrome) — see the AppShell
// guard that excludes the literal `tags` segment from the specs/:id doc match.
const ManageTags = lazy(() => import('./pages/ManageTags').then((m) => ({ default: m.ManageTags })));
const UpgradePlanSelect = lazy(() =>
  import('./pages/upgrade/UpgradePlanSelect').then((m) => ({ default: m.UpgradePlanSelect })),
);
const UpgradeSeats = lazy(() =>
  import('./pages/upgrade/UpgradeSeats').then((m) => ({ default: m.UpgradeSeats })),
);
const UpgradeConfirmation = lazy(() =>
  import('./pages/upgrade/UpgradeConfirmation').then((m) => ({ default: m.UpgradeConfirmation })),
);
const VerifyDomain = lazy(() =>
  import('./pages/VerifyDomain').then((m) => ({ default: m.VerifyDomain })),
);
const SharedDocument = lazy(() =>
  import('./pages/SharedDocument').then((m) => ({ default: m.SharedDocument })),
);
const Backstage = lazy(() => import('./pages/Backstage').then((m) => ({ default: m.Backstage })));
const BackstageExperiments = lazy(() =>
  import('./pages/BackstageExperiments').then((m) => ({ default: m.BackstageExperiments })),
);
const VerifyEmail = lazy(() => import('./pages/VerifyEmail').then((m) => ({ default: m.VerifyEmail })));
const MagicLinkConsume = lazy(() =>
  import('./pages/MagicLinkConsume').then((m) => ({ default: m.MagicLinkConsume })),
);
const ResetPassword = lazy(() =>
  import('./pages/ResetPassword').then((m) => ({ default: m.ResetPassword })),
);
// VerifyEmailGate stays eager — it is rendered inline by TenantLayout,
// FlatShell, and RootRedirect (not as a routed element), so it sits on the
// critical path for unverified users and is small.
import { VerifyEmailGate } from './pages/VerifyEmailGate';
import { AuthProvider, RequireAuth, useAuth, computeReturnLanding } from './components/AuthContext';
import { recordLastMemex } from './utils/lastMemex';
import { ThemeProvider } from './components/ThemeContext';
import { ChatProvider } from './components/ChatContext';
import { AppShell } from './components/AppShell';
import { ExploreCompanionMount } from './onboarding/ExploreCompanionMount';
import { DocumentShell } from './components/DocumentShell';
import { OrgConsentDialog } from './components/OrgConsentDialog';
import { DesktopMcpStatusSync } from './components/DesktopMcpStatusSync';
import { parseTenantFromPathname, tenantPathFor } from './utils/tenantUrl';
import { isOnboardingWizardEnabled } from './onboarding/flag';
import { isFeatureHidden } from './utils/featureFlags';
import { probePublicMemex, type PublicMemexProbe } from './api/client';
import { PublicMemexProvider } from './components/PublicMemexContext';
import { useTrackRouteChange, useTelemetry, trackAnonymous } from './hooks/useTelemetry';
import { useStaleTenantForward } from './hooks/useStaleTenantForward';
import { useShouldLandOnHome, isMcpConnectedCached } from './journeys/landing';
import { tenantBase, BASE_URL, fetchWithRetry } from './api/http';
import { SearchProvider } from './components/SearchContext';
import { WhatsNewRibbonConnected } from './components/whats-new/WhatsNewRibbonConnected';
import { WhatsNewProvider } from './components/whats-new/WhatsNewContext';

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

  // spec-244 t-6: front-end engagement capture. Fire nav.route_changed (template
  // only — no ids/query) as the user moves through the app. Disabled for anonymous
  // visitors; honours Do-Not-Track / opt-out inside the hook.
  useTrackRouteChange(anonymous ? null : location.pathname);

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

  // spec-479 dec-5: membership match for the URL's tenant (pure — safe while
  // session is still null). Reused below for the authed bounce.
  const matchedMembership =
    session?.memberships.find(
      (m) => m.slug === namespace && (m.memexSlug === memex || (!m.memexSlug && memex === 'main')),
    ) ?? null;
  const isMember = !!matchedMembership;

  // Remember the tenant the user is actively working in, so returning to the app
  // (bare URL / login) lands them back here instead of defaulting to personal
  // (computeReturnLanding). Only real, writable workspaces are recorded — never the
  // read-only Explore/visited memexes, which we should never auto-land on.
  const matchedSource = matchedMembership?.source;
  const matchedAccess = matchedMembership?.accessLevel;
  useEffect(() => {
    if (
      isMember &&
      namespace &&
      memex &&
      matchedSource !== 'featured' &&
      matchedSource !== 'visited' &&
      matchedAccess !== 'read'
    ) {
      recordLastMemex(namespace, memex);
    }
  }, [isMember, namespace, memex, matchedSource, matchedAccess]);
  // A stale tenant URL (a memex whose slug was renamed) would otherwise bounce
  // to /login (anonymous) or the default landing (authed non-member). Before
  // bouncing, ask the server whether the path forwards. Fires ONLY on the miss.
  const staleForward =
    (anonymous && probe.state === 'no') ||
    (!anonymous &&
      !!session &&
      session.user.emailVerified &&
      !!session.user.name &&
      !isMember);
  const forward = useStaleTenantForward(location.pathname, staleForward);

  if (anonymous) {
    if (probe.state === 'loading') return null; // transient — avoid flashing the wrong UI
    if (probe.state === 'no') {
      if (forward.state === 'loading') return null;
      if (forward.to) return <Navigate to={`${forward.to}${location.search}`} replace />;
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

  // The email-verification gate takes precedence — even with a valid tenant URL, an
  // unverified user can't actually do anything yet. spec-312 dec-3: this gate stays
  // exactly as is; the needsOnboarding wall that used to sit here is gone — an
  // incomplete-onboarding user is free to navigate anywhere (the journey lives on
  // /home as a recede-able layer, not a wall).
  if (!session.user.emailVerified) {
    return <VerifyEmailGate />;
  }
  if (!session.user.name) return <Navigate to="/onboarding" replace />; // spec-441
  // spec-507: the spec-444 welcome-video gate that used to sit here is GONE. Nothing
  // routes a user to /welcome any more — the page survives only as an opt-in rewatch
  // reached from the account menu. Do not reintroduce a redirect here.

  // Membership check: redirect to the user's default tenant when they aren't
  // a member of the URL's namespace/memex. This replaces the host-based
  // PostLoginRouter redirect (which used to bounce non-members back to the
  // bare base domain).
  if (!isMember) {
    // spec-479 dec-5: a renamed memex's old URL forwards here before bouncing.
    if (forward.state === 'loading') return null;
    if (forward.to) return <Navigate to={`${forward.to}${location.search}`} replace />;
    const fallback = computeReturnLanding(session);
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
      {/* spec-200: WhatsNewProvider lets the sidebar user menu re-open the
          popup and gives the ribbon the menu anchor to animate "into" on
          dismiss — so it wraps BOTH the ribbon and AppShell. */}
      <WhatsNewProvider>
        <OrgConsentDialog />
        {/* spec-200: global What's New ribbon — authed shell only. */}
        <WhatsNewRibbonConnected />
        <AppShell>
          <Fragment key={`${namespace}/${memex}`}>
            <Outlet />
          </Fragment>
        </AppShell>
        {/* spec-502 t-5: the context-aware Explore companion overlays the
            featured (building-itself) demo surface for wizard-eligible users.
            Renders nothing on the user's own memexes / when the flag is off. */}
        <ExploreCompanionMount namespace={namespace ?? ''} memex={memex ?? ''} />
      </WhatsNewProvider>
    </ChatProvider>
  );
}

// spec-421 dec-5 (supersedes spec-312 dec-1): `/` decides where an authenticated,
// email-verified user lands FROM A READ-ONLY ONBOARDING-STATE CHECK — not-yet-graduated
// → /home (the onboarding journey); graduated → the default-tenant Specs board. The
// decision is made here in the app router on first load, before drawing, so there is no
// stale-state flash. spec-312 made /home the universal landing because its final step was
// developer-only (Specs stranded non-developers); spec-421 hid those steps, so graduation
// is now "created your first spec" and engaged users go straight to their board.
//
// `useShouldLandOnHome` does a one-shot read of /api/me/journey-state (nothing is
// persisted — Barrie's constraint) and returns null while in flight. Pre-auth users
// won't reach this (RequireAuth intercepts). When 'home' is hidden per-env the /home
// route itself renders RootRedirect, so there we keep the loop-avoidance fallback to the
// default tenant — and skip the journey-state read entirely (no Home-vs-Specs choice to
// make). A session with zero memberships falls back to null → /.
// The tenant `/home` redirect target. Builds an ABSOLUTE `/:ns/:mx/<to>` path from
// the current route params — robust regardless of nesting, unlike relative-path
// resolution. `to` is DEFAULT_TENANT_SURFACE (today 'trails').
function TenantSurfaceRedirect({ to }: { to: string }) {
  const { namespace, memex } = useParams<{ namespace: string; memex: string }>();
  if (!namespace || !memex) return null; // params always present under /:ns/:mx
  return <Navigate to={`/${namespace}/${memex}/${to}`} replace />;
}

function RootRedirect() {
  const { session } = useAuth();
  const emailVerified = !!session?.user.emailVerified;
  const homeHidden = !!session && isFeatureHidden(session, 'home');
  // Only consult journey-state when we genuinely face the Home-vs-Specs choice
  // (authenticated, verified, and 'home' visible). Otherwise skip the read.
  const needDecision = !!session && emailVerified && !!session.user.name && !homeHidden;
  const landOnHome = useShouldLandOnHome(needDecision);

  // Engagement telemetry (advisory, fires once): record which way the router sent the
  // user so the Specs-vs-Home routing change can be measured (spec-421 dec-5 ac-20).
  const { track } = useTelemetry(true);
  const firedRef = useRef(false);
  useEffect(() => {
    if (!needDecision || landOnHome === null || firedRef.current) return;
    firedRef.current = true;
    // The Home Canvas is PARKED (the per-memex Brain replaces it), so the spec-470
    // dec-9 confirmedSpecLess → /home landing is retired: EVERY landing user now goes
    // to their default board, so `destination` is always 'specs'. `graduated`
    // (= hasSpec) stays the raw engagement signal (how many landers haven't graduated).
    // Restore the confirmedSpecLess → 'home' destination when the Home Canvas returns.
    const props = { destination: 'specs', graduated: !landOnHome };
    // RootRedirect renders at the flat `/` (or `/login`), where `track()` resolves the
    // tenant from the cached session. In the rare case there's no resolvable tenant (e.g.
    // a session with no current Memex yet), fall back to the anonymous ingress so the
    // engagement data point still lands. Both are advisory and never throw into routing.
    if (tenantBase()) track('home.landing_routed', props);
    else trackAnonymous('home.landing_routed', props);
  }, [needDecision, landOnHome, track]);

  if (!session) return null; // session bootstrap still pending
  if (!emailVerified) return <VerifyEmailGate />;
  if (!session.user.name) return <Navigate to="/onboarding" replace />; // spec-441
  // spec-507: the spec-444 first-timer video redirect used to fire HERE, ahead of the
  // spec-502 value-first landing below — so every new signup met a 4:43 explainer
  // before the wizard's first surface. Removed; the featured-demo branch is now the
  // first thing a spec-less user sees.
  if (homeHidden) {
    // Loop-avoidance: 'home' hidden ⇒ land on the last-visited (or default) tenant,
    // no journey read.
    const fallback = computeReturnLanding(session);
    return fallback ? <Navigate to={fallback} replace /> : null;
  }
  if (landOnHome === null) return null; // assessing onboarding state — draw nothing yet
  // spec-507: the spec-444 ac-17 re-show ("show the video every session until you
  // create a spec") lived here. It re-walled precisely the cohort that had already
  // bounced, every session. Gone.
  // spec-502 (ac-1): value-first onboarding. A spec-less new signup lands on the
  // featured demo Memex (building-itself) FIRST — where the context-aware Explore
  // companion invites them to "Create your own Memex" — instead of their own empty
  // board. Gated on the onboarding-wizard kill-switch (dec-5), and only fires when
  // the server has surfaced a featured demo membership (spec-500) AND the user is
  // UNACTIVATED — 0 specs AND no MCP (spec-508). landOnHome = !hasSpec; the MCP leg
  // reads the same journey-state the predicate just cached. The goal is to plant the
  // wizard's "install an MCP" ask in front of people who haven't yet; a user who has
  // authored a spec OR already connected an agent falls through to their normal board.
  const mcpConnected = isMcpConnectedCached();
  if (landOnHome && !mcpConnected && isOnboardingWizardEnabled(session)) {
    const featured = session.memberships.find((m) => m.source === 'featured');
    if (featured) {
      const mx = featured.memexSlug ?? 'main';
      return <Navigate to={tenantPathFor(featured.slug, mx, '/home')} replace />;
    }
  }
  // The global /home (build-prompt hero) is PARKED — the per-memex Brain replaces it as
  // the default surface. The spec-470 dec-9 confirmedSpecLess → /home auto-land is
  // therefore retired: everyone now falls through to their tenant landing. This is the
  // returning-user landing, so it prefers the tenant they were last in
  // (computeReturnLanding), falling back to personal — instead of always personal.
  // Revive the confirmedSpecLess → /home branch here if the Home Canvas comes back.
  const target = computeReturnLanding(session);
  if (target) return <Navigate to={target} replace />;
  return null;
}

// Exported for the spec-146 t-4 route-gate tests (App.spec-146.test.tsx), which
// mount the real route tree to assert the `/scaffold` route is registered iff
// 'scaffold' isn't hidden.
// spec-351: the fallback shown while a route's lazy chunk is in flight. We
// render nothing (matching the existing "render null until ready" pattern that
// TenantLayout/RootRedirect already use during session bootstrap) so there is
// no chrome flash — the surrounding AppShell/DocumentShell chrome is itself
// eager, so only the inner page area is ever suspended, and chunks resolve in
// a tick. A single boundary wraps each <Routes> tree (not per-route), so it
// covers whichever page matches without adding waterfalls.
const RouteFallback = null;

export function PostLoginRouter() {
  // spec-146 t-4 (ac-10/ac-11): gate the `/scaffold` route on the server-driven
  // hide list. When 'scaffold' is hidden we don't register the route at all, so
  // `/:ns/:mx/scaffold` falls through to the catch-all `*` → RootRedirect →
  // default tenant (/specs). Conditional/falsy children of <Routes> are inert in
  // react-router 7, so the `&&` short-circuit is a valid, no-op child when hidden.
  const { session } = useAuth();
  return (
    <Suspense fallback={RouteFallback}>
    {/* spec-304 t-58 (issue-24 #1): app-global MCP status sync — mounted once,
        outside <Routes>, so the native pill is driven on EVERY route, not only
        on Settings → Integrations. Renders nothing; no-op in a plain browser. */}
    <DesktopMcpStatusSync />
    <Routes>
      {/* Flat (caller-scoped) routes — no tenant prefix. */}
      <Route path="/" element={<RootRedirect />} />
      {/* `/login` is the LoginScreen path pre-auth (rendered by RequireAuth). Post-auth — or
          for users who hit it with a cached session — bounce to the default landing so it
          doesn't get caught by `/:namespace` below and resolved as a "login" namespace. */}
      <Route path="/login" element={<RootRedirect />} />
      <Route path="/onboarding" element={<Onboarding />} />
      {/* spec-444: full-page welcome video. Standalone (no AppShell) — no FlatShell wrapper. */}
      <Route path="/welcome" element={<WelcomePage />} />
      {/* spec-502: the onboarding wizard. The Explore companion's CTA opens it as a
          large closeable modal (WizardModal) over the live Memex; this standalone
          full-page route stays for direct/resume deep-links (no AppShell). */}
      <Route path="/wizard" element={<div className="min-h-screen flex flex-col justify-center"><Wizard /></div>} />
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
      {/* spec-226 t-6: internal email-preview gallery. Gated off prod — the
          conditional Route is inert when emailPreviewEnabled() is false (falls
          through to RootRedirect), mirroring the server's prod-unmounted API. */}
      {emailPreviewEnabled() && (
        <Route path="/email-preview" element={<FlatShell><EmailPreview /></FlatShell>} />
      )}
      <Route path="/invites" element={<Navigate to="/org?tab=invites" replace />} />
      <Route path="/org" element={<FlatShell><OrgConfiguration /></FlatShell>} />
      {/* spec-171: in-app upgrade flow. Flat routes so website CTAs land here
          without a tenant prefix. confirmation before :plan so it isn't caught
          as a plan param. */}
      <Route path="/upgrade" element={<FlatShell><UpgradePlanSelect /></FlatShell>} />
      <Route path="/upgrade/confirmation" element={<FlatShell><UpgradeConfirmation /></FlatShell>} />
      <Route path="/upgrade/:plan" element={<FlatShell><UpgradeSeats /></FlatShell>} />
      <Route path="/account" element={<Navigate to="/org" replace />} />
      {/* Home Canvas PARKED — the per-memex Brain replaces the flat /home onboarding
          tracker as the default surface. The route stays registered (a flat,
          single-segment path would otherwise be claimed by /:namespace below,
          resolving "home" as a namespace) but now always RootRedirects to the
          default tenant landing. To revive the tracker, restore the isFeatureHidden
          branch below and un-comment the HomeCanvas import at the top of this file.
            element={
              isFeatureHidden(session, 'home') ? (
                <RootRedirect />
              ) : (
                <FlatShell>
                  <HomeCanvas />
                </FlatShell>
              )
            }
      */}
      <Route path="/home" element={<RootRedirect />} />


      {/* Bare /specs is a flat, single-segment path with no tenant prefix, so it
          would otherwise be claimed by /:namespace below and resolved as a bogus
          "specs" namespace. The specs board is tenant-scoped (/<ns>/<mx>/specs);
          send the user to their default landing (their personal memex's Specs board;
          spec-461: never /home). Same RootRedirect pattern as /login and hidden /home. */}
      <Route path="/specs" element={<RootRedirect />} />

      {/* doc-19 t-10: namespace home — /<namespace>/ renders the kind-aware
          OrgHome / Personal Home. More specific /:namespace/:memex routes below
          take precedence (React Router 7 specificity). */}
      <Route path="/:namespace" element={<FlatShell><NamespaceHome /></FlatShell>} />

      {/* spec-481 t-2 (ac-4): per-namespace settings — the namespace-slug rename
          surface. `settings` is a reserved slug (no Memex can be named it), so
          this static segment safely wins over the `/:namespace/:memex` dynamic
          route below (RRv7 ranks static above dynamic). Declared before it to
          keep the precedence obvious to a reader too. */}
      <Route path="/:namespace/settings" element={<FlatShell><NamespaceSettings /></FlatShell>} />

      {/* Tenancy-scoped routes — every path segment lives under /:ns/:mx. */}
      <Route path="/:namespace/:memex" element={<TenantLayout />}>
        {/* The memex's default landing is the Brain — the whole-vault knowledge
            graph (facets/standards/specs/decisions + drift). Was the Specs board;
            the Specs board still lives at the explicit /specs route below. */}
        <Route index element={<Brain />} />
        {/* The canonical default landing (AuthContext.computeDefaultLanding sends
            every post-auth flow here). `/home` is a thin redirect, not a surface:
            it forwards to whichever route is currently chosen as the default. One
            knob — DEFAULT_TENANT_SURFACE — so the choice lives in a single place and
            callers only ever need to know "/home", not the surface behind it. The
            redirect builds an ABSOLUTE tenant path from the route params so it can
            never mis-resolve (no reliance on relative-path segment math). */}
        <Route path="home" element={<TenantSurfaceRedirect to={DEFAULT_TENANT_SURFACE} />} />
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
        {/* spec-260 (dec-5): QA Reports — the workspace feed of build-session
            QA reports. Same server-driven hiddenFeatures gate as /pulse. */}
        {!isFeatureHidden(session, 'qa-reports') && (
          <Route path="qa-reports" element={<QaReports />} />
        )}
        <Route path="decisions" element={<Decisions />} />
        <Route path="specs" element={<SpecList />} />
        {/* spec-418 t-5: the Manage-tags surface. A literal `specs/tags` segment —
            registered before `specs/:id` so it's never resolved as a Spec handle.
            It renders inside TenantLayout → AppShell's sidebar layout (the AppShell
            doc-page match excludes the literal `tags` segment). */}
        <Route path="specs/tags" element={<ManageTags />} />
        {/* spec-158 t-4: the Memex-level Issues page — the cross-Spec roll-up of
            every open issue, grouped under its parent Spec. A plain member
            surface (no feature gate), mounted in the standard AppShell. */}
        <Route path="issues" element={<IssuesList />} />
        <Route path="standards" element={<StandardList />} />
        <Route path="standards/:id" element={<Standard />} />
        {/* spec-498: Trails — the whole-vault knowledge graph view. The route is
            user-facing so it carries the display name (/trails); the component and
            its `brain-*` testids stay internal (the rename is display-only). */}
        <Route path="trails" element={<Brain />} />
        {/* spec-300 t-6: Skills — the reusable-SKILL.md surface (list + detail). */}
        <Route path="skills" element={<SkillList />} />
        <Route path="skills/:id" element={<Skill />} />
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
    </Suspense>
  );
}

// Wraps a flat (caller-scoped) page in the AppShell + ChatProvider so the
// sidebar still renders. The TenantLayout already provides these for tenant
// routes; flat routes that want chrome get them here.
function FlatShell({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  // spec-507: `useLocation()` used to feed the welcome-video gate's
  // `!location.pathname.startsWith('/welcome')` guard. That gate is gone, and
  // nothing else here reads the location.
  if (session && !session.user.emailVerified) return <VerifyEmailGate />;
  if (session && !session.user.name) return <Navigate to="/onboarding" replace />; // spec-441
  // spec-507: the fourth and quietest spec-444 gate lived here — it walled deep links
  // to flat routes (/settings/*, /org) too. Removed with the other three.
  return (
    <ChatProvider>
      <OrgConsentDialog />
      <AppShell>{children}</AppShell>
    </ChatProvider>
  );
}

// spec-192 t-1: the ⌘K omnibox host — open-state, the ⌘K / Ctrl K hotkey, and
// open/close focus-restoration (originally spec-64's GlobalSearchHost) — now
// lives in SearchProvider (components/SearchContext) so the Specs-board and
// doc-page chrome can open the same single palette. App just mounts the provider
// around the router below.

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
    location.pathname === '/live' ||
    location.pathname === '/backstage' ||
    location.pathname.startsWith('/backstage/')
  ) {
    return (
      <ThemeProvider>
        <Suspense fallback={RouteFallback}>
          <Routes>
            <Route path="/verify-domain/:token" element={<VerifyDomain />} />
            <Route path="/share/:token" element={<SharedDocument />} />
            {/* spec-458 (PROTOTYPE): public proof-of-life page — no auth, no tenant. */}
            <Route path="/live" element={<LivePage />} />
            <Route path="/backstage" element={<Backstage />} />
            <Route path="/backstage/experiments" element={<BackstageExperiments />} />
          </Routes>
        </Suspense>
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
          <Suspense fallback={RouteFallback}>
            <Routes>
              <Route path="/verify-email" element={<VerifyEmail />} />
              <Route path="/magic-link" element={<MagicLinkConsume />} />
              <Route path="/reset-password" element={<ResetPassword />} />
            </Routes>
          </Suspense>
        ) : (
          <AuthGate>
            {/* spec-64 t-3 / spec-192 t-1: SearchProvider owns the single ⌘K
                palette + open-state and exposes openSearch() to the chrome
                (Specs-board + doc-page triggers); it wraps the router so those
                surfaces sit inside the context. */}
            <SearchProvider>
              <PostLoginRouter />
            </SearchProvider>
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

