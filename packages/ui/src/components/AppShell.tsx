import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useMatch } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { Logo } from './Logo';
import { useTheme } from './ThemeContext';
import { useDriftInboxCount } from '../hooks/useDriftInboxCount';
import { useMyIssuesCount } from '../hooks/useMyIssuesCount';
import { useHiddenFeatures } from '../hooks/useIsFeatureHidden';
import { MemexSwitcher } from './MemexSwitcher';
import { InviteMembersDialog } from './InviteMembersDialog';
import { PublicAuthButtons, ReadOnlyBadge } from './PublicAccessControls';
import { useMemexAccess } from '../hooks/useMemexAccess';
import { HeaderSlotProvider, useHeaderSlotContent } from './HeaderSlot';
import { SearchTrigger } from './SearchTrigger';
import {
  getCurrentTenant,
  parseTenantFromPathname,
  resolveNavTo,
} from '../utils/tenantUrl';

// Strip the leading /<namespace>/<memex> from a pathname so we can match
// the in-tenant suffix against the NAV_LINKS' `to` / `altPaths` values.
function stripTenantPrefix(pathname: string): string {
  const t = getCurrentTenant();
  if (!t) return pathname;
  const prefix = `/${t.namespace}/${t.memex}`;
  if (pathname === prefix) return '/';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}

// Resolve an in-tenant path to a concrete URL using the current pathname AND
// the session memberships. Prefers, in order: (1) the tenant in the URL, (2)
// the user's memex inside the namespace in the URL when the memex segment is
// missing (e.g. on the NamespaceHome `/<ns>/` "pick a Memex" page), and (3)
// the user's default landing tenant when the URL is fully flat. Pure helper
// so it can be exercised without rendering — `useNavTo` below is the React
// wrapper that pulls session + location from context.
const PRIMARY_NAV_LINKS: ReadonlyArray<{
  to: string;
  label: string;
  icon: ReactNode;
  altPaths?: readonly string[];
  // spec-146 t-3: when set, the link is hidden for every user whose session has
  // this slug in `hiddenFeatures` (server-driven feature-hide, dec-1 Option B).
  feature?: string;
}> = [
  // spec-158 t-4: nav order is Specs → Issues → Pulse. Specs leads (the primary
  // surface), the cross-Spec Issues page sits directly beneath it, and Pulse —
  // the activity dashboard — drops to the bottom of the primary group.
  {
    to: '/specs',
    label: 'Specs',
    // Legacy `/briefs`, `/missions`, and `/strategies` URLs route to the same
    // SpecList — kept here so the active-nav highlight still lights up when
    // the user lands via a bookmarked old URL (the 301 lives server-side).
    altPaths: ['/', '/briefs', '/missions', '/strategies'],
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11A9 9 0 1113 21.945M15 21l3-3m0 0l-3-3m3 3H9" />
      </svg>
    ),
  },
  {
    to: '/issues',
    label: 'Issues',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
    ),
  },
  {
    to: '/pulse',
    label: 'Pulse',
    feature: 'pulse',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4l2 6 4-12 2 6h6" />
      </svg>
    ),
  },
  // spec-179 (ac-14): Insights — per-memex spec analytics charts. Hidden via
  // the same server-driven hiddenFeatures mechanism as Pulse.
  {
    to: '/insights',
    label: 'Insights',
    feature: 'insights',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 20V10m6 10V4m6 16v-7" />
        <path strokeLinecap="round" d="M3 20h18" />
      </svg>
    ),
  },
  // Decisions tab — hidden until the page is implemented. The Decisions page
  // currently shows a "Coming soon" placeholder; bring this back when the
  // cross-Spec decisions view ships.
  // {
  //   to: '/decisions',
  //   label: 'Decisions',
  //   icon: (
  //     <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
  //       <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
  //     </svg>
  //   ),
  // },
];

const PRINCIPLES_NAV_LINKS: ReadonlyArray<{
  to: string;
  label: string;
  icon: ReactNode;
  altPaths?: readonly string[];
  // spec-146 t-3: see PRIMARY_NAV_LINKS — hidden when this slug is in the
  // session's `hiddenFeatures`.
  feature?: string;
}> = [
  {
    to: '/standards',
    label: 'Standards',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
      </svg>
    ),
  },
  {
    to: '/scaffold',
    label: 'Scaffold',
    feature: 'scaffold',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16M8 3v18M16 3v18" />
      </svg>
    ),
  },
];

interface UserMenuUser {
  name: string;
  email: string;
  picture?: string | null;
}

// Bottom-of-sidebar identity card. Click avatar/name to open the menu (account
// configuration + sign out). Theme toggle is a sibling button — visually next
// to the avatar but a separate action.
function SidebarUserCard({
  user,
  showOrgConfig,
  orgConfigHref,
  showMemexSettings,
  memexSettingsHref,
  showMemexKeys,
  memexKeysHref,
  onLogout,
  isDark,
  onToggleTheme,
}: {
  user: UserMenuUser;
  showOrgConfig: boolean;
  orgConfigHref: string;
  // spec-141 dec-5: per-Memex Settings is reached from here now the sidebar
  // gear is gone. Tenant-scoped + admin-gated, so it only appears when the
  // current Memex is one this user administers.
  showMemexSettings: boolean;
  memexSettingsHref: string;
  // spec-129 dec-8 (t-12): per-Memex emission keys — a member-level surface,
  // separate from the admin-only Settings entry above. Shown to any WRITING
  // member of the current Memex (not just admins); the server role-scopes what
  // each member sees / can revoke.
  showMemexKeys: boolean;
  memexKeysHref: string;
  onLogout: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative flex items-center gap-2" ref={wrapperRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors hover:bg-card-hover text-left"
      >
        {user.picture ? (
          <img
            src={user.picture}
            alt={user.name}
            className="w-8 h-8 rounded-full flex-none"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="w-8 h-8 rounded-full flex-none flex items-center justify-center text-sm font-medium bg-btn-secondary text-secondary">
            {user.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate text-primary">{user.name}</p>
          <p className="text-xs text-muted truncate">{user.email}</p>
        </div>
      </button>
      <button
        onClick={onToggleTheme}
        className="flex-none p-1.5 rounded-lg transition-colors text-secondary hover:text-primary hover:bg-card-hover"
        title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {isDark ? (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
          </svg>
        )}
      </button>
      {open && (
        <div className="absolute left-0 right-0 bottom-full mb-2 z-40 rounded-lg shadow-xl py-1 border bg-card-hover border-edge">
          {showMemexSettings && (
            <Link
              to={memexSettingsHref}
              onClick={() => setOpen(false)}
              className="block w-full text-left px-3 py-2 text-sm transition-colors text-secondary hover:text-primary hover:bg-overlay"
            >
              Memex settings
            </Link>
          )}
          {showMemexKeys && (
            <Link
              to={memexKeysHref}
              onClick={() => setOpen(false)}
              className="block w-full text-left px-3 py-2 text-sm transition-colors text-secondary hover:text-primary hover:bg-overlay"
            >
              Memex keys
            </Link>
          )}
          {showOrgConfig && (
            <Link
              to={orgConfigHref}
              onClick={() => setOpen(false)}
              className="block w-full text-left px-3 py-2 text-sm transition-colors text-secondary hover:text-primary hover:bg-overlay"
            >
              Org configuration
            </Link>
          )}
          <Link
            to="/settings/integrations"
            onClick={() => setOpen(false)}
            className="block w-full text-left px-3 py-2 text-sm transition-colors text-secondary hover:text-primary hover:bg-overlay"
          >
            Integrations
          </Link>
          <button
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="w-full text-left px-3 py-2 text-sm transition-colors text-secondary hover:text-primary hover:bg-overlay"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// spec-141 dec-2: the slot next to the MemexSwitcher used to hold a settings
// gear (→ per-Memex Settings). Per-Memex Settings now lives in the user menu
// ("Memex settings"), and this slot becomes a member-invite shortcut that
// reuses InviteMembersDialog (DRY). A person-add glyph signals "invite".
function InvitePersonIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM3 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 019.374 21c-2.331 0-4.512-.645-6.374-1.766z"
      />
    </svg>
  );
}

// Maps a nav link's in-tenant path to its voice-guide element id (the
// GLOBAL_GUIDE_ELEMENTS in @memex/shared). Only the always-visible links are
// tagged; soft-launch-hidden ones (Pulse, Scaffold) are intentionally absent.
const NAV_GUIDE_IDS: Record<string, string> = {
  '/specs': 'specs-nav',
  '/issues': 'issues-nav',
  '/insights': 'insights-nav',
  '/standards': 'standards-nav',
  '/drift': 'drift-nav',
};

function NavItem({
  to,
  label,
  icon,
  altPaths,
  pathname,
  badge,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  altPaths?: readonly string[];
  pathname: string;
  /** Optional count pill (e.g. open standards drift) shown at the row's end. */
  badge?: number;
}) {
  // t-23 of doc-15: NAV_LINKS hold the in-tenant path shape (e.g. "/specs").
  // resolveNavTo() expands this to /<ns>/<mx>/specs — falling back to the
  // user's memex within the namespace when only `/<ns>/` is in the URL (the
  // NamespaceHome "pick a Memex" page), and to the default landing tenant on
  // fully flat routes. Active-state matching is done against the in-tenant
  // suffix of the current pathname so `/<ns>/<mx>/specs` still highlights
  // the Specs link.
  const { session } = useAuth();
  const resolvedTo = resolveNavTo(to, pathname, session?.memberships);
  const tenantSuffix = stripTenantPrefix(pathname);
  const matchedAlt = altPaths?.includes(tenantSuffix) ?? false;
  // spec-190 (dec-4 / t-5): tag the global nav links so the voice guide can
  // highlight them ("show, don't just tell"). The ids are the GLOBAL_GUIDE_ELEMENTS
  // in @memex/shared guide-registry; keep the two in sync.
  const guideId = NAV_GUIDE_IDS[to];
  return (
    <NavLink
      to={resolvedTo}
      data-guide-id={guideId}
      className={({ isActive }) => {
        const active = isActive || matchedAlt;
        return [
          'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
          active
            ? 'text-heading bg-card-hover font-medium'
            : 'text-secondary hover:text-primary hover:bg-card-hover/60',
        ].join(' ');
      }}
    >
      {icon}
      <span>{label}</span>
      {typeof badge === 'number' && badge > 0 && (
        <span
          className="ml-auto flex-none text-xs font-medium px-1.5 py-0.5 rounded-full bg-status-danger-bg text-status-danger-text border border-status-danger-border"
          data-testid={`${to.replace(/^\//, '')}-nav-badge`}
        >
          {badge}
        </span>
      )}
    </NavLink>
  );
}

// Doc-page header. Renders inside HeaderSlotProvider so it can read the
// page-supplied right-side actions (status dropdown, share, download, menu).
// spec-192 t-3 (dec-2): the sidebar is hidden on doc pages, so the search trigger
// lives here. It sits as its OWN full-height flex column at the far right, AFTER
// the page actions (which stay in the flex-1 inner row) — so the borderless
// recess bleeds to the bar's top/bottom/right edges and can never overlap the
// Edit / Share / download / ⋯ controls (ac-11). The bar's background + border +
// blur move to the outer <header> so they sit behind the trigger too.
function DocPageHeader() {
  const slot = useHeaderSlotContent();
  const { session } = useAuth();
  const { pathname } = useLocation();
  const specsHref = resolveNavTo('/specs', pathname, session?.memberships);
  return (
    <header className="border-b flex-none flex items-stretch backdrop-blur-sm border-edge bg-page/80">
      <div className="flex-1 min-w-0 flex items-center gap-8 px-6 py-3">
        <Link
          to={specsHref}
          className="flex items-center text-heading hover:text-heading"
        >
          <Logo className="h-5" />
        </Link>
        <Link
          to={specsHref}
          className="text-sm transition-colors text-muted hover:text-primary"
        >
          &larr; All specs
        </Link>
        {slot && <div className="ml-auto flex items-center gap-2">{slot}</div>}
      </div>
      <SearchTrigger variant="doc-header" />
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, session, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  // spec-111 t-8 — public-Memex access posture for the current tenant.
  //   - anonymous visitor (no user) → "Sign up" CTA replaces the user card.
  //   - signed-in non-member on a public Memex → read-only sidebar badge.
  const access = useMemexAccess(location.pathname);
  // The chat | canvas split inside DocumentShell already fills the screen and
  // competes with a vertical sidebar for horizontal room. Hide the sidebar
  // entirely on doc pages — global nav is one click away via the back link.
  // Match both legacy `/docs/:id` and the path-based `/:namespace/:memex/docs/:id` route.
  // Per doc-30 dec-4 (post-b-105 rename): specs route at `/specs/:id` (same shell).
  const onDocPageFlat = !!useMatch('/docs/:id');
  const onDocPageTenant = !!useMatch('/:namespace/:memex/docs/:id');
  const onSpecPageTenant = !!useMatch('/:namespace/:memex/specs/:id');
  // spec-158: decision/issue deep-links (`specs/:id/decisions/:decId`,
  // `specs/:id/issues/:issueId`) render the SAME Spec page and need the same
  // doc-page chrome — without this match they fell into the sidebar layout
  // and lost the Spec top bar.
  const onSpecChildTenant = !!useMatch('/:namespace/:memex/specs/:id/:childType/:childId');
  const onDocPage = onDocPageFlat || onDocPageTenant || onSpecPageTenant || onSpecChildTenant;

  // Open standards drift count for the nav badge (b-63). Skipped on doc pages,
  // where the sidebar is hidden.
  const driftCount = useDriftInboxCount(!onDocPage);
  // spec-158: my open issues (Specs assigned to me) for the Issues nav badge.
  const myIssuesCount = useMyIssuesCount(!onDocPage);

  // spec-146 t-3: server-driven feature-hide. A nav link tagged with `feature`
  // is dropped for every user whose session lists that slug in `hiddenFeatures`
  // (independent of role). Resolved once here to honour the Rules of Hooks
  // rather than calling the hook inside `.map`. Fail-open: no session / unknown
  // slug ⇒ visible.
  const hiddenFeatures = useHiddenFeatures();
  const isLinkHidden = (feature?: string): boolean =>
    !!feature && hiddenFeatures.includes(feature);

  const isDark = theme === 'dark';
  // Org configuration is a multi-user-only concept (members, domain verification, rename).
  // Personal Memexes have no Org, so the owner is implicitly an admin but there's nothing
  // to configure — hide the link there to avoid a dead-end.
  // Resolve the current membership from the URL path so multi-membership users
  // (personal + team) get the correct role for the namespace they're browsing,
  // rather than relying on session?.currentMemexId which is null when the server
  // can't auto-resolve across multiple memberships.
  const tenant = parseTenantFromPathname(location.pathname);
  const currentMembership = tenant
    ? session?.memberships.find(
        (m) => m.slug === tenant.namespace && m.memexSlug === tenant.memex,
      )
    : session?.memberships.find((m) => m.memexId === session?.currentMemexId);
  const showOrgConfig =
    currentMembership?.role === 'administrator' && currentMembership?.kind === 'team';
  // spec-111: gear → per-Memex settings (visibility toggle). Admins only —
  // matching the server-side admin gate on the visibility PATCH and the
  // MemexSettings route guard. Personal-Memex owners come back as
  // role:'administrator' (services/users.ts), so they're included; VISITED
  // read-only rows come back as role:'member', so they're excluded.
  const canConfigureMemex =
    !!tenant && currentMembership?.role === 'administrator';
  // spec-129 dec-8 (t-12): "Memex keys" is a MEMBER-level surface — shown to any
  // WRITING member of the current Memex (member or admin), not just admins. A
  // VISITED read-only row (accessLevel 'read' / source 'visited') is excluded,
  // matching the server membership gate (requireMemexId) and the page's own
  // useMemexAccess guard. Same write rule as useMemexAccess.membershipGrantsWrite.
  const canManageMemexKeys =
    !!tenant &&
    !!currentMembership &&
    currentMembership.source !== 'visited' &&
    currentMembership.accessLevel !== 'read';
  const memexKeysHref = resolveNavTo('/keys', location.pathname, session?.memberships);
  const memexSettingsHref = resolveNavTo('/settings', location.pathname, session?.memberships);

  // spec-141 dec-2: invite shortcut in the old gear slot. Invites are an
  // org/team concept (InviteMembersDialog reads "Invite members to <org>"), so
  // it's shown only for team admins — never on a personal Memex, which has no
  // members to invite. The dialog targets the org via any of its memexes, so
  // the current membership's namespace/memex slugs satisfy the invite route.
  const [inviteOpen, setInviteOpen] = useState(false);
  const canInvite =
    showOrgConfig && !!currentMembership?.slug && !!currentMembership?.memexSlug;

  if (onDocPage) {
    return (
      <HeaderSlotProvider>
        <div className="h-screen flex flex-col overflow-hidden bg-page">
          <DocPageHeader />
          <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
        </div>
      </HeaderSlotProvider>
    );
  }

  return (
    <div className="h-screen flex overflow-hidden bg-page">
      <aside
        className="w-60 flex-none flex flex-col border-r border-edge bg-page"
        aria-label="Primary navigation"
        data-testid="primary-nav"
      >
        <div className="px-4 py-4">
          <Link
            to={resolveNavTo('/specs', location.pathname, session?.memberships)}
            className="flex items-center text-heading hover:text-heading"
          >
            <Logo className="h-5" />
          </Link>
        </div>

        <div className="px-3 pb-3">
          {/* Anonymous visitor on a public Memex: there's no session, so the
              Memex switcher (Personal / orgs) is meaningless. Show "Log in" +
              "Sign up" in its place (spec-111 t-8, ac-7). */}
          {!user && !access.isAuthenticated ? (
            <PublicAuthButtons returnTo={location.pathname + location.search} />
          ) : (
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <MemexSwitcher variant="sidebar" />
            </div>
            {/* spec-141 dec-2: this slot is now a member-invite shortcut
                (was the per-Memex settings gear; settings moved to the user
                menu). Reuses InviteMembersDialog — no second invite flow. */}
            {canInvite && (
              <button
                type="button"
                onClick={() => setInviteOpen(true)}
                title="Invite members"
                aria-label="Invite members"
                data-testid="invite-members-shortcut"
                className="flex-none p-2 rounded-lg border border-edge text-secondary transition-colors hover:text-primary hover:bg-card-hover"
              >
                <InvitePersonIcon />
              </button>
            )}
          </div>
          )}
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto px-3 space-y-0.5">
          {PRIMARY_NAV_LINKS.filter((link) => !isLinkHidden(link.feature)).map((link) => (
            <NavItem
              key={link.to}
              {...link}
              pathname={location.pathname}
              // spec-158: open-issue count on the Issues entry, scoped to MY
              // issues (Specs assigned to me) — matches the page's Mine default.
              badge={link.to === '/issues' ? myIssuesCount : undefined}
            />
          ))}

          <div className="pt-4 pb-1 px-3 text-xs font-medium uppercase tracking-wider text-muted">
            Principles
          </div>
          {PRINCIPLES_NAV_LINKS.filter((link) => !isLinkHidden(link.feature)).flatMap((link) => {
            const item = <NavItem key={link.to} {...link} pathname={location.pathname} />;
            // Drift Inbox sits directly under Standards (before Scaffold) — it's a
            // standards-scoped surface, so it belongs next to Standards.
            if (link.to === '/standards') {
              return [
                item,
                <NavItem
                  key="/drift"
                  to="/drift"
                  label="Drift Inbox"
                  pathname={location.pathname}
                  badge={driftCount}
                  icon={
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                  }
                />,
              ];
            }
            return [item];
          })}
        </nav>

        {(user || access.isVisitedReadOnly) && (
          <div className="border-t border-edge p-3 space-y-2">
            {/* Read-only badge for a signed-in non-member on a public Memex. */}
            {access.isAuthenticated && access.isVisitedReadOnly && <ReadOnlyBadge />}
            {user && (
              <SidebarUserCard
                user={user}
                showOrgConfig={showOrgConfig}
                orgConfigHref={resolveNavTo('/org', location.pathname, session?.memberships)}
                showMemexSettings={canConfigureMemex}
                memexSettingsHref={memexSettingsHref}
                showMemexKeys={canManageMemexKeys}
                memexKeysHref={memexKeysHref}
                onLogout={logout}
                isDark={isDark}
                onToggleTheme={toggleTheme}
              />
            )}
          </div>
        )}
      </aside>

      <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>

      {/* spec-141 dec-2: invite dialog (portal-rendered to body). Opened from
          the MemexSwitcher-adjacent shortcut above. */}
      {inviteOpen && canInvite && currentMembership && (
        <InviteMembersDialog
          namespaceSlug={currentMembership.slug}
          memexSlug={currentMembership.memexSlug}
          orgName={currentMembership.name}
          onClose={() => setInviteOpen(false)}
        />
      )}
    </div>
  );
}
