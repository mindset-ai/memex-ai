import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { MemexPublicBadge } from './MemexPublicBadge';
import { useAnonymousPublicMemex } from './PublicMemexContext';
import { getCurrentTenant, namespaceHomePath, tenantPathFor } from '../utils/tenantUrl';

// Breadcrumb-style page header used on every tenancy-scoped page. The pattern
// is:
//
//   <Org name> / <Memex name> / <Page>
//
// for org Memexes, and
//
//   Personal Memex / <Page>
//
// for personal Memexes. The first two segments link back to their respective
// home pages so users can navigate up the hierarchy.
//
// Pages that have action buttons (e.g. SpecList's "+ New Spec") pass them
// via `actions` so the layout stays one row.
export interface PageHeaderProps {
  title: string;
  actions?: ReactNode;
}

export function PageHeader({ title, actions }: PageHeaderProps) {
  const { session } = useAuth();
  const tenant = getCurrentTenant();
  const memberships = session?.memberships ?? [];

  const currentMembership = tenant
    ? memberships.find(
        (m) =>
          m.slug === tenant.namespace &&
          (m.memexSlug ?? null) === tenant.memex,
      )
    : null;

  // An anonymous visitor on a public Memex has no membership row — TenantLayout
  // provides the probed Memex (name + visibility) via context so the breadcrumb
  // and the 🌐 badge still render.
  const publicMemex = useAnonymousPublicMemex();

  const isPersonal = currentMembership?.kind === 'personal';
  const orgName = isPersonal
    ? null
    : currentMembership?.name ?? tenant?.namespace ?? null;
  const memexName = currentMembership
    ? currentMembership.memexName ?? currentMembership.name
    : publicMemex?.name ?? null;
  const visibility = currentMembership?.visibility ?? publicMemex?.visibility;

  return (
    <div className="flex items-center justify-between mb-6 flex-none gap-4">
      <div className="min-w-0 flex-1">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-2 text-xs text-muted mb-1 truncate"
        >
          {isPersonal ? (
            <BreadcrumbLink to={namespaceHomePath(tenant!.namespace)}>
              Personal Memex
            </BreadcrumbLink>
          ) : (
            <>
              {tenant && orgName && (
                <BreadcrumbLink to={namespaceHomePath(tenant.namespace)}>
                  {orgName}
                </BreadcrumbLink>
              )}
              {tenant && memexName && (
                <>
                  <BreadcrumbDivider />
                  <BreadcrumbLink
                    to={tenantPathFor(tenant.namespace, tenant.memex, '/specs')}
                  >
                    {memexName}
                  </BreadcrumbLink>
                </>
              )}
            </>
          )}
          {/* spec-111: the 🌐 Public badge lives AFTER the breadcrumb (not in the
              Memex switcher, where it crowded the name). Self-suppresses for
              private memexes. */}
          <MemexPublicBadge visibility={visibility} className="flex-none ml-1" />
        </nav>
        <h1 className="text-2xl font-semibold text-heading truncate">{title}</h1>
      </div>
      {actions && <div className="flex items-center gap-4 flex-none">{actions}</div>}
    </div>
  );
}

function BreadcrumbLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="hover:text-primary transition-colors truncate max-w-[12rem]"
    >
      {children}
    </Link>
  );
}

function BreadcrumbDivider() {
  return <span aria-hidden="true">/</span>;
}
