import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getCurrentTenant, namespaceHomePath, tenantPathFor } from '../utils/tenantUrl';

// Top-right Memex switcher. Always rendered for authenticated users — the primary
// indicator of which Memex the user is currently in (GitHub-style). Dropdown
// contents:
//   - Personal Memex row (always present — your user namespace)
//   - "Your orgs" section (zero or more rows — Memexes in shared namespaces)
//   - "+ Create a new Memex" CTA
//
// `variant='sidebar'` renders a full-width trigger + below-aligned dropdown so it fits the
// left navigation drawer. Default `'topbar'` keeps the original compact button.
//
// t-23 of doc-15: switched from cross-origin `window.location.href` redirects
// (with auth-handoff fragments) to same-origin React Router navigation. Every
// tenant lives under `/<namespace>/<memex>/...` on a single origin, so we just
// navigate(). The default landing in the destination tenant is `/specs` —
// switching mid-doc abandons the doc deep-link because handles aren't
// guaranteed to exist in the target tenant.
export function MemexSwitcher({ variant = 'topbar' }: { variant?: 'topbar' | 'sidebar' } = {}) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // The header has `backdrop-blur-sm` which creates a containing block, so a
  // `fixed inset-0` backdrop ends up constrained to the header — clicks below
  // it never close the menu. Listen on document instead.
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

  const memberships = session?.memberships ?? [];
  const current = getCurrentTenant();
  const currentSlug = current?.namespace ?? null;
  const currentMemexSlug = current?.memex ?? null;
  const personalMembership = memberships.find((m) => m.kind === 'personal');
  // spec-111 t-8: split org memexes (full read+write) from VISITED public
  // memexes (source==='visited', read-only). Visited rows arrive as kind:'team'
  // from the server's user_memex_access join (t-6), so partition on `source`,
  // not `kind` — otherwise a visited public memex would masquerade as an org.
  const orgMemexes = memberships.filter(
    (m) => m.kind === 'team' && m.source !== 'visited',
  );
  const visitedMemexes = memberships.filter((m) => m.source === 'visited');

  // Identify the exact membership row the URL points at — match BOTH the
  // namespace and the memex slug, since an Org can hold multiple Memexes.
  const currentMembership = currentSlug
    ? memberships.find(
        (m) =>
          m.slug === currentSlug &&
          (m.memexSlug ?? null) === currentMemexSlug,
      ) ?? memberships.find((m) => m.slug === currentSlug)
    : null;
  const currentIsPersonal = currentMembership?.kind === 'personal';

  // Anonymous visitor (no session): the switcher (Personal / orgs) is
  // meaningless — AppShell renders Log in / Sign up in its place. Never show it,
  // so we don't fall through to the "Personal Memex" label for a signed-out user.
  if (!session) return null;
  // Hide when on a non-membership URL with no memberships at all.
  if (!current && memberships.length === 0) return null;

  // "Which Memex is the user looking at?" — show the Memex name (not the Org
  // name) so sibling Memexes inside the same Org look distinct.
  let currentLabel: string;
  if (!currentMembership) {
    currentLabel = personalMembership?.name ?? 'Personal Memex';
  } else if (currentMembership.kind === 'personal') {
    currentLabel = 'Personal Memex';
  } else {
    currentLabel = currentMembership.memexName ?? currentMembership.name;
  }

  function goToPersonal() {
    setOpen(false);
    if (!personalMembership) return;
    const ns = personalMembership.slug;
    const mx = personalMembership.memexSlug ?? 'personal';
    navigate(tenantPathFor(ns, mx, '/specs'));
  }

  function goToOrgMemex(m: { slug: string; memexSlug?: string }) {
    setOpen(false);
    const mx = m.memexSlug ?? 'main';
    if (m.slug === currentSlug && current?.memex === mx) return;
    navigate(tenantPathFor(m.slug, mx, '/specs'));
  }

  // Visited rows always carry a memexSlug (the server's join selects it), so no
  // 'main' fallback dance is needed — but keep one for parity/safety.
  function goToVisitedMemex(m: { slug: string; memexSlug?: string }) {
    setOpen(false);
    const mx = m.memexSlug ?? 'main';
    if (m.slug === currentSlug && current?.memex === mx) return;
    navigate(tenantPathFor(m.slug, mx, '/specs'));
  }

  // Group org memberships by namespace slug so sibling Memexes inside the same
  // Org render under one header (doc-19: an Org can hold 0..N Memexes).
  const orgsByNamespace = new Map<
    string,
    { name: string; role: 'member' | 'administrator'; memexes: typeof orgMemexes }
  >();
  for (const m of orgMemexes) {
    const existing = orgsByNamespace.get(m.slug);
    if (existing) {
      existing.memexes.push(m);
    } else {
      orgsByNamespace.set(m.slug, {
        name: m.name,
        role: m.role,
        memexes: [m],
      });
    }
  }

  const isSidebar = variant === 'sidebar';
  const triggerClass = isSidebar
    ? 'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors text-secondary hover:text-primary hover:bg-card-hover border border-edge'
    : 'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors text-secondary hover:text-primary hover:bg-card-hover border border-edge';
  const dropdownClass = isSidebar
    ? 'absolute left-0 right-0 top-full mt-1 z-40 rounded-lg shadow-xl py-1 border bg-card-hover border-edge'
    : 'absolute right-0 top-10 z-40 w-72 rounded-lg shadow-xl py-1 border bg-card-hover border-edge';
  const labelClass = isSidebar
    ? 'font-medium truncate flex-1 text-left'
    : 'font-medium truncate max-w-[10rem]';

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={triggerClass}
        title="Switch Memex"
      >
        {currentIsPersonal ? <PersonIcon /> : <OrgIcon />}
        <span className={labelClass}>{currentLabel}</span>
        {/* spec-111: the 🌐 Public badge moved OUT of the switcher (it crowded
            the Memex name) — it now sits after the breadcrumb in PageHeader. */}
        <svg className="w-3 h-3 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className={dropdownClass}>
            {/* Always render the personal row — every user has exactly one personal memex
                by invariant. Showing it even when the cached session is momentarily stale
                keeps the dropdown from looking empty on first load after hotfixes. */}
            <div className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wider text-muted">
              Your personal Memex
            </div>
            <SwitcherRow
              title="Personal Memex"
              subtitle={session?.user.email ?? ''}
              active={!!currentIsPersonal}
              onClick={goToPersonal}
            />

            {orgsByNamespace.size > 0 && (
              <>
                <div className="mt-1 px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wider text-muted border-t border-edge">
                  Your orgs
                </div>
                {Array.from(orgsByNamespace.entries()).map(([nsSlug, group]) => {
                  const isCurrentOrg = currentSlug === nsSlug;
                  return (
                    <div key={nsSlug} className="pb-1">
                      <div className="px-3 pt-2 pb-0.5">
                        <div className="text-sm font-medium text-secondary break-words leading-snug">
                          {group.name}
                        </div>
                        <div className="text-xs text-muted break-words leading-snug">
                          {group.role}
                        </div>
                      </div>
                      {group.memexes.map((mx) => {
                        const mxSlug = mx.memexSlug ?? 'main';
                        const active =
                          isCurrentOrg && current?.memex === mxSlug;
                        return (
                          <SwitcherRow
                            key={mx.memexId}
                            title={mx.memexName ?? mx.name}
                            active={active}
                            onClick={() => goToOrgMemex(mx)}
                            indent
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </>
            )}

            {visitedMemexes.length > 0 && (
              <>
                <div
                  className="mt-1 px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wider text-muted border-t border-edge flex items-center gap-1.5"
                  data-testid="visited-memexes-header"
                >
                  <span aria-hidden="true">🌐</span>
                  <span>Visited</span>
                </div>
                {visitedMemexes.map((mx) => {
                  const mxSlug = mx.memexSlug ?? 'main';
                  const active = currentSlug === mx.slug && current?.memex === mxSlug;
                  return (
                    <SwitcherRow
                      key={mx.memexId}
                      title={mx.memexName ?? mx.name}
                      subtitle="Read-only"
                      active={active}
                      onClick={() => goToVisitedMemex(mx)}
                      indent
                    />
                  );
                })}
              </>
            )}

            <div className="border-t border-edge mt-1" />
            <button
              onClick={() => {
                setOpen(false);
                // Prefer the current namespace if it's a team org, otherwise
                // the first team-org namespace. With no orgs at all, route to
                // the personal namespace home — it renders the "Create an
                // Org →" CTA.
                const target =
                  currentMembership?.kind === 'team' && currentSlug
                    ? namespaceHomePath(currentSlug)
                    : orgMemexes[0]
                    ? namespaceHomePath(orgMemexes[0].slug)
                    : personalMembership
                    ? namespaceHomePath(personalMembership.slug)
                    : '/';
                navigate(target);
              }}
              className="w-full text-left px-3 py-2 text-sm transition-colors text-secondary hover:text-primary hover:bg-overlay"
            >
              Manage Orgs
            </button>
        </div>
      )}
    </div>
  );
}

function SwitcherRow({
  title,
  subtitle,
  active,
  onClick,
  indent = false,
}: {
  title: string;
  subtitle?: string;
  active: boolean;
  onClick: () => void;
  indent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full ${indent ? 'pl-6 pr-3' : 'px-3'} py-1.5 text-sm transition-colors text-left ${
        active
          ? 'bg-overlay text-primary font-semibold cursor-default'
          : 'text-secondary hover:text-primary hover:bg-overlay'
      }`}
    >
      <span className="block break-words leading-snug">{title}</span>
      {subtitle && (
        <span className="block text-xs text-muted break-words leading-snug">{subtitle}</span>
      )}
    </button>
  );
}

function PersonIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  );
}

function OrgIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 21V7a2 2 0 012-2h4a2 2 0 012 2v14M11 21V11a2 2 0 012-2h6a2 2 0 012 2v10M7 9h.01M7 13h.01M7 17h.01M15 13h.01M15 17h.01" />
    </svg>
  );
}

