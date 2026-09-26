import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { fetchCurrentSubscription, type MembershipSummary, type SessionPayload } from '../../api/client';
import { parseTenantFromPathname } from '../../utils/tenantUrl';

// The membership the subscription request would address: the URL's tenant, or (on a page
// with no tenant in the URL) the session's current Memex, mirroring tenantBase().
function addressedMembership(
  session: SessionPayload | null,
  pathname: string,
): MembershipSummary | null {
  const memberships = session?.memberships ?? [];
  const tenant = parseTenantFromPathname(pathname);
  if (tenant) {
    return (
      memberships.find(
        (m) =>
          m.slug === tenant.namespace &&
          (m.memexSlug === tenant.memex || (!m.memexSlug && tenant.memex === 'main')),
      ) ?? null
    );
  }
  return memberships.find((m) => m.memexId === session?.currentMemexId && !!m.memexSlug) ?? null;
}

// GET orgs/current/subscription is org-scoped and admin-only. Asking anywhere else (a
// personal Memex has no org; a member or a public-Memex visitor is not an admin) is
// refused, and the refusal lands in the browser console on every page load.
function canReadSubscription(m: MembershipSummary | null): boolean {
  return (
    !!m &&
    m.kind === 'team' &&
    m.role === 'administrator' &&
    m.source !== 'visited' &&
    m.source !== 'featured'
  );
}

export function SeatsWarningBanner() {
  const { token, session } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [warning, setWarning] = useState<{ purchased: number; active: number } | null>(null);
  const allowed = canReadSubscription(addressedMembership(session, pathname));

  useEffect(() => {
    setWarning(null);
    if (!token || !allowed) return;
    let cancelled = false;
    fetchCurrentSubscription(token)
      .then((sub) => {
        if (!cancelled) setWarning(sub.seatsWarning);
      })
      .catch(() => { /* non-fatal */ });
    return () => {
      cancelled = true;
    };
  }, [token, allowed]);

  if (!warning) return null;

  return (
    <div className="px-4 py-2 bg-status-warning-bg border-b border-status-warning-border text-status-warning-text text-xs flex items-center justify-between gap-4">
      <span>
        Your org has <strong>{warning.active}</strong> active members but only{' '}
        <strong>{warning.purchased}</strong> seats purchased.
      </span>
      <button
        className="shrink-0 underline font-medium hover:no-underline"
        onClick={() => navigate('/org?tab=billing')}
      >
        Add seats →
      </button>
    </div>
  );
}
