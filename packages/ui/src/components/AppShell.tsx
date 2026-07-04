import { type ReactNode, useEffect, useRef, useState } from 'react';
import { SeatsWarningBanner } from './upgrade/SeatsWarningBanner';
import { Link, NavLink, useLocation, useMatch } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { Logo } from './Logo';
import { useTheme } from './ThemeContext';
import { useDriftInboxCount } from '../hooks/useDriftInboxCount';
import { useJourneyGraduated } from '../hooks/useJourneyGraduated';
import { useMyIssuesCount } from '../hooks/useMyIssuesCount';
import { useQaReportsUnreadCount } from '../hooks/useQaReports';
import { useHiddenFeatures } from '../hooks/useIsFeatureHidden';
import { MemexSwitcher } from './MemexSwitcher';
import { InviteMembersDialog } from './InviteMembersDialog';
import { PublicAuthButtons, ReadOnlyBadge } from './PublicAccessControls';
import { useMemexAccess } from '../hooks/useMemexAccess';
import { emailPreviewEnabled } from '../utils/devTools';
import { HeaderSlotProvider, useHeaderSlotContent } from './HeaderSlot';
import { SearchTrigger } from './SearchTrigger';
import { useWhatsNew } from './whats-new/WhatsNewContext';
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
interface NavLinkDef {
  to: string;
  label: string;
  icon: ReactNode;
  altPaths?: readonly string[];
  // spec-146 t-3: when set, the link is hidden for every user whose session has
  // this slug in `hiddenFeatures` (server-driven feature-hide, dec-1 Option B).
  feature?: string;
  // spec-303 — a flat, user-level link (e.g. /home): used verbatim, NOT expanded
  // to /<ns>/<mx>/... by resolveNavTo. The surface is the same across all memexes.
  flat?: boolean;
}

// spec-303 — the Home Canvas: the top nav item and a user-level (flat) destination,
// identical across all of a user's Memexes (dec-2). `flat` keeps it at /home.
// `feature: 'home'` plugs it into the server-driven hide list (HIDDEN_FEATURES)
// so the whole surface can be hidden per-env (e.g. prod) while it's live on int —
// the same mechanism as Pulse/Scaffold. The route is gated in App.tsx to match.
const HOME_NAV_LINK: NavLinkDef = {
  to: '/home',
  label: 'Home',
  flat: true,
  feature: 'home',
  icon: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3v-5a1 1 0 011-1h2a1 1 0 011 1v5h3a1 1 0 001-1V10" />
    </svg>
  ),
};

// spec-260 t-11: the sidebar is two labelled groups. PRINCIPLES holds the
// working surfaces (Specs leads, then the dashboards and the standards/scaffold
// references); IN-BOXES holds the three attention surfaces that carry unread /
// open-count badges (Drift, Issues, QA Reports).
const PRINCIPLES_NAV_LINKS: ReadonlyArray<NavLinkDef> = [
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
    to: '/pulse',
    label: 'Pulse',
    feature: 'pulse',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4l2 6 4-12 2 6h6" />
      </svg>
    ),
  },
  {
    to: '/standards',
    label: 'Standards',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
      </svg>
    ),
  },
  // spec-300 t-6: Skills — reusable SKILL.md docs the agent can pick up. Sits
  // beside Standards as a Principles surface (both are living reference docs).
  {
    to: '/skills',
    label: 'Skills',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
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

// spec-260 t-11: the IN-BOXES group — every surface here carries a count badge
// (open drift items, my open issues, unread QA reports).
const INBOX_NAV_LINKS: ReadonlyArray<NavLinkDef> = [
  {
    to: '/drift',
    label: 'Drift',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
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
  // spec-260 (dec-5): QA Reports — the workspace-wide feed of build-session QA
  // reports, one row per session. Same server-driven hiddenFeatures gate as
  // Pulse/Insights; carries the per-user unread badge (dec-6).
  {
    to: '/qa-reports',
    label: 'QA Reports',
    feature: 'qa-reports',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6M9 8h1m4.5-5.5H7a2 2 0 00-2 2v15a2 2 0 002 2h10a2 2 0 002-2V8z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 2.5V8h5.5" />
      </svg>
    ),
  },
];

interface UserMenuUser {
  name: string;
  email: string;
  picture?: string | null;
}

// spec-456 — icons for the account menu rows, in the heroicons-outline
// convention already used in this file (the theme toggle, InvitePersonIcon):
// w-4 h-4, fill:none, stroke:currentColor so each icon follows its row's
// text-secondary→text-primary hover colour. Module-level so they're defined
// once, not re-created per render.
const MENU_ICON_CLASS = 'w-4 h-4 flex-none';

// The "What's New" gift, split into an unwrappable lid + a hidden sparkle
// (both animated by the .wn-* rules in index.css on group hover/focus).
function WhatsNewGiftIcon() {
  return (
    <svg
      className={MENU_ICON_CLASS}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="9" rx="1.6" />
      <line x1="12" y1="11" x2="12" y2="20" />
      <path
        className="wn-sparkle"
        d="M12 12.4l0.7 1.6 1.6 0.7-1.6 0.7-0.7 1.6-0.7-1.6-1.6-0.7 1.6-0.7z"
        stroke="#ffb020"
        fill="#ffb020"
      />
      <g className="wn-lid">
        <rect x="3" y="7.2" width="18" height="4.6" rx="1.4" />
        <line x1="12" y1="7.2" x2="12" y2="11.8" />
        <path d="M9.3 7.2c-1.6 0-2.6-1-2.6-2.2S7.6 2.8 9 2.8c1.7 0 2.6 2.2 3 4.4" />
        <path d="M14.7 7.2c1.6 0 2.6-1 2.6-2.2S16.4 2.8 15 2.8c-1.7 0-2.6 2.2-3 4.4" />
      </g>
    </svg>
  );
}

function SettingsGearIcon() {
  return (
    <svg className={MENU_ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.752.43.992l1.005.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.752-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg className={MENU_ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
    </svg>
  );
}

function OrgBuildingIcon() {
  return (
    <svg className={MENU_ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
    </svg>
  );
}

function IntegrationsLinkIcon() {
  return (
    <svg className={MENU_ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
    </svg>
  );
}

function PlayCircleIcon() {
  return (
    <svg className={MENU_ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.91 11.672a.375.375 0 010 .656l-5.603 3.113a.375.375 0 01-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg className={MENU_ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
    </svg>
  );
}

// One shared row style so every account-menu item matches (was duplicated on
// each Link/button). Danger variant reddens Sign out on hover so a destructive
// action reads differently from the settings links above it.
const USER_MENU_ITEM_CLASS =
  'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm rounded-md transition-colors text-secondary hover:text-primary hover:bg-overlay';
const USER_MENU_DANGER_CLASS =
  'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm rounded-md transition-colors text-secondary hover:text-status-danger-text hover:bg-overlay';

function UserMenuDivider() {
  return <div role="separator" className="my-1 border-t border-edge" />;
}

function UserMenuLink({
  to,
  icon,
  onClick,
  testId,
  children,
}: {
  to: string;
  icon: ReactNode;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} onClick={onClick} data-testid={testId} className={USER_MENU_ITEM_CLASS}>
      {icon}
      {children}
    </Link>
  );
}

// spec-456 — the What's New row's click flourish: a short confetti burst drawn
// from the gift icon before the What's New popup opens. Purely decorative, so
// it fails safe: a no-op under prefers-reduced-motion, and wherever the canvas
// 2D context is unavailable (e.g. jsdom in unit tests, canvas.getContext → null).
function burstWhatsNewConfetti(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  const prefersReduced =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) return;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    // jsdom (no canvas pkg) throws "Not implemented" here; treat as no-op.
    return;
  }
  if (!ctx) return;

  const colors = ['#ff6b3d', '#ffc94d', '#2fbfa8', '#5b7cfa'];
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const count = 16;
  const particles = Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const speed = 1.6 + Math.random() * 1.8;
    return {
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1.2,
      size: 2.5 + Math.random() * 2,
      color: colors[i % colors.length],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
    };
  });

  const DURATION = 650;
  const start = performance.now();
  function frame(now: number) {
    const elapsed = now - start;
    const life = Math.max(0, 1 - elapsed / DURATION);
    ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
    for (const p of particles) {
      p.vy += 0.09;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx!.save();
      ctx!.globalAlpha = life;
      ctx!.translate(p.x, p.y);
      ctx!.rotate(p.rot);
      ctx!.fillStyle = p.color;
      ctx!.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx!.restore();
    }
    if (elapsed < DURATION) {
      requestAnimationFrame(frame);
    } else {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
    }
  }
  requestAnimationFrame(frame);
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
  // spec-200: this card is the fly-home target for the What's New ribbon, and
  // hosts the "What's New" menu item that re-opens the popup.
  const { available: whatsNewAvailable, openPopup: openWhatsNew, registerMenuAnchor } = useWhatsNew();

  useEffect(() => {
    registerMenuAnchor(wrapperRef.current);
    return () => registerMenuAnchor(null);
  }, [registerMenuAnchor]);

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
        // spec-456 — grouped into four sections divided by rules: notification,
        // then the settings/config cluster, then help, then the account exit.
        // Every row carries a leading icon; Sign out is set apart with a danger
        // hover. No item is added, removed, or re-routed vs. the flat list.
        <div className="absolute left-0 right-0 bottom-full mb-2 z-40 rounded-lg shadow-xl py-1 px-1 border bg-card-hover border-edge">
          {whatsNewAvailable && (
            <>
              <button
                data-testid="user-menu-whats-new"
                onClick={(e) => {
                  // The gift's confetti fires from its own icon canvas, then the
                  // What's New popup opens (behaviour unchanged from the flat menu).
                  burstWhatsNewConfetti(e.currentTarget.querySelector('canvas'));
                  setOpen(false);
                  openWhatsNew();
                }}
                className={`group ${USER_MENU_ITEM_CLASS}`}
              >
                <span className="relative flex-none">
                  <WhatsNewGiftIcon />
                  <canvas
                    data-testid="user-menu-whats-new-confetti"
                    aria-hidden="true"
                    width={72}
                    height={72}
                    className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
                  />
                </span>
                What's New
              </button>
              <UserMenuDivider />
            </>
          )}
          {showMemexSettings && (
            <UserMenuLink to={memexSettingsHref} icon={<SettingsGearIcon />} onClick={() => setOpen(false)}>
              Memex settings
            </UserMenuLink>
          )}
          {showMemexKeys && (
            <UserMenuLink to={memexKeysHref} icon={<KeyIcon />} onClick={() => setOpen(false)}>
              Memex keys
            </UserMenuLink>
          )}
          {showOrgConfig && (
            <UserMenuLink to={orgConfigHref} icon={<OrgBuildingIcon />} onClick={() => setOpen(false)}>
              Org configuration
            </UserMenuLink>
          )}
          <UserMenuLink to="/settings/integrations" icon={<IntegrationsLinkIcon />} onClick={() => setOpen(false)}>
            Integrations
          </UserMenuLink>
          <UserMenuDivider />
          {/* spec-226 t-6: internal email-preview gallery, gated off prod. */}
          {emailPreviewEnabled() && (
            <UserMenuLink
              to="/email-preview"
              icon={<PlayCircleIcon />}
              testId="user-menu-email-preview"
              onClick={() => setOpen(false)}
            >
              Email preview
            </UserMenuLink>
          )}
          {/* spec-444: always-visible rewatch entry — present regardless of dismissal state. */}
          <UserMenuLink to="/welcome?rewatch=1" icon={<PlayCircleIcon />} onClick={() => setOpen(false)}>
            Watch intro video
          </UserMenuLink>
          <UserMenuDivider />
          <button
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className={USER_MENU_DANGER_CLASS}
          >
            <LogoutIcon />
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
  flat,
  showDot,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  altPaths?: readonly string[];
  pathname: string;
  /** Optional count pill (e.g. open standards drift) shown at the row's end. */
  badge?: number;
  /** spec-303 — flat (user-level) link: use `to` verbatim, no tenant expansion. */
  flat?: boolean;
  /** spec-372 dec-8 — a subtle pulsing #0482DC dot nudging the user back to unfinished
   *  onboarding. Static under prefers-reduced-motion (motion-safe variant). */
  showDot?: boolean;
}) {
  // t-23 of doc-15: NAV_LINKS hold the in-tenant path shape (e.g. "/specs").
  // resolveNavTo() expands this to /<ns>/<mx>/specs — falling back to the
  // user's memex within the namespace when only `/<ns>/` is in the URL (the
  // NamespaceHome "pick a Memex" page), and to the default landing tenant on
  // fully flat routes. Active-state matching is done against the in-tenant
  // suffix of the current pathname so `/<ns>/<mx>/specs` still highlights
  // the Specs link.
  const { session } = useAuth();
  const resolvedTo = flat ? to : resolveNavTo(to, pathname, session?.memberships);
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
      {showDot && (
        <span
          data-testid="home-comeback-dot"
          aria-label="Unfinished onboarding"
          className="ml-1.5 h-2 w-2 flex-none rounded-full bg-[#0482DC] motion-safe:animate-pulse"
        />
      )}
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
    <header className="border-b flex-none flex items-stretch backdrop-blur-xs border-edge bg-page/80">
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

  // spec-360 / spec-389: pages that dock the in-app agent RAIL keep the sidebar
  // layout (they're not doc pages) but manage their OWN internal scroll — a
  // two-column surface whose chat panel scrolls independently. Unlike content-flow
  // pages (which scroll at the <main> level), they need a BOUNDED-height wrapper so
  // the rail's `h-full` resolves; without it the streaming chat expands the wrapper
  // and scrolls the whole page. The scaffold, standards-list, issues, and skills-list
  // surfaces all dock the rail (standards/:id and skills/:id are doc pages, handled
  // above — not here).
  const onScaffoldPage = !!useMatch('/:namespace/:memex/scaffold');
  const onStandardsListPage = !!useMatch('/:namespace/:memex/standards');
  const onIssuesPage = !!useMatch('/:namespace/:memex/issues');
  // spec-300 t-15 (dec-23): the Skills list docks the skills authoring agent rail.
  const onSkillsListPage = !!useMatch('/:namespace/:memex/skills');
  const onAgentRailPage = onScaffoldPage || onStandardsListPage || onIssuesPage || onSkillsListPage;
  // spec-410: the Drift Inbox is the odd one out — it's not a doc page (it keeps
  // the sidebar + drift badge), but it docks the agent via DocumentShell's
  // two-pane shell rather than a ResizableChatRail. Either way the bounding need
  // is identical: without a `min-h-0` wrapper DocumentShell's `h-full` can't
  // resolve, the shell grows to content height, and the whole <main> scrolls as
  // one unit — dragging the agent panel along with the drift rows. Bound it too.
  const onDriftPage = !!useMatch('/:namespace/:memex/drift');

  // Open standards drift count for the nav badge (b-63). Skipped on doc pages,
  // where the sidebar is hidden.
  const driftCount = useDriftInboxCount(!onDocPage);

  // spec-372 dec-8 — the "come back to onboarding" nudge: a pulsing dot on the Home nav
  // item, shown only while the onboarding journey is NOT graduated AND the user is off /home
  // (null = not yet known → no dot, avoiding a flash). Hidden once graduated or on /home.
  const journeyGraduated = useJourneyGraduated(!!user);
  const showComeBackDot = journeyGraduated === false && location.pathname !== '/home';
  // spec-158: my open issues (Specs assigned to me) for the Issues nav badge.
  // spec-305: the issues-list endpoint is tenant-scoped (/api/:ns/:mx/issues-list),
  // so only fetch on a tenant page — otherwise the badge 404s on flat user-level
  // surfaces like /home (now the landing page). No tenant ⇒ no count, no request.
  const myIssuesCount = useMyIssuesCount(!onDocPage && !!parseTenantFromPathname(location.pathname));
  // spec-260 (dec-6): per-user unread QA reports for the QA Reports nav badge —
  // reports generated since this user last viewed the feed, all executors.
  const qaReportsUnreadCount = useQaReportsUnreadCount(!onDocPage);

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
          {/* spec-303 — Home Canvas: the first, top-level, user-level destination.
              Gated on the server-driven hide list (feature: 'home') so it can be
              hidden per-env (e.g. prod) while live on int — same mechanism as Pulse. */}
          {!isLinkHidden(HOME_NAV_LINK.feature) && (
            <NavItem {...HOME_NAV_LINK} pathname={location.pathname} showDot={showComeBackDot} />
          )}

          {/* spec-260 t-11: two labelled groups — PRINCIPLES (the working
              surfaces) and IN-BOXES (the badge-carrying attention surfaces). */}
          <div className="pt-4 pb-1 px-3 text-xs font-medium uppercase tracking-wider text-muted">
            Principles
          </div>
          {PRINCIPLES_NAV_LINKS.filter((link) => !isLinkHidden(link.feature)).map((link) => (
            <NavItem key={link.to} {...link} pathname={location.pathname} />
          ))}

          <div className="pt-4 pb-1 px-3 text-xs font-medium uppercase tracking-wider text-muted">
            In-boxes
          </div>
          {INBOX_NAV_LINKS.filter((link) => !isLinkHidden(link.feature)).map((link) => (
            <NavItem
              key={link.to}
              {...link}
              pathname={location.pathname}
              // Every in-box carries its count: open drift (b-63), MY open
              // issues (spec-158, matches the page's Mine default), and unread
              // QA reports (spec-260 dec-6).
              badge={
                link.to === '/drift'
                  ? driftCount
                  : link.to === '/issues'
                    ? myIssuesCount
                    : link.to === '/qa-reports'
                      ? qaReportsUnreadCount
                      : undefined
              }
            />
          ))}
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

      <main className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {/* spec-171: seats over-limit warning shown to admins on all workspace pages */}
        <SeatsWarningBanner />
        {/* spec-360 / spec-389: an agent-rail page (scaffold, standards, issues)
            gets a bounded wrapper so its `h-full` resolves and the rail scrolls
            internally; content-flow pages keep the natural `flex-1` and scroll at
            the <main> level. spec-410: the Drift Inbox needs the same bounding —
            it docks the agent via DocumentShell's two-pane shell. */}
        <div className={onAgentRailPage || onDriftPage ? 'flex-1 min-h-0' : 'flex-1'}>
          {children}
        </div>
      </main>

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
